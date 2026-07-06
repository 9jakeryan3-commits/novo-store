const Stripe = require('stripe');
const { Resend } = require('resend');

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

// ── NoVo Analyst ($29 email tier) — routed by subscription metadata.tier==='analyst'. These subs have NO
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
async function analystAdd(email) {
  if (!ANALYST_AUDIENCE || !email) return;
  try { await resend.contacts.create({ audienceId: ANALYST_AUDIENCE, email, unsubscribed: false }); }
  catch (e) { console.error(`[webhook-sub] analyst add failed: ${e.message}`); }
}
async function analystRemove(email) {
  if (!ANALYST_AUDIENCE || !email) return;
  try { await resend.contacts.remove({ audienceId: ANALYST_AUDIENCE, email }); }
  catch (e) { console.error(`[webhook-sub] analyst remove failed: ${e.message}`); }
}
// The free + Analyst lists are kept DISJOINT so no one gets the 'both' broadcasts (Weekly, articles) twice. A paid
// sub lives ONLY on the Analyst list; on upgrade we pull them off the free list, on a real cancel we add them back.
async function freeRemove(email) {
  if (!FREE_AUDIENCE || !email) return;
  try { await resend.contacts.remove({ audienceId: FREE_AUDIENCE, email }); }
  catch (e) { console.error(`[webhook-sub] free-list remove failed: ${e.message}`); }
}
async function freeAdd(email) {
  if (!FREE_AUDIENCE || !email) return;
  try { await resend.contacts.create({ audienceId: FREE_AUDIENCE, email, unsubscribed: false }); }
  catch (e) { console.error(`[webhook-sub] free-list add failed: ${e.message}`); }
}
// True if this EMAIL still has ANY OTHER active paid sub (Analyst or Pulse). Stripe mints a separate customer
// per checkout, so a dual-tier user's subs live on different customer objects that share one email — checking
// only obj.customer would miss the other sub. Prevents cancelling one paid sub from stripping entitlements the
// user still pays for via another (e.g. cancel a redundant Analyst sub while an active Pulse sub still includes it).
async function hasOtherActivePaidSub(email, excludeSubId) {
  if (!email) return false;
  try {
    const custs = await stripe.customers.list({ email, limit: 100 });
    for (const c of custs.data) {
      const subs = await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 20 });
      if (subs.data.some(s => s.id !== excludeSubId && ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status))) return true;
    }
  } catch (e) { console.error(`[webhook-sub] other-active-sub check failed: ${e.message}`); }
  return false;
}
function analystWelcomeHtml(connectUrl) {
  return `<div style="margin:0;padding:0;background:#070b12;">
  <div style="max-width:560px;margin:0 auto;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#0a1120;border:1px solid #1c2c47;border-bottom:0;border-radius:12px 12px 0 0;padding:22px 24px;text-align:center;">
      <img src="https://novo-aitrading.app/novo-logo-light.png?v=1" alt="NoVo AI Trading" height="30" style="height:30px;width:auto;display:inline-block;border:0;">
      <div style="margin-top:9px;font-size:10.5px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22d3ee;">NoVo Analyst</div>
    </div>
    <div style="background:#0f1a2e;border:1px solid #1c2c47;border-top:0;border-radius:0 0 12px 12px;padding:30px 30px 26px;">
      <h1 style="color:#eaf3ff;font-size:22px;font-weight:800;margin:0 0 14px;letter-spacing:-.3px;">You're in &mdash; NoVo Analyst is live.</h1>
      <p style="color:#c2d2e6;line-height:1.65;font-size:15px;margin:0 0 14px;">You'll now get NoVo's market reads by email &mdash; <b style="color:#eaf3ff">The Open</b> and <b style="color:#eaf3ff">The Close</b> each session, the <b style="color:#eaf3ff">Week Ahead</b> on Sundays, and <b style="color:#eaf3ff">intraday alerts</b> when the structural regime shifts or dealers flip the <b style="color:#eaf3ff">gamma regime</b> from absorbing to amplifying. Every read carries the <b style="color:#eaf3ff">actual levels</b> &mdash; real support, resistance, and structure &mdash; not vague prose. The same dealer-flow read the machine runs on, in plain language. No hype, no signals.</p>
      <p style="color:#c2d2e6;line-height:1.65;font-size:15px;margin:0 0 14px;">Your first read arrives with the next market session.</p>
      ${connectUrl ? `<div style="margin:18px 0 6px;border:1px solid #2b2f57;border-left:3px solid #5865F2;border-radius:8px;padding:16px 18px;background:rgba(88,101,242,0.08);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Prefer Discord?</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;margin-bottom:12px;">Get every read and alert in the members-only Analyst channels. Link your Discord account to unlock them.</div>
        <a href="${connectUrl}" style="display:inline-block;background:#5865F2;color:#ffffff;font-weight:800;font-size:13.5px;padding:11px 22px;border-radius:8px;text-decoration:none;">Connect your Discord &rarr;</a>
        <div style="font-size:12px;color:#6f8bab;line-height:1.5;margin-top:12px;">Want Discord only? Once it's linked, just hit <b style="color:#9fb6d1;">unsubscribe</b> on any email &mdash; your reads keep flowing in the private channels, and your subscription stays active.</div>
      </div>` : ''}
      <div style="margin-top:22px;border:1px solid #1c2c47;border-left:3px solid #10b981;border-radius:8px;padding:16px 18px;background:rgba(16,185,129,0.06);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Want it raw &amp; live?</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;">This is the read. <b style="color:#eaf3ff">NoVo Pulse</b> executes it live in your own broker account, within your rules &mdash; non-custodial. <a href="https://novo-aitrading.app" style="color:#34d399;font-weight:700;text-decoration:none;">See NoVo Pulse &rarr;</a></div>
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
<body style="margin:0;padding:0;background:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:30px 16px;">
  <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:34px 32px;">
    <div style="text-align:center;">
      <img src="https://novo-aitrading.app/novo-logo.png" alt="NoVo" width="118" style="width:118px;height:auto;display:inline-block;border:0;">
      <div style="font-size:11px;letter-spacing:3px;color:#10b981;text-transform:uppercase;font-weight:700;margin:10px 0 24px;">NoVo Pulse &mdash; Autonomous Execution</div>
    </div>

    <h1 style="color:#0b1527;font-size:22px;margin:0 0 10px;">Welcome to NoVo Pulse &mdash; you're all set.</h1>
    <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 22px;">Your subscription is active. Head to your portal to finish setup and open your dashboard &mdash; you'll be up and running in minutes.</p>

    <div style="text-align:center;margin:0 0 26px;">
      <a href="https://app.novo-aitrading.app" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;padding:14px 34px;border-radius:8px;font-weight:700;font-size:15px;">Open Your Portal</a>
    </div>

    ${connectUrl ? `<div style="background:#f4f5ff;border:1px solid #d9ddfb;border-radius:10px;padding:16px 18px;margin:0 0 24px;text-align:center;">
      <div style="font-size:14px;color:#0b1527;font-weight:700;margin-bottom:6px;">Join the members Discord</div>
      <div style="font-size:13px;color:#475569;line-height:1.5;margin-bottom:12px;">Your subscription includes the private NoVo Discord &mdash; the daily reads, alerts, and the members community. Link your account to unlock it.</div>
      <a href="${connectUrl}" style="display:inline-block;background:#5865F2;color:#ffffff;text-decoration:none;padding:11px 24px;border-radius:8px;font-weight:700;font-size:14px;">Connect your Discord &rarr;</a>
    </div>` : ''}

    <div style="border-top:1px solid #e2e8f0;margin:0 0 20px;"></div>
    <h2 style="color:#0b1527;font-size:16px;margin:0 0 14px;">Getting started</h2>
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
      <tr><td style="vertical-align:top;padding:0 12px 14px 0;width:22px;"><div style="background:#10b981;color:#ffffff;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;">1</div></td>
          <td style="vertical-align:top;padding-bottom:14px;color:#334155;font-size:14px;line-height:1.55;">Go to <strong style="color:#0b1527;">app.novo-aitrading.app</strong> and create your account using <strong style="color:#0b1527;">this email address</strong>.</td></tr>
      <tr><td style="vertical-align:top;padding:0 12px 14px 0;"><div style="background:#10b981;color:#ffffff;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;">2</div></td>
          <td style="vertical-align:top;padding-bottom:14px;color:#334155;font-size:14px;line-height:1.55;">Connect your <strong style="color:#0b1527;">Tradier + Alpaca</strong> keys &mdash; validated against the brokers.</td></tr>
      <tr><td style="vertical-align:top;padding:0 12px 14px 0;"><div style="background:#10b981;color:#ffffff;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;">3</div></td>
          <td style="vertical-align:top;padding-bottom:14px;color:#334155;font-size:14px;line-height:1.55;">Your private dashboard goes live automatically &mdash; AI pre-configured, <strong style="color:#0b1527;">paper trading immediately</strong>.</td></tr>
      <tr><td style="vertical-align:top;padding:0 12px 0 0;"><div style="background:#10b981;color:#ffffff;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;">4</div></td>
          <td style="vertical-align:top;color:#334155;font-size:14px;line-height:1.55;">Open it in any browser, or install it as an app on your desktop or phone.</td></tr>
    </table>

    <p style="color:#475569;font-size:14px;line-height:1.6;margin:22px 0 0;">Start in paper mode (the default) and watch it run before switching to live.</p>

    <div style="background:#fff8ec;border:1px solid #f5d9a8;border-left:3px solid #f59e0b;border-radius:8px;padding:14px 18px;margin:22px 0 0;font-size:13px;color:#7c5e1e;line-height:1.6;">
      <strong style="color:#b45309;">Auto-renewing:</strong> Your subscription renews automatically (monthly or yearly, whichever you chose). Manage billing or cancel any time from your portal at <a href="https://app.novo-aitrading.app" style="color:#1a4a8a;">app.novo-aitrading.app</a>.
    </div>

    <p style="color:#475569;font-size:14px;margin:18px 0 0;">Questions? Just reply, or email <a href="mailto:support@novo-aitrading.app" style="color:#1a4a8a;">support@novo-aitrading.app</a>.</p>

    <div style="border-top:1px solid #e2e8f0;margin-top:24px;padding-top:16px;">
      <p style="font-size:12px;color:#94a3b8;margin:0;line-height:1.5;">Not financial advice. Trading involves substantial risk of loss. Your access is active while your subscription is current.</p>
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

  const obj = event.data.object;

  // ── New subscription checkout completed ───────────────────────────────────
  if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
    const email = obj?.customer_details?.email;
    if (!email) {
      console.error(`[webhook-sub] Missing email — session:${obj.id}`);
      return res.status(200).json({ received: true });
    }

    // NoVo Analyst ($29 email tier): add to the Analyst audience + send its welcome, then STOP — no license,
    // no portal, no provisioning.
    if (obj?.metadata?.tier === 'analyst') {
      await analystAdd(email);
      await freeRemove(email);   // paid now → off the free list (Weekly + articles reach them via the Analyst broadcasts)
      try {
        await resend.emails.send({
          from: process.env.FROM_EMAIL || 'The NoVo Journal <orders@novo-aitrading.app>',
          replyTo: 'support@novo-aitrading.app', to: [email],
          subject: 'Welcome to NoVo Analyst', html: analystWelcomeHtml(`${SITE}/api/discord?cs=${obj.id}`),
        });
      } catch (err) { console.error(`[webhook-sub] analyst welcome failed (non-fatal): ${err.message}`); }
      return res.status(200).json({ received: true });
    }

    // Pulse INCLUDES Analyst — add the Pulse subscriber to the Analyst email audience too, so they receive
    // the Open / Close / Week Ahead reads + intraday alerts. (Their paid-Discord role is granted on connect
    // via /api/discord, which already accepts any paid sub — Analyst OR Pulse.)
    await analystAdd(email);
    await freeRemove(email);   // paid now → off the free list (Weekly + articles reach them via the Analyst broadcasts)

    // Hosted model: no license key, no download. The control plane recognizes the subscription by the
    // customer's email (Stripe is the source of truth); this email just welcomes them to the portal.
    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL || 'NoVo <orders@novo-aitrading.app>',
        replyTo: 'support@novo-aitrading.app',
        to: [email],
        subject: 'Welcome to NoVo Pulse — open your portal',
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
        // Only strip entitlements if NO other active paid sub (e.g. an active Pulse) still includes them.
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
      try {   // Pulse cancel → drop paid-Discord role + Analyst audience UNLESS another active paid sub keeps them
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
  // (Analyst OR Pulse — both live in the Analyst audience now) so a free/unpaid change is never swept in.
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
