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

const { kvReady } = require('./_kv.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Never cache a health check: a cached "ok" is worse than no health check at all, because it
  // outlives the condition it describes. This is the one endpoint here that must say max-age=0 —
  // and note it does NOT say `public`, which on this platform is the token that would strip the
  // lifetime and reintroduce heuristic caching (see api/levels.js).
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const kv = kvReady();

  // The drift checks. Both report rather than throw, and both are wrapped: a health endpoint that
  // 500s because a self-check threw is reporting on itself instead of on the system.
  let prices = { ok: null }, tools = { ok: null };
  try { prices = require('./_lib/entitlements.js').auditPriceSets(); } catch (e) { prices = { ok: false, error: e.message }; }
  try { tools = require('./_lib/upsell.js').auditToolSets(); } catch (e) { tools = { ok: false, error: e.message }; }

  let salesPaused = false;
  try { salesPaused = require('./_lib/sales-gate.js').salesPaused(); } catch (_) {}

  const degraded = [];
  if (!kv) degraded.push('kv');
  if (prices.ok === false) degraded.push('price-sets');
  if (tools.ok === false) degraded.push('tool-sets');

  return res.status(200).json({
    ok: degraded.length === 0,
    degraded,
    // The switch's real state, server-side. The marketing pages carry their own copy of this as a
    // compiled-in const, so this is the only place the ACTUAL answer can be read.
    sales_paused: salesPaused,
    kv: {
      configured: kv,
      // Named so the consequence is readable without opening the source. These are the protections
      // that quietly stop protecting when `configured` is false — all by design, none by accident.
      fails_open_without_it: kv ? [] : [
        'stripe-webhook-idempotency', 'distributed-rate-limits',
        'analyst-trial-gate', 'entitlement-caches', 'upsell-cooldown',
      ],
    },
    // Hand-maintained sets that a future edit can silently outgrow. Names only, never values.
    drift: {
      price_sets: prices,
      tool_sets: tools,
    },
    stripe_configured: !!process.env.STRIPE_SECRET_KEY,
  });
};
