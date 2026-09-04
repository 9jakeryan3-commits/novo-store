// api/health.js — what is silently degraded right now.
//
// WHY THIS EXISTS. A cluster of protections in this codebase FAIL OPEN when Upstash KV is absent,
// and every one of them is correct to do so: a KV outage must not drop a Stripe webhook, refuse a
// paying member, or break a checkout. But fail-open has a property nobody planned for — it is
// INVISIBLE. With KV unset the system does not degrade loudly, it degrades silently and looks
// completely healthy:
//
//   webhook idempotency (claimOnce)  — a Stripe retry can re-run a side effect
//   distributed rate limits (rateOk) — every /api cap falls back to per-lambda counting, which on
//                                      Vercel means effectively no cap at all
//   the analyst trial gate           — 'analyst_trialed:' can no longer remember a used trial
//   entitlement caches               — every gate re-walks Stripe on every request
//   the upsell cooldown              — the once-per-6h pitch becomes once-per-question
//
// Nothing errors. Nothing logs. The only symptom is a bill, a double-charge, or an advert shown
// eleven times — all discovered downstream, from the damage rather than the cause. This endpoint
// is the missing signal, and it changes nothing about the behaviour: the fail-open stays exactly
// as designed, it is just no longer unobservable.
//
// SAFE TO BE PUBLIC. Booleans and names only — never a key, never a price id, never a count of
// customers or revenue. "Is KV configured" is not a secret; the token is, and it is not here.
// Deliberately does not touch Stripe: a health check that costs an API call on every scrape is a
// liability, and Stripe reachability is not what this is for.

const { kv, kvReady } = require('./_kv.js');

// ACCOUNT-SIDE PRICE AUDIT, HOURLY BEHIND KV (Jake's go, 09-04). The header's "deliberately does
// not touch Stripe" rule stands for the SCRAPE path: at most one prices.list per hour, cached; a
// scrape never pays for Stripe and never depends on it (failure -> ok:null, not degraded).
// Public payload carries counts + the scope sentence ONLY - drift ids go to server logs, per the
// "never a price id" charter above.
const ACCT_KV_KEY = 'health:acct-audit';
const ACCT_SCOPE = 'every active billing-account price is classified or deliberately Trader-by-exclusion; does NOT prove a checkout handler uses the right id';
async function acctAudit() {
  const r = kv();
  if (r) {
    try {
      const hit = await r.get(ACCT_KV_KEY);
      const j = typeof hit === 'string' ? JSON.parse(hit) : hit;
      if (j && j.checked_at && Date.now() - j.checked_at < 3600_000) return j;
    } catch (_) {}
  }
  let out;
  try { out = await require('./_lib/entitlements.js').auditAccountPrices(); }
  catch (e) { out = { ok: null, error: String(e.message || e).slice(0, 120), checked_at: Date.now() }; }
  if (r && out) { try { await r.set(ACCT_KV_KEY, JSON.stringify(out), { ex: 86400 }); } catch (_) {} }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Never cache a health check: a cached "ok" is worse than no health check at all, because it
  // outlives the condition it describes. This is the one endpoint here that must say max-age=0 —
  // and note it does NOT say `public`, which on this platform is the token that would strip the
  // lifetime and reintroduce heuristic caching (see api/levels.js).
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const kvUp = kvReady();

  // The drift checks. Both report rather than throw, and both are wrapped: a health endpoint that
  // 500s because a self-check threw is reporting on itself instead of on the system.
  let prices = { ok: null }, tools = { ok: null };
  try { prices = require('./_lib/entitlements.js').auditPriceSets(); } catch (e) { prices = { ok: false, error: e.message }; }
  try { tools = require('./_lib/upsell.js').auditToolSets(); } catch (e) { tools = { ok: false, error: e.message }; }

  let salesPaused = false;
  try { salesPaused = require('./_lib/sales-gate.js').salesPaused(); } catch (_) {}

  const acct = await acctAudit();

  const degraded = [];
  if (!kvUp) degraded.push('kv');
  if (acct && acct.ok === false) degraded.push('account-prices');
  if (prices.ok === false) degraded.push('price-sets');
  if (tools.ok === false) degraded.push('tool-sets');

  return res.status(200).json({
    ok: degraded.length === 0,
    degraded,
    // WHICH BUILD IS ACTUALLY SERVING. Vercel populates these for a git-linked project even with
    // auto-deploy disabled, which this project is. Reported because deploy.sh could not previously
    // answer the question: its post-deploy check compares live `/` against public/index.html, so
    // for an api-only deploy it matched BEFORE the deploy too and "OK production serves <sha>"
    // asserted something it had not tested. A build stamp the deployment itself carries is the
    // only self-evident answer — everything else is inference from a file that may not have moved.
    // null when unavailable, and the caller must treat null as "unknown", never as "matches".
    build: {
      sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
      ref: process.env.VERCEL_GIT_COMMIT_REF || null,
      env: process.env.VERCEL_ENV || null,
    },
    // The switch's real state, server-side. The marketing pages carry their own copy of this as a
    // compiled-in const, so this is the only place the ACTUAL answer can be read.
    sales_paused: salesPaused,
    kv: {
      configured: kvUp,
      // Named so the consequence is readable without opening the source. These are the protections
      // that quietly stop protecting when `configured` is false — all by design, none by accident.
      fails_open_without_it: kvUp ? [] : [
        'stripe-webhook-idempotency', 'distributed-rate-limits',
        'analyst-trial-gate', 'entitlement-caches', 'upsell-cooldown',
      ],
    },
    // Hand-maintained sets that a future edit can silently outgrow. Names only, never values.
    drift: {
      price_sets: prices,
      tool_sets: tools,
      account_prices: acct ? { ok: acct.ok, active: acct.active ?? null,
                               drift_count: acct.drift_count ?? null,
                               checked_at: acct.checked_at ?? null,
                               error: acct.error ?? undefined, scope: ACCT_SCOPE } : null,
    },
    stripe_configured: !!process.env.STRIPE_SECRET_KEY,
  });
};
