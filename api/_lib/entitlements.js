// api/_lib/entitlements.js — "what has this member actually bought?", answered once.
//
// WHY A TRI-STATE, and it is the whole reason this module exists rather than a boolean helper.
// The same question has two correct failure answers depending on who is asking:
//
//   * A PAYWALL asking "may I serve the live equity feed?" must fail CLOSED. If Stripe is
//     unreachable, the safe answer is no — a paid product must not open on an outage.
//   * A MARKETING surface asking "should I pitch the bundle?" must fail OPEN. If Stripe is
//     unreachable, the safe answer is silence — showing a paying Analyst subscriber an advert
//     for something they already own, because our own dependency was down, is worse than
//     missing one upsell.
//
// A boolean forces those two into one posture and gets one of them wrong. So this returns
// 'allow' | 'deny' | 'unknown' and lets each caller decide what 'unknown' means to it. The
// decision logic and the price sets are shared; only the interpretation differs.
//
// NOTE ON DUPLICATION, deliberately recorded rather than quietly left: analyst-publish.js still
// carries its own _analystEnt with identical decision logic, and crypto-map.js / trader-live.js
// carry sibling walks for their own products. Consolidating all four onto this module is the
// right end state and was scoped, but it means editing a LIVE paywall, which was outside the
// change that was approved here. Whoever next touches analyst-publish.js should delete its copy
// and call analystEntitlement() with a fail-closed reading of 'unknown'.
//
// The Stripe SDK is required lazily INSIDE the lookup: this module is imported by the chat
// endpoint, which does not otherwise carry Stripe in its module graph, and a top-level require
// would put it in every cold start including the many requests that never reach a live check.

const crypto = require("crypto");
const { kv } = require("../_kv.js");

// Price ids, mirroring the sets the rest of the stack already agrees on. Env wins; the literals
// keep a dropped variable from silently reclassifying a paying member. Superseded prices are
// KEPT — price-for-life means an old id is never archived and never removed from a set.
const ANALYST_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_ANALYST, process.env.STRIPE_PRICE_ANALYST_YEARLY,
  "price_1TugYAApyfMAkbeEarl2ULSv", "price_1TugYAApyfMAkbeE9c3Rdypj",   // $129 / $1,290 legacy
  "price_1U59pFApyfMAkbeEhEDpToGK", "price_1U59pFApyfMAkbeEDzNHEJbD",   // $129 / $1,290
  "price_1U8R0NB1Bq29OALa7evMqazz", "price_1U8R2PB1Bq29OALaUv2W6VAm",   // $129 / $1,290 LLC acct
].filter(Boolean));

const CRYPTO_PRICE_IDS = new Set([
  process.env.STRIPE_PRICE_CRYPTO, process.env.STRIPE_PRICE_CRYPTO_YEARLY,
  "price_1U9EU0B1Bq29OALajbT8DWJS", "price_1U9EUsB1Bq29OALaYh2QODHA",   // $79 / $790
  process.env.STRIPE_PRICE_CRYPTO_BUNDLE_AC, process.env.STRIPE_PRICE_CRYPTO_BUNDLE_AC_YEARLY,
  process.env.STRIPE_PRICE_CRYPTO_BUNDLE_ALL, process.env.STRIPE_PRICE_CRYPTO_BUNDLE_ALL_YEARLY,
  "price_1UB0ZhB1Bq29OALa8iLZSSL5", "price_1UB0ZhB1Bq29OALamNjyA6Y9",   // $40/$400 beside Analyst
  "price_1UB0ZhB1Bq29OALaOw2hUHWS", "price_1UB0ZhB1Bq29OALaWQPTPOs7",   // $30/$300 beside Trader
].filter(Boolean));

const LIVE = ["active", "trialing", "past_due"];

const _isAnalystPrice = (s) => {
  if (s?.metadata?.tier === "analyst") return true;
  try { return (s?.items?.data || []).some((it) => ANALYST_PRICE_IDS.has(it?.price?.id)); }
  catch (_) { return false; }
};
const _isCryptoPrice = (s) => {
  if (s?.metadata?.tier === "crypto") return true;
  try { return (s?.items?.data || []).some((it) => CRYPTO_PRICE_IDS.has(it?.price?.id)); }
  catch (_) { return false; }
};

// Grants Analyst: an Analyst sub, either bundle, or a Trader/licence sub — an item that is
// neither an Analyst nor a Crypto price IS the Trader item, and Trader includes Analyst.
// Identical to analyst-publish.js's _subGrantsAnalyst; kept in step deliberately.
function subGrantsAnalyst(s) {
  if (_isAnalystPrice(s)) return true;
  const t = String(s?.metadata?.tier || "");
  if (t === "bundle_ac" || t === "bundle_all") return true;
  if (t === "crypto") return false;
  try {
    const items = (s?.items?.data || []).filter((it) => it?.price?.id);
    if (items.length) {
      return items.some((it) => !ANALYST_PRICE_IDS.has(it.price.id) && !CRYPTO_PRICE_IDS.has(it.price.id));
    }
  } catch (_) {}
  return !_isCryptoPrice(s);   // thin object: not crypto = the historical "member" answer
}

/**
 * 'allow'   — this email holds something that includes NoVo Analyst (Analyst, Trader, either bundle, or a comped seat)
 * 'deny'    — checked, and it does not (the crypto-only case this exists to find)
 * 'unknown' — could not determine: no email, no Stripe configured, or Stripe threw
 *
 * Shares the KV verdict cache with the ?live/?hist gate ('ent:analyst:' + sha256(email)[:24],
 * allow 600s / deny 120s) so the two surfaces cannot disagree about the same member, and so a
 * checkout or cancellation purging that key clears both at once (webhook-sub.js entCachePurge).
 * 'unknown' is never cached — it is a statement about our own availability, not about them.
 */
async function analystEntitlement(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return "unknown";

  try { if (require("./comp.js").isComp(norm)) return "allow"; } catch (_) {}

  const r = kv();
  const ck = "ent:analyst:" + crypto.createHash("sha256").update(norm).digest("hex").slice(0, 24);
  if (r) {
    try {
      const cached = await r.get(ck);
      if (cached === "1") return "allow";
      if (cached === "0") return "deny";
    } catch (_) { /* cache unreadable — fall through to a live check */ }
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return "unknown";                 // not configured is not a verdict about the member

  let ok = false;
  try {
    const stripe = require("stripe")(key);    // lazy: keeps Stripe out of the chat's cold start
    const seen = new Set();
    const hit = async (custId) => {
      const subs = await stripe.subscriptions.list({ customer: custId, status: "all", limit: 20 });
      return subs.data.some((s) => LIVE.includes(s.status) && subGrantsAnalyst(s));
    };
    try {
      // Search first: its email index is case-insensitive, and Stripe customers are routinely
      // stored with different casing than the address someone signs in with.
      const sr = await stripe.customers.search({ query: `email:"${norm.replace(/"/g, "")}"`, limit: 20 });
      for (const c of sr.data) { seen.add(c.id); if (await hit(c.id)) { ok = true; break; } }
    } catch (_) { /* search index warming up — list() below still covers it */ }
    if (!ok) {
      const custs = await stripe.customers.list({ email: norm, limit: 100 });
      for (const c of custs.data) { if (!seen.has(c.id) && await hit(c.id)) { ok = true; break; } }
    }
  } catch (e) {
    console.error("[entitlements] analyst lookup:", e.message);
    return "unknown";                         // the caller decides what that means to it
  }

  if (r) { try { await r.set(ck, ok ? "1" : "0", { ex: ok ? 600 : 120 }); } catch (_) {} }
  return ok ? "allow" : "deny";
}

module.exports = { analystEntitlement, subGrantsAnalyst, ANALYST_PRICE_IDS, CRYPTO_PRICE_IDS };
