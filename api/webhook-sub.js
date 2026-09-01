const Stripe = require('stripe');
const { Resend } = require('resend');
const { claimOnce, releaseClaim } = require('./_kv');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const LICENSE_SERVER = (process.env.NOVO_LICENSE_SERVER_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY;
const SITE = process.env.SITE_URL || 'https://novo-options.trade';

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

// Refund the just-captured invoice of a subscription (used when we cancel a duplicate the customer was charged
// for, so they're never out the money pending a manual refund). Returns true if a refund was issued. Best-effort.
async function _refundLatest(sub) {
  try {
    let inv = sub && sub.latest_invoice;
    if (!inv) return false;
    if (typeof inv === 'string') inv = await stripe.invoices.retrieve(inv);
    let pi = inv && inv.payment_intent;
    if (!pi) return false;
    pi = (typeof pi === 'string') ? pi : pi.id;
    await stripe.refunds.create({ payment_intent: pi });
    return true;
  } catch (e) {
    console.error(`[webhook-sub] refund failed: ${e.message}`);
    return false;
  }
}

// Resolve the Stripe customer id from a charge.refunded (a Charge) or charge.dispute.created (a Dispute) object.
async function _customerFromChargeEvent(evtType, obj) {
  if (obj && obj.customer) return obj.customer;
  const chargeId = (evtType === 'charge.dispute.created') ? obj && obj.charge : null;
  if (chargeId) { try { const ch = await stripe.charges.retrieve(chargeId); return ch.customer || null; } catch (_) {} }
  return null;
}

// ── NoVo Analyst ($69 email tier) — routed by subscription metadata.tier==='analyst'. These subs have NO
// license/instance; they only add/remove the email on the Analyst Resend audience. ─────────────────────
const { isReservedEmail } = require('./_lib/reserved-email.js');
const ANALYST_AUDIENCE = process.env.RESEND_ANALYST_AUDIENCE_ID;
const FREE_AUDIENCE = process.env.RESEND_AUDIENCE_ID;   // the free "Market Notes" list — kept DISJOINT from Analyst
const CRYPTO_AUDIENCE = process.env.RESEND_CRYPTO_AUDIENCE_ID;   // optional; unset = skip cleanly
const DISCORD_GUILD = process.env.DISCORD_GUILD_ID || '1522967079400112198';
const DISCORD_ROLE = process.env.DISCORD_ROLE_ID || '1522999999565398047';
async function discordRevokeRole(discordId) {
  if (!discordId) return;
  if (!process.env.DISCORD_BOT_TOKEN) {
    // Silent before: a burned/unset token meant revocation never happened and nothing said so.
    console.error('[webhook-sub] DISCORD_BOT_TOKEN not set - role NOT revoked for', discordId);
    return;
  }
  try {
    await fetch(`https://discord.com/api/guilds/${DISCORD_GUILD}/members/${discordId}/roles/${DISCORD_ROLE}`,
      { method: 'DELETE', headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } });
  } catch (e) { console.error(`[webhook-sub] discord role revoke failed: ${e.message}`); }
}
// Analyst price ids (env + hardcoded fallbacks, matching checkout-analyst.js) — the RELIABLE tier signal.
const ANALYST_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_ANALYST, process.env.STRIPE_PRICE_ANALYST_YEARLY,
  'price_1TugYAApyfMAkbeEarl2ULSv', 'price_1TugYAApyfMAkbeE9c3Rdypj',   // $129 / $1,290 — kept: existing subs
  'price_1U59pFApyfMAkbeEhEDpToGK', 'price_1U59pFApyfMAkbeEDzNHEJbD',   // $129 / $1,290
  // The LLC-account (acct_1U8720B1Bq29OALa) Analyst prices — what the env vars point at since
  // 2026-08-25. Baked here too because a set whose only current members arrive via env is a
  // set that silently orphans every live Analyst sub the day a variable is dropped.
  'price_1U8R0NB1Bq29OALa7evMqazz', 'price_1U8R2PB1Bq29OALaUv2W6VAm',   // $129 / $1,290 — LLC account
].filter(Boolean));

// Resolve tier from the subscription's PRICE, not just the mutable/strippable metadata.tier. metadata is a
// fast path; the price id is authoritative. Misclassifying tier on cancel either left an Analyst in the paid
// audience or (worse) skipped revoking a Trader license (cancelled member keeps trading).
function subIsAnalyst(sub) {
  if (sub?.metadata?.tier === 'analyst') return true;
  try { return (sub?.items?.data || []).some(it => ANALYST_PRICE_IDS.has(it?.price?.id)); }
  catch (_) { return false; }
}

// NoVo Crypto Market Map — its OWN product. Like Analyst it has NO license and NO instance;
// unlike Analyst it does not include the equity read, so it never joins the Analyst audience.
const CRYPTO_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_CRYPTO, process.env.STRIPE_PRICE_CRYPTO_YEARLY,
  'price_1U9EU0B1Bq29OALajbT8DWJS', 'price_1U9EUsB1Bq29OALaYh2QODHA',   // $79 / $790 — prod_V9XZrb8qBEdzoI
  // Bundle COMPANION prices (2026-09-01) — the discounted crypto halves of the two bundles,
  // on the same product. A bundle sub carries one of these beside its Analyst/Trader item.
  process.env.STRIPE_PRICE_CRYPTO_BUNDLE_AC, process.env.STRIPE_PRICE_CRYPTO_BUNDLE_AC_YEARLY,
  process.env.STRIPE_PRICE_CRYPTO_BUNDLE_ALL, process.env.STRIPE_PRICE_CRYPTO_BUNDLE_ALL_YEARLY,
  'price_1UB0ZhB1Bq29OALa8iLZSSL5', 'price_1UB0ZhB1Bq29OALamNjyA6Y9',   // $40 / $400 — beside Analyst
  'price_1UB0ZhB1Bq29OALaOw2hUHWS', 'price_1UB0ZhB1Bq29OALaWQPTPOs7',   // $30 / $300 — beside Trader
].filter(Boolean));
function subIsCrypto(sub) {
  if (sub?.metadata?.tier === 'crypto') return true;
  try { return (sub?.items?.data || []).some(it => CRYPTO_PRICE_IDS.has(it?.price?.id)); }
  catch (_) { return false; }
}

// THE branch that matters. This file was written for two tiers, so its logic was
// "not Analyst == Trader" and every non-Analyst sub was sent down the license path.
// A Crypto sub has no license either, so ask the question that is actually being asked:
// does this tier own a trading instance? Only a sub carrying a TRADER item does.
// PER ITEM since the bundles (2026-09-01): the Complete bundle is [Trader item, crypto
// companion item] in ONE subscription — the old per-sub "not analyst && not crypto" read
// its crypto companion and said "no license", so a Complete member's engine was never
// activated on payment and never suspended on failure. An item that is neither an Analyst
// nor a Crypto price IS the Trader item, whatever else rides beside it.
function subHasLicense(sub) {
  // Metadata first, as a fast path AND a safety net for prices absent from the literal sets
  // (a grandfathered Analyst price we forgot would otherwise read as "the Trader item").
  const t = sub?.metadata?.tier;
  if (t === 'analyst' || t === 'crypto' || t === 'bundle_ac') return false;
  if (t === 'bundle_all') return true;
  try {
    const items = sub?.items?.data || [];
    if (items.length) {
      return items.some(it => it?.price?.id
        && !ANALYST_PRICE_IDS.has(it.price.id) && !CRYPTO_PRICE_IDS.has(it.price.id));
    }
  } catch (_) { /* fall through to the per-sub read */ }
  // No items visible (thin event object): the old per-sub answer, which is right for every
  // single-product sub and errs toward "no license" — never touches the license server blind.
  return !subIsAnalyst(sub) && !subIsCrypto(sub);
}

async function isAnalystSub(subscriptionId) {
  try { const s = await stripe.subscriptions.retrieve(subscriptionId); return subIsAnalyst(s); }
  catch { return false; }
}

async function subIdHasLicense(subscriptionId) {
  try { const s = await stripe.subscriptions.retrieve(subscriptionId); return subHasLicense(s); }
  catch { return false; }   // unknown -> do NOT touch the license server
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
  if (isReservedEmail(email)) return { added: false, existed: false };   // never list a reserved test address
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
  if (isReservedEmail(email)) return;                                     // never list a reserved test address
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
// Trader INCLUDES Analyst, so holding both bills $129 + $209 for ONE entitlement. On a Trader checkout, retire
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
    // 'not analyst' used to mean Trader. With a third product that is false: a Crypto sub
    // would read as an active Trader and cancel a legitimate Analyst checkout as a
    // "reverse duplicate". And since the bundles, PER SUB is false too: the Complete bundle
    // carries a crypto companion beside its Trader item, so "not crypto" would miss it and
    // its holder could double-buy Trader. subHasLicense asks the per-ITEM question.
    return subs.data.some(s => s.id !== excludeSubId && subHasLicense(s) && LIVE.includes(s.status));
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

// ── Bundle helpers (2026-09-01) ──────────────────────────────────────────────
// One generic sweep over every customer sharing the email (same search()+list() shape as
// the guards above), applying `test` per live sub. Kept factored because four different
// bundle questions need the identical walk.
async function _sweepSubs(email, excludeSubId, test) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return false;
  const LIVE = ['active', 'trialing', 'past_due', 'unpaid'];
  const hit = async (custId) => {
    const subs = await stripe.subscriptions.list({ customer: custId, status: 'all', limit: 20 });
    return subs.data.some(s => s.id !== excludeSubId && LIVE.includes(s.status) && test(s));
  };
  try {
    const seen = new Set();
    try {
      const sr = await stripe.customers.search({ query: `email:"${norm.replace(/"/g, '')}"`, limit: 20 });
      for (const c of sr.data) { seen.add(c.id); if (await hit(c.id)) return true; }
    } catch (_) { /* search index warming up — fall through to list() */ }
    const custs = await stripe.customers.list({ email: norm, limit: 100 });
    for (const c of custs.data) { if (!seen.has(c.id) && await hit(c.id)) return true; }
  } catch (e) { console.error(`[webhook-sub] sub sweep failed: ${e.message}`); }
  return false;
}
// A live bundle of either kind. metadata-keyed on purpose: our own checkout-bundle.js is
// the only writer of these tier values, and the price-id fallback below catches a stripped one.
const _isBundleSub = (s) => String(s?.metadata?.tier || '').startsWith('bundle_')
  || (subIsCrypto(s) && (subIsAnalyst(s) || subHasLicense(s)));
const hasLiveBundle = (email, excludeSubId) => _sweepSubs(email, excludeSubId, _isBundleSub);
// Any other live sub already granting the Crypto Market Map (standalone or via a bundle).
const emailHasCryptoEnt = (email, excludeSubId) => _sweepSubs(email, excludeSubId, subIsCrypto);

// Retire live subs whose metadata.tier is in `tiers` — the generalized form of
// retireAnalystOnTraderUpgrade, with the same trialing-cancel-now / active-run-out split
// and the same non-fatal posture. Used when a bundle purchase supersedes standalone subs.
async function retireTierSubs(email, newSubId, tiers) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return [];
  const done = [];
  const want = new Set(tiers);
  const sweep = async (custId) => {
    const subs = await stripe.subscriptions.list({ customer: custId, status: 'all', limit: 20 });
    for (const s of subs.data) {
      if (s.id === newSubId) continue;
      if (!want.has(s.metadata?.tier)) continue;
      if (!['active', 'trialing', 'past_due', 'unpaid'].includes(s.status)) continue;
      if (s.cancel_at_period_end) { done.push(`${s.id}:already-ending`); continue; }
      try {
        if (s.status === 'trialing') {
          await stripe.subscriptions.cancel(s.id);
          done.push(`${s.id}:cancelled-now`);
        } else {
          await stripe.subscriptions.update(s.id, { cancel_at_period_end: true });
          done.push(`${s.id}:ends-at-period-end`);
        }
      } catch (e) { console.error(`[webhook-sub] could not retire ${s.metadata?.tier} sub ${s.id}: ${e.message}`); }
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
  } catch (e) { console.error(`[webhook-sub] tier-retire sweep failed: ${e.message}`); }
  return done;
}

// Entitlement caches (crypto-map.js 'ent:crypto:', trader-live.js 'ent:trader:') hold a
// verdict for up to 600s (allow) / 120s (deny). Purge both the moment a subscription is
// born or dies, so a new subscriber is never stuck behind a stale deny and a canceller
// does not coast on a stale allow. Same sha256(email)[:24] recipe both endpoints use.
async function entCachePurge(email) {
  try {
    const norm = String(email || '').trim().toLowerCase();
    if (!norm) return;
    const r = require('./_kv').kv();
    if (!r) return;
    const h = require('crypto').createHash('sha256').update(norm).digest('hex').slice(0, 24);
    try { await r.del('ent:crypto:' + h); } catch (_) {}
    try { await r.del('ent:trader:' + h); } catch (_) {}
  } catch (_) { /* cache purge is best-effort by definition */ }
}

function analystWelcomeHtml(connectUrl) {
  return `<div style="margin:0;padding:0;background:#101013;">
  <div style="max-width:560px;margin:0 auto;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#17181b;border:1px solid #2e3036;border-bottom:0;border-radius:12px 12px 0 0;padding:22px 24px;text-align:center;">
      <img src="https://novo-options.trade/novo-logo-light.png?v=5" alt="NoVo Options Trading" height="30" style="height:30px;width:auto;display:inline-block;border:0;">
      <div style="margin-top:9px;font-size:10.5px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22d3ee;">NoVo Analyst</div>
    </div>
    <div style="background:#1c1d21;border:1px solid #2e3036;border-top:0;border-radius:0 0 12px 12px;padding:30px 30px 26px;">
      <h1 style="color:#eaf3ff;font-size:22px;font-weight:800;margin:0 0 14px;letter-spacing:-.3px;">You're in &mdash; NoVo Analyst is live.</h1>
      <p style="color:#c2d2e6;line-height:1.65;font-size:15px;margin:0 0 14px;">You'll now get NoVo's market reads by email &mdash; <b style="color:#eaf3ff">The Open</b> and <b style="color:#eaf3ff">The Close</b> each session, plus the <b style="color:#eaf3ff">Week Ahead</b> on Sundays. And in the members-only <b style="color:#eaf3ff">Analyst Discord</b>: real-time <b style="color:#eaf3ff">&lsquo;The Line&rsquo;</b> alerts the moment a major level breaks or dealers flip the <b style="color:#eaf3ff">gamma regime</b> from absorbing to amplifying &mdash; link your Discord below to unlock them. Every read carries the <b style="color:#eaf3ff">actual levels</b> &mdash; real support, resistance, and structure &mdash; not vague prose. The same dealer-flow read the machine runs on, in plain language. No hype, no signals.</p>
      <p style="color:#c2d2e6;line-height:1.65;font-size:15px;margin:0 0 14px;">Your first read arrives with the next market session.</p>
      <div style="margin:18px 0 6px;border:1px solid #2e3036;border-left:3px solid #22d3ee;border-radius:8px;padding:16px 18px;background:rgba(34,211,238,0.07);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Your live dashboard</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;margin-bottom:12px;">Watch the dealer map update through the session &mdash; the live <b style="color:#eaf3ff">SPY / QQQ / IWM</b> chart with dealer levels, net GEX, Zero-Gamma, walls, expected move &amp; skew, plus the &lsquo;The Line&rsquo; feed. Install it as an app and turn on push alerts.</div>
        <a href="https://novo-options.trade/analyst/live" style="display:inline-block;background:linear-gradient(180deg,#22d3ee,#3b82f6);color:#04121a;font-weight:800;font-size:13.5px;padding:11px 22px;border-radius:8px;text-decoration:none;">Open your live dashboard &rarr;</a>
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
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;">This is the read. <b style="color:#eaf3ff">NoVo Trader</b> draws it live on the tape, with an hourly structural audit beside it. <a href="https://novo-options.trade" style="color:#34d399;font-weight:700;text-decoration:none;">See NoVo Trader &rarr;</a></div>
      </div>
      <div style="margin-top:22px;border:1px solid #2e3036;border-left:3px solid #22d3ee;border-radius:8px;padding:16px 18px;background:rgba(34,211,238,0.06);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Don't need these in your inbox?</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;">Every read is live in your <b style="color:#22d3ee">dealer dashboard</b> and the <b style="color:#7f8cff">Analyst Discord</b> &mdash; email is just a backup for when you're away from them. To stop the emails, click <b style="color:#eaf3ff">Unsubscribe</b> at the bottom of any read. Your subscription, dashboard, and Discord access stay exactly the same.</div>
      </div>
      <p style="font-size:11.5px;color:#6f8bab;line-height:1.6;margin:20px 0 0;">Market analysis &amp; education only &mdash; not financial advice. Trading involves substantial risk of loss. Manage or cancel anytime via the billing link in your Stripe receipts.</p>
    </div>
  </div>
</div>`;
}

function cryptoWelcomeHtml(connectUrl) {
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
      <img src="https://novo-options.trade/novo-logo-light.png?v=5" alt="NoVo Options Trading" width="118" style="width:118px;height:auto;display:inline-block;border:0;">
      <div style="font-size:11px;letter-spacing:3px;color:#a78bfa;text-transform:uppercase;font-weight:700;margin:10px 0 24px;">NoVo Crypto Market Map</div>
    </div>

    <h1 style="color:#eaf3ff;font-size:22px;margin:0 0 10px;">Welcome to the Crypto Market Map.</h1>
    <p style="color:#c2d2e6;font-size:15px;line-height:1.6;margin:0 0 22px;">Your subscription is active. The map is live now &mdash; every coin NoVo covers, priced off the streamed book, with the on-chain side underneath it. Sign in with <strong style="color:#eaf3ff;">this email address</strong>.</p>

    <div style="text-align:center;margin:0 0 26px;">
      <a href="https://novo-options.trade/crypto/live" style="display:inline-block;background:#a78bfa;color:#12091f;text-decoration:none;padding:14px 34px;border-radius:8px;font-weight:800;font-size:15px;">Open the Crypto Market Map</a>
    </div>

    ${connectUrl ? `<div style="background:rgba(88,101,242,0.08);border:1px solid #3a3c42;border-left:3px solid #5865F2;border-radius:10px;padding:16px 18px;margin:0 0 24px;text-align:center;">
      <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:6px;">Join the members Discord</div>
      <div style="font-size:13px;color:#9fb6d1;line-height:1.5;margin-bottom:12px;">Your subscription includes the private NoVo Discord &mdash; the daily reads, alerts, and the members community. Link your account to unlock it.</div>
      <a href="${connectUrl}" style="display:inline-block;background:#5865F2;color:#ffffff;text-decoration:none;padding:11px 24px;border-radius:8px;font-weight:700;font-size:14px;">Connect your Discord &rarr;</a>
    </div>` : ''}

    <div style="border-top:1px solid #2e3036;margin:0 0 20px;"></div>
    <h2 style="color:#eaf3ff;font-size:16px;margin:0 0 14px;">Getting started</h2>
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
      <tr><td style="vertical-align:top;padding:0 12px 14px 0;width:22px;"><div style="background:#a78bfa;color:#12091f;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;">1</div></td>
          <td style="vertical-align:top;padding-bottom:14px;color:#c2d2e6;font-size:14px;line-height:1.55;">Open <strong style="color:#eaf3ff;">novo-options.trade/crypto/live</strong> and sign in with <strong style="color:#eaf3ff;">this email address</strong> &mdash; nothing to install, nothing to connect.</td></tr>
      <tr><td style="vertical-align:top;padding:0 12px 14px 0;"><div style="background:#a78bfa;color:#12091f;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;">2</div></td>
          <td style="vertical-align:top;padding-bottom:14px;color:#c2d2e6;font-size:14px;line-height:1.55;">Start with the <strong style="color:#eaf3ff;">coverage bands</strong> &mdash; they tell you how much of each coin&rsquo;s picture is measured rather than inferred, before you read anything else.</td></tr>
      <tr><td style="vertical-align:top;padding:0 12px 0 0;"><div style="background:#a78bfa;color:#12091f;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;">3</div></td>
          <td style="vertical-align:top;color:#c2d2e6;font-size:14px;line-height:1.55;">Open it in any browser, or install it as an app on your desktop or phone.</td></tr>
    </table>

    <div style="background:rgba(245,158,11,0.08);border:1px solid #3a3c42;border-left:3px solid #f59e0b;border-radius:8px;padding:14px 18px;margin:22px 0 0;font-size:13px;color:#e8c48f;line-height:1.6;">
      <strong style="color:#f59e0b;">Auto-renewing:</strong> Your subscription renews automatically (monthly or yearly, whichever you chose). Manage billing or cancel any time from your portal at <a href="https://app.novo-aitrading.app" style="color:#22d3ee;">app.novo-aitrading.app</a>.
    </div>

    <p style="color:#c2d2e6;font-size:14px;margin:18px 0 0;">Questions? Just reply, or email <a href="mailto:support@novo-options.trade" style="color:#22d3ee;">support@novo-options.trade</a>.</p>

    <div style="border-top:1px solid #2e3036;margin-top:24px;padding-top:16px;">
      <p style="font-size:12px;color:#6f8bab;margin:0;line-height:1.5;">Not financial advice. Trading involves substantial risk of loss. Your access is active while your subscription is current.</p>
    </div>
  </div>
</div>
</body>
</html>`;
}

// Bundle welcomes (2026-09-01). One email covering both halves — a bundle buyer getting two
// separate product welcomes reads as two separate bills.
function _bundleShell(kicker, inner) {
  return `<div style="margin:0;padding:0;background:#101013;">
  <div style="max-width:560px;margin:0 auto;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#17181b;border:1px solid #2e3036;border-bottom:0;border-radius:12px 12px 0 0;padding:22px 24px;text-align:center;">
      <img src="https://novo-options.trade/novo-logo-light.png?v=5" alt="NoVo Options Trading" height="30" style="height:30px;width:auto;display:inline-block;border:0;">
      <div style="margin-top:9px;font-size:10.5px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22d3ee;">${kicker}</div>
    </div>
    <div style="background:#1c1d21;border:1px solid #2e3036;border-top:0;border-radius:0 0 12px 12px;padding:30px 30px 26px;">${inner}
      <p style="font-size:11.5px;color:#6f8bab;line-height:1.6;margin:20px 0 0;">Market analysis &amp; education only &mdash; not financial advice. Trading involves substantial risk of loss. Manage or cancel anytime at <a href="https://app.novo-aitrading.app" style="color:#22d3ee;">app.novo-aitrading.app</a>.</p>
    </div>
  </div>
</div>`;
}
const _bundleCryptoCard = `<div style="margin:18px 0 6px;border:1px solid #2e3036;border-left:3px solid #a78bfa;border-radius:8px;padding:16px 18px;background:rgba(167,139,250,0.07);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Your Crypto Market Map</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;margin-bottom:12px;">Dealer gamma on every coin with a real options book, funding per venue, the block tape, the carry curve, liquidation flow &mdash; live now. Sign in with this email.</div>
        <a href="https://novo-options.trade/crypto/live" style="display:inline-block;background:#a78bfa;color:#12091f;font-weight:800;font-size:13.5px;padding:11px 22px;border-radius:8px;text-decoration:none;">Open the Crypto Market Map &rarr;</a>
      </div>`;
const _bundleDiscordCard = (connectUrl) => connectUrl ? `<div style="margin:18px 0 6px;border:1px solid #3a3c42;border-left:3px solid #5865F2;border-radius:8px;padding:16px 18px;background:rgba(88,101,242,0.08);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">The members Discord</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;margin-bottom:12px;">Reads, real-time alerts and the members community &mdash; link your Discord to unlock the private channels.</div>
        <a href="${connectUrl}" style="display:inline-block;background:#5865F2;color:#ffffff;font-weight:800;font-size:13.5px;padding:11px 22px;border-radius:8px;text-decoration:none;">Connect your Discord &rarr;</a>
      </div>` : '';

function bundleAcWelcomeHtml(connectUrl) {
  return _bundleShell('NoVo Analyst + Crypto', `
      <h1 style="color:#eaf3ff;font-size:22px;font-weight:800;margin:0 0 14px;letter-spacing:-.3px;">You're in &mdash; both maps are live.</h1>
      <p style="color:#c2d2e6;line-height:1.65;font-size:15px;margin:0 0 14px;">One subscription, both products. <b style="color:#eaf3ff">NoVo Analyst</b>: the SPY / QQQ / IWM dealer map with NoVo's reads by email &mdash; <b style="color:#eaf3ff">The Open</b> and <b style="color:#eaf3ff">The Close</b> each session, the <b style="color:#eaf3ff">Week Ahead</b> on Sundays. <b style="color:#eaf3ff">The Crypto Market Map</b>: the same discipline pointed at crypto. Your first read arrives with the next market session.</p>
      <div style="margin:18px 0 6px;border:1px solid #2e3036;border-left:3px solid #22d3ee;border-radius:8px;padding:16px 18px;background:rgba(34,211,238,0.07);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Your equity dashboard</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;margin-bottom:12px;">The live <b style="color:#eaf3ff">SPY / QQQ / IWM</b> dealer map &mdash; net GEX, Zero-Gamma, the walls, expected move &amp; skew. Sign in with this email; we'll send a one-tap link.</div>
        <a href="https://novo-options.trade/analyst/live" style="display:inline-block;background:linear-gradient(180deg,#22d3ee,#3b82f6);color:#04121a;font-weight:800;font-size:13.5px;padding:11px 22px;border-radius:8px;text-decoration:none;">Open your live dashboard &rarr;</a>
      </div>
      ${_bundleCryptoCard}
      ${_bundleDiscordCard(connectUrl)}`);
}

function bundleAllWelcomeHtml(connectUrl) {
  return _bundleShell('NoVo Complete', `
      <h1 style="color:#eaf3ff;font-size:22px;font-weight:800;margin:0 0 14px;letter-spacing:-.3px;">You're in &mdash; the whole desk.</h1>
      <p style="color:#c2d2e6;line-height:1.65;font-size:15px;margin:0 0 14px;"><b style="color:#eaf3ff">NoVo Trader</b> (which includes everything in Analyst), plus the <b style="color:#eaf3ff">Crypto Market Map</b>, on one subscription. Trader streams every dealer level live on a real charting terminal, with the hourly structural audit and NoVo's written read beside the tape.</p>
      <div style="margin:18px 0 6px;border:1px solid #2e3036;border-left:3px solid #10b981;border-radius:8px;padding:16px 18px;background:rgba(16,185,129,0.07);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Start at your portal</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;margin-bottom:12px;">Your portal is where Trader lives &mdash; open it, sign in with this email, and the setup steps walk you through the rest.</div>
        <a href="https://app.novo-aitrading.app/portal" style="display:inline-block;background:linear-gradient(180deg,#34d399,#10b981);color:#04121a;font-weight:800;font-size:13.5px;padding:11px 22px;border-radius:8px;text-decoration:none;">Open your portal &rarr;</a>
      </div>
      ${_bundleCryptoCard}
      ${_bundleDiscordCard(connectUrl)}`);
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
      <img src="https://novo-options.trade/novo-logo-light.png?v=5" alt="NoVo Options Trading" width="118" style="width:118px;height:auto;display:inline-block;border:0;">
      <div style="font-size:11px;letter-spacing:3px;color:#10b981;text-transform:uppercase;font-weight:700;margin:10px 0 24px;">NoVo Trader &mdash; The Live Dealer Map</div>
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
      <div style="font-size:13px;color:#9fb6d1;line-height:1.55;margin-bottom:12px;">Your Trader subscription also includes <strong style="color:#eaf3ff;">NoVo Analyst</strong> &mdash; the daily desk notes and the <strong style="color:#eaf3ff;">live SPY / QQQ / IWM dealer dashboard</strong> (net GEX, walls, Zero-Gamma, expected move &amp; skew, updating through the session). Sign in with this email.</div>
      <a href="https://novo-options.trade/analyst/live" style="display:inline-block;background:#06b6d4;color:#04121a;text-decoration:none;padding:11px 24px;border-radius:8px;font-weight:800;font-size:14px;">Open the live dashboard &rarr;</a>
    </div>

    <div style="border-top:1px solid #2e3036;margin:0 0 20px;"></div>
    <h2 style="color:#eaf3ff;font-size:16px;margin:0 0 14px;">Getting started</h2>
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
      <tr><td style="vertical-align:top;padding:0 12px 14px 0;width:22px;"><div style="background:#10b981;color:#04121a;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;">1</div></td>
          <td style="vertical-align:top;padding-bottom:14px;color:#c2d2e6;font-size:14px;line-height:1.55;">Go to <strong style="color:#eaf3ff;">app.novo-aitrading.app</strong> and create your account using <strong style="color:#eaf3ff;">this email address</strong>.</td></tr>
      <tr><td style="vertical-align:top;padding:0 12px 14px 0;"><div style="background:#10b981;color:#04121a;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;">2</div></td>
          <td style="vertical-align:top;padding-bottom:14px;color:#c2d2e6;font-size:14px;line-height:1.55;">Open the dashboard from your portal &mdash; <strong style="color:#eaf3ff;">nothing to connect</strong>.</td></tr>
      <tr><td style="vertical-align:top;padding:0 12px 14px 0;"><div style="background:#10b981;color:#04121a;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;">3</div></td>
          <td style="vertical-align:top;padding-bottom:14px;color:#c2d2e6;font-size:14px;line-height:1.55;">The dealer map is live immediately &mdash; AI included, <strong style="color:#eaf3ff;">pick SPY, QQQ or IWM</strong>.</td></tr>
      <tr><td style="vertical-align:top;padding:0 12px 0 0;"><div style="background:#10b981;color:#04121a;width:22px;height:22px;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:800;">4</div></td>
          <td style="vertical-align:top;color:#c2d2e6;font-size:14px;line-height:1.55;">Open it in any browser, or install it as an app on your desktop or phone.</td></tr>
    </table>

    <p style="color:#c2d2e6;font-size:14px;line-height:1.6;margin:22px 0 0;">Pick SPY, QQQ or IWM and the dealer map draws itself &mdash; switch between them whenever you want.</p>

    <div style="background:rgba(245,158,11,0.08);border:1px solid #3a3c42;border-left:3px solid #f59e0b;border-radius:8px;padding:14px 18px;margin:22px 0 0;font-size:13px;color:#e8c48f;line-height:1.6;">
      <strong style="color:#f59e0b;">Auto-renewing:</strong> Your subscription renews automatically (monthly or yearly, whichever you chose). Manage billing or cancel any time from your portal at <a href="https://app.novo-aitrading.app" style="color:#22d3ee;">app.novo-aitrading.app</a>.
    </div>

    <p style="color:#c2d2e6;font-size:14px;margin:18px 0 0;">Questions? Just reply, or email <a href="mailto:support@novo-options.trade" style="color:#22d3ee;">support@novo-options.trade</a>.</p>

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
    const _rawEmail = obj?.customer_details?.email;
    // Normalize (trim + lowercase) so the trial-once KV gate + reverse-dupe guard key on the SAME value the
    // entitlement checks (~lines 138/167/205) already use — otherwise 'John@x.com' vs 'john@x.com' bypasses the
    // one-free-trial-per-email gate and mints unlimited free 7-day Analyst trials.
    const email = _rawEmail ? String(_rawEmail).trim().toLowerCase() : _rawEmail;
    if (!email) {
      console.error(`[webhook-sub] Missing email — session:${obj.id}`);
      return res.status(200).json({ received: true });
    }

    // NoVo BUNDLES (2026-09-01): bundle_ac = Analyst + Crypto ($169/$1,690), bundle_all =
    // Complete, i.e. Trader + Crypto ($239/$2,300). Two line items each — the existing
    // Analyst/Trader base price plus a discounted crypto companion — so entitlement flows
    // from price ids the gates already know. Must sit ABOVE the crypto/analyst branches
    // and the Trader fallthrough: an unrouted bundle would take the Trader path, send the
    // wrong welcome, and (for bundle_ac) provision a licence it did not buy.
    if (obj?.metadata?.tier === 'bundle_ac' || obj?.metadata?.tier === 'bundle_all') {
      const _tier = obj.metadata.tier;
      const _isAll = _tier === 'bundle_all';

      // DUPLICATE / CONFLICT GUARD. A live Trader (or Complete) sub means this purchase
      // double-bills something: Trader already includes Analyst, Complete includes it all.
      // For bundle_ac a live AC bundle is the same story. Cancel + auto-refund the NEW
      // purchase and say why — never leave a member paying twice for one entitlement. The
      // one deliberate asymmetry: buying Complete while holding plain Trader is ALSO
      // refused (rather than auto-retiring the Trader sub), because tearing down a live
      // Trader engine on a webhook race is a worse failure than asking support to switch —
      // the refusal email carries the path.
      try {
        const conflict = (await hasActiveTraderSub(email, obj.subscription))
          || (!_isAll && await hasLiveBundle(email, obj.subscription));
        if (conflict) {
          let charged = true, refunded = false;
          try {
            const sub = await stripe.subscriptions.retrieve(obj.subscription);
            charged = sub.status !== 'trialing';
            await stripe.subscriptions.cancel(obj.subscription);
            if (charged) refunded = await _refundLatest(sub);
          } catch (e) { console.error(`[webhook-sub] dupe-bundle cancel/refund failed: ${e.message}`); }
          console.log(`[webhook-sub] conflicting ${_tier} purchase by ${email} — cancelled ${obj.subscription} (charged=${charged}, refunded=${refunded})`);
          try {
            await resend.emails.send({
              from: 'NoVo <orders@novo-aitrading.app>',
              replyTo: 'support@novo-options.trade', to: [email],
              subject: 'No double-billing — duplicate bundle subscription cancelled',
              html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#1c1d21;color:#c2d2e6;padding:28px;border:1px solid #2e3036;border-radius:12px;line-height:1.65;">
                <h2 style="color:#eaf3ff;font-size:19px;margin:0 0 12px;">No charge &mdash; this would have billed you twice</h2>
                <p style="margin:0 0 12px;">You already hold a subscription that overlaps the <strong style="color:#eaf3ff;">${_isAll ? 'NoVo Complete bundle' : 'NoVo Analyst + Crypto bundle'}</strong> you just started, so we cancelled the new one${charged ? (refunded ? ' and refunded the charge to your card' : '') : ' before it charged you'}. Your existing access is unchanged.</p>
                <p style="margin:0 0 12px;">${_isAll ? 'Want to switch your current subscription to the Complete bundle? Just reply to this email and we’ll move you over without losing a day.' : 'If you were after the crypto half, the Crypto Market Map is available on its own — or reply and we’ll switch you to the Complete bundle.'}</p>
                <p style="margin:0;font-size:13px;color:#8aacc8;">Questions? <a href="mailto:support@novo-options.trade" style="color:#34d399;">support@novo-options.trade</a></p></div>`,
            });
          } catch (e) { console.error(`[webhook-sub] dupe-bundle notice failed: ${e.message}`); }
          return res.status(200).json({ received: true, duplicate_tier: true });
        }
      } catch (e) { console.error(`[webhook-sub] bundle conflict guard failed (non-fatal): ${e.message}`); }

      // TRIAL-ONCE (bundle_ac only — bundle_all carries no trial): same KV gate as Analyst,
      // same key on purpose. An email that already burned its 7-day Analyst trial does not
      // get a second one by adding $40 of crypto to the cart.
      if (!_isAll) {
        try {
          const _kv = require('./_kv').kv();
          if (_kv) {
            const _prevSub = await _kv.get('analyst_trialed:' + email);
            if (!_prevSub) {
              await _kv.set('analyst_trialed:' + email, obj.subscription);
            } else if (_prevSub !== obj.subscription) {
              const _s = await stripe.subscriptions.retrieve(obj.subscription);
              if (_s.status === 'trialing') {
                await stripe.subscriptions.update(obj.subscription, { trial_end: 'now' });
                console.log(`[webhook-sub] repeat trial via bundle_ac by ${email} — trial ended, sub ${obj.subscription}`);
              }
            }
          }
        } catch (e) { console.error(`[webhook-sub] bundle trial-once check failed (non-fatal): ${e.message}`); }
      }

      // UPGRADE PATH: the bundle supersedes any standalone subs it contains. Complete also
      // supersedes the AC bundle. Same trialing-cancel-now / active-run-out rules as the
      // Trader upgrade path, same non-fatal posture.
      try {
        const retired = await retireTierSubs(email, obj.subscription,
          _isAll ? ['analyst', 'crypto', 'bundle_ac'] : ['analyst', 'crypto']);
        if (retired.length) console.log(`[webhook-sub] ${_tier} upgrade — retired: ${retired.join(', ')}`);
      } catch (e) { console.error(`[webhook-sub] bundle retire failed (non-fatal): ${e.message}`); }

      // Both audiences: the equity reads AND the crypto list. freeRemove for the same
      // reason as every paid tier. Welcome dedupe keys on the Analyst add like the Analyst
      // branch — a Stripe retry finds the contact already there and skips the re-send.
      const _r = await analystAdd(email);
      if (CRYPTO_AUDIENCE) {
        try { await _retry(() => resend.contacts.create({ audienceId: CRYPTO_AUDIENCE, email, unsubscribed: false }), 2); }
        catch (e) { if (!/exist|already/i.test(e.message || '')) console.error(`[webhook-sub] bundle crypto audience add failed: ${e.message}`); }
      }
      await freeRemove(email);
      if (!_r.existed) {
        try {
          await resend.emails.send({
            from: 'NoVo - AI Market Analyst <orders@novo-aitrading.app>',
            replyTo: 'support@novo-options.trade', to: [email],
            subject: _isAll ? 'Welcome to NoVo Complete — the whole desk' : 'Welcome to NoVo — Analyst + Crypto',
            html: (_isAll ? bundleAllWelcomeHtml : bundleAcWelcomeHtml)(`${SITE}/api/discord?cs=${obj.id}`),
          });
        } catch (err) { console.error(`[webhook-sub] bundle welcome failed (non-fatal): ${err.message}`); }
      }
      // New entitlements exist NOW — a stale cached deny must not outlive this event.
      await entCachePurge(email);
      console.log(`[webhook-sub] ${_tier} subscriber ${email}${_isAll ? ' — licence rides the Trader item' : ' — no licence'}`);
      return res.status(200).json({ received: true, tier: _tier });
    }

    // NoVo Crypto Market Map: its own product. No license, no provisioning, and NOT the
    // Analyst audience — a Crypto subscriber did not buy the SPY/QQQ/IWM read. Must sit
    // ABOVE the Trader path: falling through would provision a trading licence AND run the
    // "Trader includes Analyst" upgrade, which RETIRES the customer's paid Analyst sub.
    if (obj?.metadata?.tier === 'crypto') {
      // REVERSE-DUPLICATE GUARD (2026-09-01): a live sub already granting the Crypto Map —
      // a standalone Crypto sub or either bundle — means this purchase double-bills it.
      // Same cancel + auto-refund + notice shape as the Analyst guard below.
      try {
        if (await emailHasCryptoEnt(email, obj.subscription)) {
          let charged = true, refunded = false;
          try {
            const sub = await stripe.subscriptions.retrieve(obj.subscription);
            charged = sub.status !== 'trialing';
            await stripe.subscriptions.cancel(obj.subscription);
            if (charged) refunded = await _refundLatest(sub);
          } catch (e) { console.error(`[webhook-sub] dupe-crypto cancel/refund failed: ${e.message}`); }
          console.log(`[webhook-sub] duplicate Crypto purchase by ${email} — cancelled ${obj.subscription} (charged=${charged}, refunded=${refunded})`);
          try {
            await resend.emails.send({
              from: 'NoVo <orders@novo-aitrading.app>',
              replyTo: 'support@novo-options.trade', to: [email],
              subject: 'You already have the Crypto Market Map — duplicate cancelled',
              html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#1c1d21;color:#c2d2e6;padding:28px;border:1px solid #2e3036;border-radius:12px;line-height:1.65;">
                <h2 style="color:#eaf3ff;font-size:19px;margin:0 0 12px;">No charge &mdash; you already have this</h2>
                <p style="margin:0 0 12px;">A subscription you already hold includes the <strong style="color:#eaf3ff;">Crypto Market Map</strong>, so we cancelled the duplicate you just started${charged ? (refunded ? ' and refunded the charge to your card' : '') : ' before it charged you'}. Your existing access is unchanged.</p>
                <p style="margin:0 0 12px;">${charged && !refunded ? 'If your card was charged for it, just reply to this email and we will refund it.' : 'You were not charged.'}</p>
                <p style="margin:0;font-size:13px;color:#8aacc8;">Questions? <a href="mailto:support@novo-options.trade" style="color:#34d399;">support@novo-options.trade</a></p></div>`,
            });
          } catch (e) { console.error(`[webhook-sub] dupe-crypto notice failed: ${e.message}`); }
          return res.status(200).json({ received: true, duplicate_tier: true });
        }
      } catch (e) { console.error(`[webhook-sub] crypto reverse-dupe guard failed (non-fatal): ${e.message}`); }
      // `existed` doubles as the retry guard: Stripe replays this event, and a duplicate contact
      // is the only durable signal we have that the welcome already went out (there is no license
      // row to check, the way the Analyst branch checks analystAdd().existed).
      let existed = false;
      if (CRYPTO_AUDIENCE) {
        try { await _retry(() => resend.contacts.create({ audienceId: CRYPTO_AUDIENCE, email, unsubscribed: false }), 2); }
        catch (e) {
          if (/exist|already/i.test(e.message || '')) existed = true;
          else console.error(`[webhook-sub] crypto audience add failed: ${e.message}`);
        }
      }
      if (!existed) {
        try {
          await resend.emails.send({
            from: 'NoVo - AI Market Analyst <orders@novo-aitrading.app>',   // hardcoded verified domain, same as the other tiers
            replyTo: 'support@novo-options.trade', to: [email],
            subject: 'Welcome to the NoVo Crypto Market Map',
            html: cryptoWelcomeHtml(`${SITE}/api/discord?cs=${obj.id}`),
          });
        } catch (err) { console.error(`[webhook-sub] crypto welcome failed (non-fatal): ${err.message}`); }
      }
      await entCachePurge(email);   // a pre-purchase cached deny must not outlive the purchase
      console.log(`[webhook-sub] Crypto Market Map subscriber ${email} — no license, no Analyst audience`);
      return res.status(200).json({ received: true, tier: 'crypto' });
    }

    // NoVo Analyst ($69 email tier): add to the Analyst audience + send its welcome, then STOP — no license,
    // no portal, no provisioning.
    if (obj?.metadata?.tier === 'analyst') {
      // REVERSE-DUPLICATE GUARD: they already hold Trader, which INCLUDES Analyst. Left alone this bills
      // $209 + $129 for one entitlement. Analyst opens on a 7-day trial, so cancelling here almost always
      // means they are never charged at all. Non-fatal: a failure must not block the normal Analyst flow.
      try {
        // A live Trader/Complete sub OR either bundle already includes Analyst (2026-09-01:
        // hasActiveTraderSub now answers per-item, which covers Complete; hasLiveBundle
        // covers the AC bundle, whose items are all "known" prices).
        const already = (await hasActiveTraderSub(email, obj.subscription))
          || (await hasLiveBundle(email, obj.subscription));
        if (already) {
          let charged = true, refunded = false;
          try {
            const sub = await stripe.subscriptions.retrieve(obj.subscription);
            charged = sub.status !== 'trialing';                 // trialing => no money moved
            await stripe.subscriptions.cancel(obj.subscription);
            if (charged) refunded = await _refundLatest(sub);    // auto-refund the rare charged duplicate
          } catch (e) { console.error(`[webhook-sub] dupe-analyst cancel/refund failed: ${e.message}`); }
          console.log(`[webhook-sub] duplicate Analyst purchase by active Trader sub ${email} — cancelled ${obj.subscription} (charged=${charged})`);
          try {
            await resend.emails.send({
              from: 'NoVo <orders@novo-aitrading.app>',
              replyTo: 'support@novo-options.trade', to: [email],
              subject: 'You already have NoVo Analyst — duplicate subscription cancelled',
              html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#1c1d21;color:#c2d2e6;padding:28px;border:1px solid #2e3036;border-radius:12px;line-height:1.65;">
                <h2 style="color:#eaf3ff;font-size:19px;margin:0 0 12px;">No charge — you already have this</h2>
                <p style="margin:0 0 12px;">A subscription you already hold &mdash; <strong style="color:#eaf3ff;">NoVo Trader</strong> or one of the bundles &mdash; already includes everything in <strong style="color:#eaf3ff;">NoVo Analyst</strong>: the live dealer dashboard, the daily Open and Close desk notes, and the Sunday Week Ahead.</p>
                <p style="margin:0 0 12px;">So we cancelled the duplicate Analyst subscription you just started${charged ? '' : ' before it charged you'}. Nothing changes about your Trader access.</p>
                <p style="margin:0 0 12px;">${charged ? (refunded ? 'Any charge for it has been refunded to your card.' : 'If your card was charged for it, just reply to this email and we will refund it.') : 'You were not charged.'}</p>
                <p style="margin:0;font-size:13px;color:#8aacc8;">Questions? <a href="mailto:support@novo-options.trade" style="color:#34d399;">support@novo-options.trade</a></p></div>`,
            });
          } catch (e) { console.error(`[webhook-sub] dupe-analyst notice failed: ${e.message}`); }
          return res.status(200).json({ received: true, duplicate_tier: true });
        }
      } catch (e) { console.error(`[webhook-sub] reverse-dupe guard failed (non-fatal): ${e.message}`); }

      // TRIAL-ONCE (audit 2026-07-20): the Analyst checkout mints a fresh Stripe customer every time (anonymous
      // checkout, no customer passed), so Stripe's own one-trial-per-customer never applies — an email could
      // cancel before day 7 and re-subscribe for an endless chain of free 7-day trials. Gate it ourselves: the
      // FIRST Analyst sub per email keeps its trial; a later one whose email ALREADY trialed has its trial ended
      // immediately (converts to paid — they entered a card at checkout). Keyed by sub id so a Stripe RETRY of
      // this same event is a no-op, never a wrongful charge. Fails open (KV down → trial kept) — never over-charges.
      try {
        const _kv = require('./_kv').kv();
        if (_kv) {
          const _prevSub = await _kv.get('analyst_trialed:' + email);
          if (!_prevSub) {
            await _kv.set('analyst_trialed:' + email, obj.subscription);
          } else if (_prevSub !== obj.subscription) {
            const _s = await stripe.subscriptions.retrieve(obj.subscription);
            if (_s.status === 'trialing') {
              await stripe.subscriptions.update(obj.subscription, { trial_end: 'now' });
              console.log(`[webhook-sub] repeat Analyst trial by ${email} — trial ended (converts to paid), sub ${obj.subscription}`);
            }
          }
        }
      } catch (e) { console.error(`[webhook-sub] analyst trial-once check failed (non-fatal): ${e.message}`); }

      const _r = await analystAdd(email);
      await freeRemove(email);   // paid now → off the free list (Weekly + articles reach them via the Analyst broadcasts)
      if (!_r.existed) {         // skip re-welcoming on a Stripe retry of the same event (they were already added)
        try {
          await resend.emails.send({
            from: 'NoVo - AI Market Analyst <orders@novo-aitrading.app>',   // hardcoded verified domain — a bad FROM_EMAIL env 403s + silently kills sends
            replyTo: 'support@novo-options.trade', to: [email],
            subject: 'Welcome to NoVo Analyst', html: analystWelcomeHtml(`${SITE}/api/discord?cs=${obj.id}`),
          });
        } catch (err) { console.error(`[webhook-sub] analyst welcome failed (non-fatal): ${err.message}`); }
      }
      await entCachePurge(email);
      return res.status(200).json({ received: true });
    }

    // SAME-TIER DUPLICATE GUARD: this email already holds ANOTHER active Trader sub. checkout-sub.js is an
    // anonymous checkout (no customer passed), so Stripe mints a fresh customer + sub every time — an
    // already-active Trader who clicks Subscribe again (or a double-fire) is billed a SECOND $209 for one
    // instance. Cancel the duplicate + notify. Mirrors the Analyst reverse-dupe guard above. Non-fatal.
    try {
      if (await hasActiveTraderSub(email, obj.subscription)) {
        let charged = true, refunded = false;
        try {
          const sub = await stripe.subscriptions.retrieve(obj.subscription);
          charged = sub.status !== 'trialing';
          await stripe.subscriptions.cancel(obj.subscription);
          // Cancelling does NOT refund the just-captured invoice — auto-refund it so a double-subscribe never
          // leaves the customer out $209 pending a manual support refund (audit 2026-07-20).
          if (charged) refunded = await _refundLatest(sub);
        } catch (e) { console.error(`[webhook-sub] dupe-trader cancel/refund failed: ${e.message}`); }
        console.log(`[webhook-sub] duplicate Trader purchase by active Trader ${email} — cancelled ${obj.subscription} (charged=${charged}, refunded=${refunded})`);
        try {
          await resend.emails.send({
            from: 'NoVo <orders@novo-aitrading.app>',
            replyTo: 'support@novo-options.trade', to: [email],
            subject: 'You already have NoVo Trader — duplicate subscription cancelled',
            html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#1c1d21;color:#c2d2e6;padding:28px;border:1px solid #2e3036;border-radius:12px;line-height:1.65;">
              <h2 style="color:#eaf3ff;font-size:19px;margin:0 0 12px;">No charge — you already have NoVo Trader</h2>
              <p style="margin:0 0 12px;">You already have an active <strong style="color:#eaf3ff;">NoVo Trader</strong> subscription, so we cancelled the duplicate you just started${charged ? (refunded ? ' and refunded the charge to your card' : '') : ' before it charged you'}. Your existing access is unchanged.</p>
              <p style="margin:0 0 12px;">${charged ? 'If your card was charged for it, just reply to this email and we will refund it.' : 'You were not charged.'}</p>
              <p style="margin:0;font-size:13px;color:#8aacc8;">Questions? <a href="mailto:support@novo-options.trade" style="color:#34d399;">support@novo-options.trade</a></p></div>`,
          });
        } catch (e) { console.error(`[webhook-sub] dupe-trader notice failed: ${e.message}`); }
        return res.status(200).json({ received: true, duplicate_tier: true });
      }
    } catch (e) { console.error(`[webhook-sub] trader reverse-dupe guard failed (non-fatal): ${e.message}`); }

    // Trader INCLUDES Analyst — add the Trader subscriber to the Analyst email audience too, so they receive
    // the Open / Close / Week Ahead reads + intraday alerts. (Their paid-Discord role is granted on connect
    // via /api/discord, which already accepts any paid sub — Analyst OR Trader.)
    await analystAdd(email);
    await freeRemove(email);   // paid now → off the free list (Weekly + articles reach them via the Analyst broadcasts)

    // UPGRADE PATH: retire any Analyst sub this email holds. Trader includes Analyst, so leaving it running
    // billed the customer $129 + $209 = $278/mo for one entitlement. Non-fatal.
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
        replyTo: 'support@novo-options.trade',
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
    await entCachePurge(email);   // a pre-purchase cached deny (ent:trader:) must not outlive the purchase
  }

  // ── Monthly renewal payment succeeded → re-activate if suspended ─────────
  else if (event.type === 'invoice.payment_succeeded') {
    const subscriptionId = invoiceSubId(obj);
    // Reactivate on ANY successful invoice payment (not just billing_reason ===
    // 'subscription_cycle') — a recovered past-due payment can carry a different
    // reason, and gating on it could leave a paying customer suspended forever.
    // activateSub is idempotent: a no-op on the initial create / already-active keys,
    // and the license row may not exist yet on the very first invoice (404, swallowed).
    if (subscriptionId && (await subIdHasLicense(subscriptionId))) {  // Analyst AND Crypto subs have no license to activate
      try {
        await activateSub(subscriptionId);
      } catch (err) {
        // A 404 is the benign first-invoice case (license row not provisioned yet — nothing to reactivate): ack
        // and move on. But a TRANSIENT failure (5xx / network) must NOT be swallowed, or a paying customer who
        // recovered a past-due payment stays suspended until the next monthly invoice — reconcile-subs.js has no
        // reactivate path. Release the claim + 500 so Stripe retries, exactly like the suspend path below.
        const _benign404 = /→\s*404$/.test(err.message || '');
        console.error(`[webhook-sub] Activate failed — sub:${subscriptionId} error:${err.message}${_benign404 ? ' (404 benign first-invoice, acking)' : ' (transient, will retry)'}`);
        if (!_benign404) {
          if (event.id) await releaseClaim('stripe_evt:sub:' + event.id);
          return res.status(500).json({ error: 'activate failed, will retry' });
        }
      }
    }
  }

  // ── Payment failed → suspend access ──────────────────────────────────────
  else if (event.type === 'invoice.payment_failed') {
    const subscriptionId = invoiceSubId(obj);
    if (subscriptionId && (await subIdHasLicense(subscriptionId))) {  // Analyst AND Crypto subs have no license to suspend
      try {
        await suspendSub(subscriptionId);
      } catch (err) {
        console.error(`[webhook-sub] Suspend failed — sub:${subscriptionId} error:${err.message}`);
        // Release the idempotency claim + return 500 so Stripe RETRIES — else this suspend is permanently lost
        // (the event was claimed above) and a delinquent keeps access until the daily reconcile. Idempotent.
        if (event.id) await releaseClaim('stripe_evt:sub:' + event.id);
        return res.status(500).json({ error: 'suspend failed, will retry' });
      }
    }
  }

  // ── Subscription cancelled → revoke access ────────────────────────────────
  // COMPOSED per product flag (2026-09-01), not an else-if chain: a bundle sub is Analyst
  // AND Crypto (bundle_ac), or licensed AND Crypto (bundle_all), and the old chain ran only
  // its first match — an AC-bundle cancel would have cleaned the Analyst side and left the
  // member on the crypto audience forever. Each cleanup runs iff its flag is set, each
  // behind its own "does anything else still grant this" guard. Single-product subs take
  // exactly the same actions they always did.
  else if (event.type === 'customer.subscription.deleted') {
    const subscriptionId = obj?.id;
    if (subscriptionId) {
      const isA = subIsAnalyst(obj), isC = subIsCrypto(obj), isL = subHasLicense(obj);
      try {
        // License teardown first — the control plane must never keep an engine running on a
        // dead subscription, whatever else this sub also carried.
        if (isL) await cancelSub(subscriptionId);

        const cust = obj.customer ? await stripe.customers.retrieve(obj.customer) : null;
        // Crypto audience: removed only when NO remaining live sub still grants the map
        // (a member cancelling a standalone Crypto sub while holding a bundle stays).
        if (isC && CRYPTO_AUDIENCE && cust?.email
            && !(await emailHasCryptoEnt(cust.email, subscriptionId))) {
          try { await _retry(() => resend.contacts.remove({ audienceId: CRYPTO_AUDIENCE, email: cust.email }), 2); } catch (_) {}
        }
        // Analyst audience + free list + Discord role: same coarse guard as always — any
        // other live paid sub keeps everything.
        if (!(await hasOtherActivePaidSub(cust?.email, subscriptionId))) {
          await discordRevokeRole(cust?.metadata?.discord_id);
          if (isA || isL) {
            await analystRemove(cust?.email);
            await freeAdd(cust?.email);   // revert to a free member (keeps the Weekly + articles)
          }
        }
        await entCachePurge(cust?.email);   // a cancelled member must not coast on a cached allow
        console.log(`[webhook-sub] cancel cascade — sub:${subscriptionId} analyst=${isA} crypto=${isC} license=${isL}`);
      } catch (err) {
        // Release the claim + 500 so Stripe retries the whole idempotent cleanup — a swallowed
        // failure here left a cancelled member with a paid role indefinitely (no Discord reconciler).
        console.error(`[webhook-sub] cancel cascade failed — sub:${subscriptionId} error:${err.message}`);
        if (event.id) await releaseClaim('stripe_evt:sub:' + event.id);
        return res.status(500).json({ error: 'cancel side-effects failed, will retry' });
      }
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

  // ── Chargeback or full money-back refund → REVOKE access (audit 2026-07-20) ────────────────────────────
  // Neither a card dispute nor the 7-day money-back refund used to touch entitlement (it keyed only on
  // subscription STATUS), so a disputer/refundee kept the Analyst dashboard + Trader engine while the money was
  // clawed back. Resolve the customer and cancel their live sub(s); the customer.subscription.deleted cascade
  // above then revokes the Resend audience / Discord role and tells the control-plane to tear the engine down.
  // Partial refunds are ignored. (Requires charge.dispute.created + charge.refunded enabled on the Stripe endpoint.)
  else if (event.type === 'charge.dispute.created' || event.type === 'charge.refunded') {
    try {
      const fullRefund = event.type === 'charge.refunded'
        ? (Number(obj.amount || 0) > 0 && Number(obj.amount_refunded || 0) >= Number(obj.amount || 0))
        : true;   // a dispute always revokes
      if (fullRefund) {
        const customerId = await _customerFromChargeEvent(event.type, obj);
        if (customerId) {
          const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
          let n = 0;
          for (const s of subs.data) {
            if (['active', 'trialing', 'past_due', 'unpaid'].includes(s.status)) {
              try { await stripe.subscriptions.cancel(s.id); n++; }
              catch (e) { console.error(`[webhook-sub] revoke-cancel ${s.id} failed: ${e.message}`); }
            }
          }
          console.log(`[webhook-sub] ${event.type} for ${customerId} — cancelled ${n} live sub(s), access revoked`);
        }
      }
    } catch (err) {
      console.error(`[webhook-sub] dispute/refund revoke failed: ${err.message}`);
      if (event.id) await releaseClaim('stripe_evt:sub:' + event.id);
      return res.status(500).json({ error: 'dispute/refund revoke failed, will retry' });
    }
  }

  return res.status(200).json({ received: true });
};

handler.config = { api: { bodyParser: false } };
module.exports = handler;
