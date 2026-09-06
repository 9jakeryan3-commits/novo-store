// api/x-mentions.js — the ONE way anything outside this repo gets X data.
//
// WHY AN ENDPOINT RATHER THAN A SECOND FETCHER. The client in _lib/x-client.js is the single home
// for the query construction, the rankability gate and the guardrail. Everything that wants X and
// cannot `require` that file — the crypto collector (Python, on Railway), the engine's reports —
// would otherwise grow its own fetcher, and two fetchers means two query constructions, two
// baselines and two homes for the guardrail. They drift. That failure hit this repo three times in
// one day before the client existed, and it has hit the X client TWICE MORE since:
//
//   * the in-progress hour was ranked against complete ones, which INVERTED the order of the
//     busiest names (TSLA at the 0.6th percentile below IWM)
//   * the allowlisted quote query ANDed a cashtag with wire accounts, and was therefore dead on
//     SPY, QQQ and IWM — 100% of the covered universe — while looking perfectly healthy
//
// Neither would have been caught once if the logic had lived in two places. So: one client, and
// this endpoint is how the other languages reach it.
//
// ── THE RATE BUDGET IS REAL AND IT IS ENFORCED HERE, NOT REQUESTED OF CALLERS ──────────────────
// Xavier's objection to per-poll X calls was correct arithmetic: 91 coins on an 8-minute cadence is
// not a free query pattern, and Timmy's dealer map polls every 15 seconds PER MEMBER. A convention
// ("please cache") is not a mechanism. The KV cache below is the mechanism: every caller shares one
// cached answer per symbol, so N members polling a surface cost the same as one.
//
// The TTL is 5 minutes against HOURLY buckets. That is deliberately conservative rather than tuned
// — the ranked figure only changes once an hour, so a longer TTL would be defensible, but the
// in-progress fragment moves continuously and 5 minutes keeps it honest without spending quota.
//
// ── WHAT THIS ENDPOINT WILL NOT DO ────────────────────────────────────────────────────────────
// It does not score sentiment, and no caller may add one on top. A percentile of mention VOLUME is
// a measurement with a denominator you can check; "sentiment is 72% bullish" is a number nobody
// can check, and inventing one is the fabrication class our record guards exist to stop.
//
// It is NOT PUBLIC. X quota is a real cost and this is an internal capability, so it is gated on
// the shared secret the engine already holds. A public X proxy is a free way for anyone to spend
// our rate limit.

const { kv } = require('./_kv.js');
const x = require('./_lib/x-client.js');

const CACHE_TTL_S = 300;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Gate first, before any work and before any X call — an unauthenticated request must not be
  // able to spend quota or warm a cache.
  const secret = process.env.ANALYST_PUBLISH_SECRET;
  if (!secret || req.headers['x-novo-key'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Never edge-cached: the answer is per-caller-secret and the KV cache below is the shared layer.
  res.setHeader('Cache-Control', 'no-store');

  const symbol = String((req.query && req.query.symbol) || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const free = String((req.query && req.query.q) || '');
  if (!symbol && !free) return res.status(400).json({ error: 'symbol or q required' });

  if (!x.hasToken()) {
    // Distinct from "quiet": a missing credential must never render as low chatter.
    return res.status(200).json({ ok: false, reason: 'x_not_configured',
      note: 'X_BEARER_TOKEN is not set - this is a configuration state, NOT a quiet tape' });
  }

  const wantPosts = String((req.query && req.query.posts) || '') === '1';
  /* buckets=1 returns the COMPLETE hourly series so a caller can PERSIST it past X's rolling
     7-day window. Declared here, beside wantPosts and BEFORE the cache read below, because the
     cache decision consults it — the first version declared it further down next to the fetch and
     the cache block threw a temporal-dead-zone ReferenceError on every request. Never served from
     the summary cache: a caller that asked for buckets and got a cached summary would store
     nothing and log a success. */
  const wantBuckets = String((req.query && req.query.buckets) || '') === '1';
  const tiers = String((req.query && req.query.tiers) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const key = `x:vol:${symbol || 'q:' + free}`;

  const r = kv();
  if (!wantPosts && !wantBuckets && r) {
    try {
      const hit = await r.get(key);
      const parsed = typeof hit === 'string' ? JSON.parse(hit) : hit;
      if (parsed) return res.status(200).json(Object.assign({ ok: true, cached: true }, parsed));
    } catch (_) { /* a cold or broken cache costs a call, never an error */ }
  }

  const volume = await x.mentionVolume(symbol || null, free || null,
    wantBuckets ? { includeBuckets: true } : undefined);
  const out = { symbol: symbol || null, query: free || null, volume: volume };

  if (wantPosts) {
    /* Posts are ALWAYS allowlisted from here. This endpoint is how other languages reach X, and a
       caller in another repo cannot be relied on to pass the flag that stops NoVo quoting an
       impersonator — @DeItaone has a live homoglyph twin. Not a default: a rule. */
    out.posts = await x.recentPosts(symbol || null, free || null, 10,
      { allowlistOnly: true, tiers: tiers.length ? tiers : undefined });
  }

  // Only the volume answer is cached. Posts are not: they are what a reader SEES, and serving a
  // five-minute-old catalyst as current is the staleness failure the whole product argues against.
  if (!wantPosts && !wantBuckets && r && volume && !volume.error) {
    try { await r.set(key, JSON.stringify(out), { ex: CACHE_TTL_S }); } catch (_) {}
  }

  return res.status(200).json(Object.assign({ ok: true, cached: false }, out));
};
