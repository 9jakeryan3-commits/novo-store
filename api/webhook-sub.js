const Stripe = require('stripe');
const { Resend } = require('resend');
const { claimOnce } = require('./_kv');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const LICENSE_SERVER = (process.env.NOVO_LICENSE_SERVER_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY;
const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';

// Stripe moved the invoice's subscription id to invoice.parent.subscription_details.subscription
// in its 2025 API versions; older versions use the top-level invoice.subscription. Read whichever
// is present so suspend-on-failure / reactivate-on-payment always fire regardless of API version.
function invoiceSubId(inv) {
  return inv?.subscription || inv?.parent?.subscription_details?.subscription || null;
}

async function licensePost(path, body) {
  const res = await fetch(`${LICENSE_SERVER}${path}`, {
    method: 'POST',
    headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`License server ${path} → ${res.status}`);
  return res.json();
}

async function activateSub(subscriptionId) {
  return licensePost(`/admin/subscription/${subscriptionId}/activate`, {});
}

async function suspendSub(subscriptionId) {
  return licensePost(`/admin/subscription/${subscriptionId}/suspend`, {});
}

async function cancelSub(subscriptionId) {
  return licensePost(`/admin/subscription/${subscriptionId}/cancel`, {});
}

// ── NoVo Analyst ($69 email tier) — routed by subscription metadata.tier==='analyst'. These subs have NO
// license/instance; they only add/remove the email on the Analyst Resend audience. ─────────────────────
const ANALYST_AUDIENCE = process.env.RESEND_ANALYST_AUDIENCE_ID;
const FREE_AUDIENCE = process.env.RESEND_AUDIENCE_ID;   // the free "Market Notes" list — kept DISJOINT from Analyst
const DISCORD_GUILD = process.env.DISCORD_GUILD_ID || '1522967079400112198';
const DISCORD_ROLE = process.env.DISCORD_ROLE_ID || '1522999999565398047';
async function discordRevokeRole(discordId) {
  if (!discordId || !process.env.DISCORD_BOT_TOKEN) return;
  try {
    await fetch(`https://discord.com/api/guilds/${DISCORD_GUILD}/members/${discordId}/roles/${DISCORD_ROLE}`,
      { method: 'DELETE', headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } });
  } catch (e) { console.error(`[webhook-sub] discord role revoke failed: ${e.message}`); }
}
async function isAnalystSub(subscriptionId) {
  try { const s = await stripe.subscriptions.retrieve(subscriptionId); return s?.metadata?.tier === 'analyst'; }
  catch { return false; }
}
// Small retry so a single transient Resend blip doesn't leave an audience move half-done (e.g. removed from
// Analyst but never re-added to the free list on cancel → subscriber silently on NEITHER list).
async function _retry(fn, n = 2) {
  for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; } }
}
// Returns {added, existed}: `existed` is true only when Resend reports the contact is ALREADY on the list
// (a Stripe retry / re-processed event) — the welcome-email gate uses that to skip genuine duplicates while
// still sending on a first-time-but-flaky add, so a transient error never silently swallows the welcome.
async function analystAdd(email) {
  if (!ANALYST_AUDIENCE || !email) return { added: false, existed: false };
  try { await resend.contacts.create({ audienceId: ANALYST_AUDIENCE, email, unsubscribed: false }); return { added: true, existed: false }; }
  catch (e) {
    const existed = /exist|already|duplicat|conflict/i.test(String(e?.message || ''));
    if (!existed) console.error(`[webhook-sub] analyst add failed: ${e.message}`);
    return { added: false, existed };
  }
}
async function analystRemove(email) {
  if (!ANALYST_AUDIENCE || !email) return;
  try { await _retry(() => resend.contacts.remove({ audienceId: ANALYST_AUDIENCE, email }), 2); }
  catch (e) { console.error(`[webhook-sub] analyst remove failed after retries: ${e.message}`); }
}
// The free + Analyst lists are kept DISJOINT so no one gets the 'both' broadcasts (Weekly, articles) twice. A paid
// sub lives ONLY on the Analyst list; on upgrade we pull them off the free list, on a real cancel we add them back.
async function freeRemove(email) {
  if (!FREE_AUDIENCE || !email) return;
  try { await _retry(() => resend.contacts.remove({ audienceId: FREE_AUDIENCE, email }), 2); }
  catch (e) { console.error(`[webhook-sub] free-list remove failed after retries: ${e.message}`); }
}
async function freeAdd(email) {
  if (!FREE_AUDIENCE || !email) return;
  try { await _retry(() => resend.contacts.create({ audienceId: FREE_AUDIENCE, email, unsubscribed: false }), 2); }
  catch (e) { console.error(`[webhook-sub] free-list add failed after retries: ${e.message}`); }
}
// True if this EMAIL still has ANY OTHER active paid sub (Analyst or Trader). Stripe mints a separate customer
// per checkout, so a dual-tier user's subs live on different customer objects that share one email — checking
// only obj.customer would miss the other sub. Prevents cancelling one paid sub from stripping entitlements the
// user still pays for via another (e.g. cancel a redundant Analyst sub while an active Trader sub still includes it).
async function hasOtherActivePaidSub(email, excludeSubId) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return false;
  const hasSub = async (custId) => {
    const subs = await stripe.subscriptions.list({ customer: custId, status: 'all', limit: 20 });
    return subs.data.some(s => s.id !== excludeSubId && ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status));
  };
  try {
    // customers.list({email}) is a case-SENSITIVE exact match, so a dual-tier user who checked out with different
    // email casing would be missed and wrongly stripped of entitlements. Stripe Search's email index is
    // case-insensitive — use it as primary, with list() as a fallback (mirrors _activePaidSub in analyst-publish.js).
    const seen = new Set();
    try {
      const sr = await stripe.customers.search({ query: `email:"${norm.replace(/"/g, '')}"`, limit: 20 });
      for (const c of sr.data) { seen.add(c.id); if (await hasSub(c.id)) return true; }
    } catch (_) { /* search index warming up / unavailable — fall through to list() */ }
    const custs = await stripe.customers.list({ email: norm, limit: 100 });
    for (const c of custs.data) { if (!seen.has(c.id) && await hasSub(c.id)) return true; }
  } catch (e) { console.error(`[webhook-sub] other-active-sub check failed: ${e.message}`); }
  return false;
}
// Trader INCLUDES Analyst, so holding both bills $79 + $199 for ONE entitlement. On a Trader checkout, retire
// any Analyst subscription this email still holds. Stripe mints a SEPARATE customer per checkout, so an
// upgrader's Analyst sub usually sits on a DIFFERENT customer object that merely shares the email — hence the
// search()+list() sweep (same shape as hasOtherActivePaidSub).
//   trialing -> cancel NOW (never charged; nothing to preserve)
//   active   -> cancel_at_period_end (they already paid for this period — let it run out, just don't renew)
// Deliberately NOT an immediate prorated refund: that credit lands on the OTHER customer object and the Trader
// subscription could never spend it. Non-fatal by design — onboarding must not fail on a Stripe hiccup.
async function retireAnalystOnTraderUpgrade(email, newTraderSubId) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return [];
  const done = [];
  const sweep = async (custId) => {
    const subs = await stripe.subscriptions.list({ customer: custId, status: 'all', limit: 20 });
    for (const s of subs.data) {
      if (s.id === newTraderSubId) continue;                 // never touch the sub we just created
      if (s.metadata?.tier !== 'analyst') continue;          // Trader subs carry no tier metadata
      if (!['active', 'trialing', 'past_due', 'unpaid'].includes(s.status)) continue;
      if (s.cancel_at_period_end) { done.push(`${s.id}:already-ending`); continue; }   // idempotent on retry
      try {
        if (s.status === 'trialing') {
          await stripe.subscriptions.cancel(s.id);
          done.push(`${s.id}:cancelled-now`);
        } else {
          await stripe.subscriptions.update(s.id, { cancel_at_period_end: true });
          done.push(`${s.id}:ends-at-period-end`);
        }
      } catch (e) { console.error(`[webhook-sub] could not retire analyst sub ${s.id}: ${e.message}`); }
    }
  };
  try {
    const seen = new Set();
    try {
      const sr = await stripe.customers.search({ query: `email:"${norm.replace(/"/g, '')}"`, limit: 20 });
      for (const c of sr.data) { seen.add(c.id); await sweep(c.id); }
    } catch (_) { /* search index warming up — fall through to list() */ }
    const custs = await stripe.customers.list({ email: norm, limit: 100 });
    for (const c of custs.data) { if (!seen.has(c.id)) await sweep(c.id); }
  } catch (e) { console.error(`[webhook-sub] analyst-retire sweep failed: ${e.message}`); }
  return done;
}
// True if this email already holds a live TRADER subscription. Mirror image of the upgrade case: Trader
// includes Analyst, so someone on Trader buying Analyst is paying twice for one entitlement. Trader subs carry
// NO tier metadata (only checkout-analyst.js sets tier:'analyst'), so "live and not analyst" == Trader.
// Same multi-customer sweep as above — Stripe mints a customer per checkout, so the Trader sub is very likely
// on a different customer object sharing the email.
async function hasActiveTraderSub(email, excludeSubId) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return false;
  const LIVE = ['active', 'trialing', 'past_due', 'unpaid'];
  const hit = async (custId) => {
    const subs = await stripe.subscriptions.list({ customer: custId, status: 'all', limit: 20 });
    return subs.data.some(s => s.id !== excludeSubId && s.metadata?.tier !== 'analyst' && LIVE.includes(s.status));
  };
  try {
    const seen = new Set();
    try {
      const sr = await stripe.customers.search({ query: `email:"${norm.replace(/"/g, '')}"`, limit: 20 });
      for (const c of sr.data) { seen.add(c.id); if (await hit(c.id)) return true; }
    } catch (_) { /* search index warming up — fall through to list() */ }
    const custs = await stripe.customers.list({ email: norm, limit: 100 });
    for (const c of custs.data) { if (!seen.has(c.id) && await hit(c.id)) return true; }
  } catch (e) { console.error(`[webhook-sub] trader-sub check failed: ${e.message}`); }
  return false;
}
function analystWelcomeHtml(connectUrl) {
  return `<div style="margin:0;padding:0;background:#101013;">
  <div style="max-width:560px;margin:0 auto;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#17181b;border:1px solid #2e3036;border-bottom:0;border-radius:12px 12px 0 0;padding:22px 24px;text-align:center;">
      <img src="https://novo-aitrading.app/novo-logo-light.png?v=1" alt="NoVo AI Trading" height="30" style="height:30px;width:auto;display:inline-block;border:0;">
      <div style="margin-top:9px;font-size:10.5px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22d3ee;">NoVo Analyst</div>
    </div>
    <div style="background:#1c1d21;border:1px solid #2e3036;border-top:0;border-radius:0 0 12px 12px;padding:30px 30px 26px;">
      <h1 style="color:#eaf3ff;font-size:22px;font-weight:800;margin:0 0 14px;letter-spacing:-.3px;">You're in &mdash; NoVo Analyst is live.</h1>
      <p style="color:#c2d2e6;line-height:1.65;font-size:15px;margin:0 0 14px;">You'll now get NoVo's market reads by email &mdash; <b style="color:#eaf3ff">The Open</b> and <b style="color:#eaf3ff">The Close</b> each session, plus the <b style="color:#eaf3ff">Week Ahead</b> on Sundays. And in the members-only <b style="color:#eaf3ff">Analyst Discord</b>: real-time <b style="color:#eaf3ff">&lsquo;The Line&rsquo;</b> alerts the moment a major level breaks or dealers flip the <b style="color:#eaf3ff">gamma regime</b> from absorbing to amplifying &mdash; link your Discord below to unlock them. Every read carries the <b style="color:#eaf3ff">actual levels</b> &mdash; real support, resistance, and structure &mdash; not vague prose. The same dealer-flow read the machine runs on, in plain language. No hype, no signals.</p>
      <p style="color:#c2d2e6;line-height:1.65;font-size:15px;margin:0 0 14px;">Your first read arrives with the next market session.</p>
      <div style="margin:18px 0 6px;border:1px solid #2e3036;border-left:3px solid #22d3ee;border-radius:8px;padding:16px 18px;background:rgba(34,211,238,0.07);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Your live dashboard</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;margin-bottom:12px;">Watch the dealer map update through the session &mdash; the live <b style="color:#eaf3ff">SPY / QQQ / SPX</b> chart with dealer levels, net GEX, Zero-Gamma, walls, expected move &amp; skew, plus the &lsquo;The Line&rsquo; feed. Install it as an app and turn on push alerts.</div>
        <a href="https://novo-aitrading.app/analyst/live" style="display:inline-block;background:linear-gradient(180deg,#22d3ee,#3b82f6);color:#04121a;font-weight:800;font-size:13.5px;padding:11px 22px;border-radius:8px;text-decoration:none;">Open your live dashboard &rarr;</a>
        <div style="font-size:12px;color:#6f8bab;line-height:1.5;margin-top:12px;">Sign in with this email &mdash; we'll send a one-tap link.</div>
      </div>
      ${connectUrl ? `<div style="margin:18px 0 6px;border:1px solid #3a3c42;border-left:3px solid #5865F2;border-radius:8px;padding:16px 18px;background:rgba(88,101,242,0.08);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Prefer Discord?</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;margin-bottom:12px;">Get every read and alert in the members-only Analyst channels. Link your Discord account to unlock them.</div>
        <a href="${connectUrl}" style="display:inline-block;background:#5865F2;color:#ffffff;font-weight:800;font-size:13.5px;padding:11px 22px;border-radius:8px;text-decoration:none;">Connect your Discord &rarr;</a>
        <div style="font-size:12px;color:#6f8bab;line-height:1.5;margin-top:12px;">Want Discord only? Once it's linked, just hit <b style="color:#9fb6d1;">unsubscribe</b> on any email &mdash; your reads keep flowing in the private channels, and your subscription stays active.</div>
      </div>` : ''}
      <div style="margin-top:22px;border:1px solid #2e3036;border-left:3px solid #10b981;border-radius:8px;padding:16px 18px;background:rgba(16,185,129,0.06);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Want it raw &amp; live?</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;">This is the read. <b style="color:#eaf3ff">NoVo Trader</b> executes it live in your own broker account, within your rules &mdash; non-custodial. <a href="https://novo-aitrading.app" style="color:#34d399;font-weight:700;text-decoration:none;">See NoVo Trader &rarr;</a></div>
      </div>
      <div style="margin-top:22px;border:1px solid #2e3036;border-left:3px solid #22d3ee;border-radius:8px;padding:16px 18px;background:rgba(34,211,238,0.06);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Don't need these in your inbox?</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;">Every read is live in your <b style="color:#22d3ee">dealer dashboard</b> and the <b style="color:#7f8cff">Analyst Discord</b> &mdash; email is just a backup for when you're away from them. To stop the emails, click <b style="color:#eaf3ff">Unsubscribe</b> at the bottom of any read. Your subscription, dashboard, and Discord access stay exactly the same.</div>
      </div>
      <p style="font-size:11.5px;color:#6f8bab;line-height:1.6;margin:20px 0 0;">Market analysis &amp; education only &mdash; not financial advice, not trade signals. Trading involves substantial risk of loss. Manage or cancel anytime via the billing link in your Stripe receipts.</p>
    </div>
  </div>
</div>`;
}

function welcomeEmailHtml(connectUrl) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#101013;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:30px 16px;">
  <div style="background:#1c1d21;border:1px solid #2e3036;border-radius:14px;padding:34px 32px;">
    <div style="text-align:center;">
      <img src="https://novo-aitrading.app/novo-logo-light.png?v=1" alt="NoVo" width="118" style="width:118px;height:auto;display:inline-block;border:0;">
      <div style="font-size:11px;letter-spacing:3px;color:#10b981;text-transform:uppercase;font-weight:700;margin:10px 0 24px;">NoVo Trader &mdash; One-Click Execution</div>
    </div>

    <h1 style="color:#eaf3ff;font-size:22px;margin:0 0 10px;">Welcome to NoVo Trader &mdash; you're all set.</h1>
    <p style="color:#c2d2e6;font-size:15px;line-height:1.6;margin:0 0 22px;">Your subscription is active. Head to your portal to finish setup and open your dashboard &mdash; you'll be up and running in minutes.</p>

    <div style="text-align:center;margin:0 0 26px;">
      <a href="https://app.novo-aitrading.app" style="display:inline-block;background:#10b981;color:#04121a;text-decoration:none;padding:14px 34px;border-radius:8px;font-weight:800;font-size:15px;">Open Your Portal</a>
    </div>

    ${connectUrl ? `<div style="background:rgba(88,101,242,0.08);border:1px solid #3a3c42;border-left:3px solid #5865F2;border-radius:10px;padding:16px 18px;margin:0 0 24px;text-align:center;">
      <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:6px;">Join the members Discord</div>
      <div style="font-size:13px;color:#9fb6d1;line-height:1.5;margin-bottom:12px;">Your subscription includes the private NoVo Discord &mdash; the daily reads, alerts, and the members community. Link your account to unlock it.</div>
      <a href="${connectUrl}" style="display:inline-block;background:#5865F2;color:#ffffff;text-decoration:none;padding:11px 24px;border-radius:8px;font-weight:700;font-size:14px;">Connect your Discord &rarr;</a>
    </div>` : ''}

    <div style="background:rgba(6,182,212,0.07);border:1px solid #2e3036;border-left:3px solid #06b6d4;border-radius:10px;padding:16px 18px;margin:0 0 24px;">
      <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:6px;">Included: the NoVo Analyst live dashboard</div>
      <div style="font-size:13px;color:#9fb6d1;line-height:1.55;margin-bottom:12px;">Your Trader subscription also includes <strong style="color:#eaf3ff;">NoVo Analyst</strong> &mdash; the daily desk notes and the <strong style="color:#eaf3ff;">live SPY / QQQ / SPX dealer dashboard</strong> (net GEX, walls, Zero-Gamma, expected move &amp; skew, updating through the session). Sign in with this email.</div>
      <a href="https://novo-aitrading.app/analyst/live" style="display:inline-block;background:#06b6d4;color:#04121a;text-decoration:none;padding:11px 24px;border-radius:8px;font-weight:800;font-size:14px;">Open the live dashboard &rarr;</a>
    </div>

    <div style="border-top:1px solid #2e3036;margin:0 0 20px;"></div>
    <h2 style="color:#eaf3ff;font-size:16px;margin:0 0 14px;">Getting started</h2>
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
      <tr><td style="vertical-align:top;padding:0 12px 14px 0;width:22px;"><div style="background:#10b981;color:#04121a;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;">1</div></td>
          <td style="vertical-align:top;padding-bottom:14px;color:#c2d2e6;font-size:14px;line-height:1.55;">Go to <strong style="color:#eaf3ff;">app.novo-aitrading.app</strong> and create your account using <strong style="color:#eaf3ff;">this email address</strong>.</td></tr>
      <tr><td style="vertical-align:top;padding:0 12px 14px 0;"><div style="background:#10b981;color:#04121a;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;">2</div></td>
          <td style="vertical-align:top;padding-bottom:14px;color:#c2d2e6;font-size:14px;line-height:1.55;">Connect your <strong style="color:#eaf3ff;">Tradier + Alpaca</strong> keys &mdash; validated against the brokers.</td></tr>
      <tr><td style="vertical-align:top;padding:0 12px 14px 0;"><div style="background:#10b981;color:#04121a;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;">3</div></td>
          <td style="vertical-align:top;padding-bottom:14px;color:#c2d2e6;font-size:14px;line-height:1.55;">Your private dashboard goes live automatically &mdash; AI pre-configured, <strong style="color:#eaf3ff;">paper trading immediately</strong>.</td></tr>
      <tr><td style="vertical-align:top;padding:0 12px 0 0;"><div style="background:#10b981;color:#04121a;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;">4</div></td>
          <td style="vertical-align:top;color:#c2d2e6;font-size:14px;line-height:1.55;">Open it in any browser, or install it as an app on your desktop or phone.</td></tr>
    </table>

    <p style="color:#c2d2e6;font-size:14px;line-height:1.6;margin:22px 0 0;">Start in paper mode (the default) and watch it run before switching to live.</p>

    <div style="background:rgba(245,158,11,0.08);border:1px solid #3a3c42;border-left:3px solid #f59e0b;border-radius:8px;padding:14px 18px;margin:22px 0 0;font-size:13px;color:#e8c48f;line-height:1.6;">
      <strong style="color:#f59e0b;">Auto-renewing:</strong> Your subscription renews automatically (monthly or yearly, whichever you chose). Manage billing or cancel any time from your portal at <a href="https://app.novo-aitrading.app" style="color:#22d3ee;">app.novo-aitrading.app</a>.
    </div>

    <p style="color:#c2d2e6;font-size:14px;margin:18px 0 0;">Questions? Just reply, or email <a href="mailto:support@novo-aitrading.app" style="color:#22d3ee;">support@novo-aitrading.app</a>.</p>

    <div style="background:rgba(34,211,238,0.06);border:1px solid #2e3036;border-left:3px solid #22d3ee;border-radius:10px;padding:16px 18px;margin:22px 0 0;">
      <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:6px;">Don't need email?</div>
      <div style="font-size:13px;color:#9fb6d1;line-height:1.55;">Everything NoVo emails you is live in your <strong style="color:#eaf3ff;">dashboard</strong> and the <strong style="color:#eaf3ff;">Discord</strong> &mdash; email is just a backup for when you're away. To stop the emails, click <strong style="color:#eaf3ff;">Unsubscribe</strong> at the bottom of any read. Your subscription, dashboard, and Discord access stay exactly the same.</div>
    </div>

    <div style="border-top:1px solid #2e3036;margin-top:24px;padding-top:16px;">
      <p style="font-size:12px;color:#6f8bab;margin:0;line-height:1.5;">Not financial advice. Trading involves substantial risk of loss. Your access is active while your subscription is current.</p>
    </div>
  </div>
</div>
</body>
</html>`;
}

// Stripe signature verification needs the EXACT raw bytes. req.body may arrive as a
// Buffer, a string, or (with bodyParser:false honored) be absent with the stream still
// readable — resolve all three so verification works regardless of Vercel's delivery.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function rawBodyOf(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  return await readRawBody(req);
}

const handler = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const rawBody = await rawBodyOf(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_SUB_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // Idempotency (launch audit): Stripe retries any non-2xx and can redeliver on its own schedule. Every side
  // effect below (Resend audience add/remove, license activate/suspend/cancel, welcome emails) must run at
  // most once per event. Claim the event id in shared KV; a duplicate delivery acks 200 without re-running.
  // Fails OPEN (no KV configured → proceeds) so it never blocks a genuine first delivery. (audit gap #6 / #11)
  if (event.id && !(await claimOnce('stripe_evt:sub:' + event.id, 259200))) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  const obj = event.data.object;

  // ── New subscription checkout completed ───────────────────────────────────
  if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
    const email = obj?.customer_details?.email;
    if (!email) {
      console.error(`[webhook-sub] Missing email — session:${obj.id}`);
      return res.status(200).json({ received: true });
    }

    // NoVo Analyst ($69 email tier): add to the Analyst audience + send its welcome, then STOP — no license,
    // no portal, no provisioning.
    if (obj?.metadata?.tier === 'analyst') {
      // REVERSE-DUPLICATE GUARD: they already hold Trader, which INCLUDES Analyst. Left alone this bills
      // $199 + $79 for one entitlement. Analyst opens on a 7-day trial, so cancelling here almost always
      // means they are never charged at all. Non-fatal: a failure must not block the normal Analyst flow.
      try {
        const already = await hasActiveTraderSub(email, obj.subscription);
        if (already) {
          let charged = true;
          try {
            const sub = await stripe.subscriptions.retrieve(obj.subscription);
            charged = sub.status !== 'trialing';                 // trialing => no money moved
            await stripe.subscriptions.cancel(obj.subscription);
          } catch (e) { console.error(`[webhook-sub] dupe-analyst cancel failed: ${e.message}`); }
          console.log(`[webhook-sub] duplicate Analyst purchase by active Trader sub ${email} — cancelled ${obj.subscription} (charged=${charged})`);
          try {
            await resend.emails.send({
              from: 'NoVo <orders@novo-aitrading.app>',
              replyTo: 'support@novo-aitrading.app', to: [email],
              subject: 'You already have NoVo Analyst — duplicate subscription cancelled',
              html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#1c1d21;color:#c2d2e6;padding:28px;border:1px solid #2e3036;border-radius:12px;line-height:1.65;">
                <h2 style="color:#eaf3ff;font-size:19px;margin:0 0 12px;">No charge — you already have this</h2>
                <p style="margin:0 0 12px;">Your <strong style="color:#eaf3ff;">NoVo Trader</strong> subscription already includes everything in <strong style="color:#eaf3ff;">NoVo Analyst</strong> — the live dealer dashboard, the daily Open and Close desk notes, and the Sunday Week Ahead.</p>
                <p style="margin:0 0 12px;">So we cancelled the duplicate Analyst subscription you just started${charged ? '' : ' before it charged you'}. Nothing changes about your Trader access.</p>
                <p style="margin:0 0 12px;">${charged ? 'If your card was charged for it, just reply to this email and we will refund it.' : 'You were not charged.'}</p>
                <p style="margin:0;font-size:13px;color:#8aacc8;">Questions? <a href="mailto:support@novo-aitrading.app" style="color:#34d399;">support@novo-aitrading.app</a></p></div>`,
            });
          } catch (e) { console.error(`[webhook-sub] dupe-analyst notice failed: ${e.message}`); }
          return res.status(200).json({ received: true, duplicate_tier: true });
        }
      } catch (e) { console.error(`[webhook-sub] reverse-dupe guard failed (non-fatal): ${e.message}`); }

      const _r = await analystAdd(email);
      await freeRemove(email);   // paid now → off the free list (Weekly + articles reach them via the Analyst broadcasts)
      if (!_r.existed) {         // skip re-welcoming on a Stripe retry of the same event (they were already added)
        try {
          await resend.emails.send({
            from: 'The NoVo Journal <orders@novo-aitrading.app>',   // hardcoded verified domain — a bad FROM_EMAIL env 403s + silently kills sends
            replyTo: 'support@novo-aitrading.app', to: [email],
            subject: 'Welcome to NoVo Analyst', html: analystWelcomeHtml(`${SITE}/api/discord?cs=${obj.id}`),
          });
        } catch (err) { console.error(`[webhook-sub] analyst welcome failed (non-fatal): ${err.message}`); }
      }
      return res.status(200).json({ received: true });
    }

    // Trader INCLUDES Analyst — add the Trader subscriber to the Analyst email audience too, so they receive
    // the Open / Close / Week Ahead reads + intraday alerts. (Their paid-Discord role is granted on connect
    // via /api/discord, which already accepts any paid sub — Analyst OR Trader.)
    await analystAdd(email);
    await freeRemove(email);   // paid now → off the free list (Weekly + articles reach them via the Analyst broadcasts)

    // UPGRADE PATH: retire any Analyst sub this email holds. Trader includes Analyst, so leaving it running
    // billed the customer $79 + $199 = $278/mo for one entitlement. Non-fatal.
    try {
      const retired = await retireAnalystOnTraderUpgrade(email, obj.subscription);
      if (retired.length) console.log(`[webhook-sub] trader upgrade — retired analyst sub(s): ${retired.join(', ')}`);
    } catch (e) { console.error(`[webhook-sub] analyst retire failed (non-fatal): ${e.message}`); }

    // Hosted model: no license key, no download. The control plane recognizes the subscription by the
    // customer's email (Stripe is the source of truth); this email just welcomes them to the portal.
    // Do NOT gate this welcome on Analyst-audience membership: an Analyst subscriber who UPGRADES to Trader is
    // already on that audience, so the old `if (_rt.existed) return` silently skipped the ONLY email carrying
    // the portal link + Tradier/Alpaca setup steps — breaking their activation. Always send it. (True Stripe
    // retry idempotency needs a persistent event-id store the serverless doesn't have yet; the handler acks 200
    // on success AND on Resend failure, so genuine retries are rare — a duplicate welcome beats no onboarding.) (audit #11)
    try {
      await resend.emails.send({
        from: 'NoVo <orders@novo-aitrading.app>',   // hardcoded verified domain — a bad FROM_EMAIL env 403s + silently kills sends
        replyTo: 'support@novo-aitrading.app',
        to: [email],
        subject: 'Welcome to NoVo Trader — open your portal',
        html: welcomeEmailHtml(`${SITE}/api/discord?cs=${obj.id}`),
      });
    } catch (err) {
      // Don't 500 here: a 500 makes Stripe retry the whole webhook (re-attempting the email) in a loop.
      // The subscription is already active and subscribe-success.html shows the portal link + next steps,
      // so a Resend blip never blocks onboarding. Log and fall through to the 200 ack below.
      console.error(`[webhook-sub] Welcome email failed (non-fatal, acking) — error:${err.message}`);
    }
  }

  // ── Monthly renewal payment succeeded → re-activate if suspended ─────────
  else if (event.type === 'invoice.payment_succeeded') {
    const subscriptionId = invoiceSubId(obj);
    // Reactivate on ANY successful invoice payment (not just billing_reason ===
    // 'subscription_cycle') — a recovered past-due payment can carry a different
    // reason, and gating on it could leave a paying customer suspended forever.
    // activateSub is idempotent: a no-op on the initial create / already-active keys,
    // and the license row may not exist yet on the very first invoice (404, swallowed).
    if (subscriptionId && !(await isAnalystSub(subscriptionId))) {  // Analyst subs have no license to activate
      try {
        await activateSub(subscriptionId);
      } catch (err) {
        console.error(`[webhook-sub] Activate failed — sub:${subscriptionId} error:${err.message}`);
      }
    }
  }

  // ── Payment failed → suspend access ──────────────────────────────────────
  else if (event.type === 'invoice.payment_failed') {
    const subscriptionId = invoiceSubId(obj);
    if (subscriptionId && !(await isAnalystSub(subscriptionId))) {  // Analyst subs have no license to suspend
      try {
        await suspendSub(subscriptionId);
      } catch (err) {
        console.error(`[webhook-sub] Suspend failed — sub:${subscriptionId} error:${err.message}`);
      }
    }
  }

  // ── Subscription cancelled → revoke access ────────────────────────────────
  else if (event.type === 'customer.subscription.deleted') {
    const subscriptionId = obj?.id;
    if (obj?.metadata?.tier === 'analyst') {   // Analyst cancel → drop from the audience (no license to cancel)
      try {
        const cust = obj.customer ? await stripe.customers.retrieve(obj.customer) : null;
        // Only strip entitlements if NO other active paid sub (e.g. an active Trader) still includes them.
        if (!(await hasOtherActivePaidSub(cust?.email, subscriptionId))) {
          await analystRemove(cust?.email);
          await discordRevokeRole(cust?.metadata?.discord_id);
          await freeAdd(cust?.email);   // revert to a free member (keeps the Weekly + articles)
        }
      } catch (err) {
        console.error(`[webhook-sub] analyst remove failed — sub:${subscriptionId} error:${err.message}`);
      }
    } else if (subscriptionId) {
      try {
        await cancelSub(subscriptionId);
      } catch (err) {
        console.error(`[webhook-sub] Cancel failed — sub:${subscriptionId} error:${err.message}`);
      }
      try {   // Trader cancel → drop paid-Discord role + Analyst audience UNLESS another active paid sub keeps them
        const cust = obj.customer ? await stripe.customers.retrieve(obj.customer) : null;
        if (!(await hasOtherActivePaidSub(cust?.email, subscriptionId))) {
          await discordRevokeRole(cust?.metadata?.discord_id);
          await analystRemove(cust?.email);
          await freeAdd(cust?.email);   // revert to a free member (keeps the Weekly + articles)
        }
      } catch (e) {}
    }
  }

  // ── Customer email changed → keep the Analyst Resend audience in sync ──────
  // Reads are broadcast BY EMAIL, so a billing-email change (Stripe portal or manual edit) must move the
  // audience contact — otherwise the reads keep going to the old address. Gated to ACTIVE PAID customers
  // (Analyst OR Trader — both live in the Analyst audience now) so a free/unpaid change is never swept in.
  else if (event.type === 'customer.updated') {
    const oldEmail = event.data?.previous_attributes?.email;
    const newEmail = obj?.email;
    if (oldEmail && newEmail && oldEmail !== newEmail) {
      try {
        const subs = await stripe.subscriptions.list({ customer: obj.id, status: 'all', limit: 20 });
        const isActivePaid = subs.data.some(s =>
          ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status));
        if (isActivePaid) {
          await analystRemove(oldEmail);
          await analystAdd(newEmail);
          console.log(`[webhook-sub] analyst audience email synced: ${oldEmail} → ${newEmail}`);
        }
      } catch (err) {
        console.error(`[webhook-sub] analyst email sync failed: ${err.message}`);
      }
    }
  }

  return res.status(200).json({ received: true });
};

handler.config = { api: { bodyParser: false } };
module.exports = handler;
