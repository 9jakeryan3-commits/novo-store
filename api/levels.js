// api/levels.js — the FREE, deliberately-delayed dealer levels.
//
// Why this exists: call wall, put wall, gamma flip and expected move are no longer sellable
// on their own. AlgoStorm publishes all four with no login at all; GammaLens, GEX-Metrix,
// FlashAlpha and MenthorQ all have free tiers. A site that hides the commodity behind a
// paywall in 2026 just looks like it has less to show than the free tools.
//
// So NoVo gives the same four levels away — at the same freshness the free tools give them:
// DELAYED. What is actually sold is the 60-second refresh, the written read, and the alert
// when the level breaks. The levels are the demo; the cadence is the product.
//
// The delay is structural, not a promise. Two slots rotate:
//
//     live cycle  ->  [pending]  ->  [public]  ->  served here
//
// A snapshot only reaches `public` after passing through `pending`, and promotion happens at
// most once every DELAY_MIN minutes. So what is served is always between DELAY_MIN and
// 2*DELAY_MIN minutes old. There is no code path that can serve the current cycle, which
// matters more than a comment promising it won't: the paid product cannot be leaked by a
// bug in a filter, because the fresh data never enters this key.
//
// Written by api/analyst-publish.js on each live-state POST; read here.

const { kv } = require('./_kv.js');

const PUBLIC_KEY = 'public:levels';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const r = kv();
  if (!r) return res.status(200).json({ ok: false, tickers: [], note: 'levels unavailable' });

  // ?history=SPY — the same delayed levels, with a past. Written only when a snapshot is
  // promoted to public, so it is exactly as delayed as the live public slot and exposes
  // nothing new; it just stops the free tier being a single frozen frame.
  const wantHist = String((req.query && req.query.history) || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (wantHist) {
    let raw = [];
    try { raw = await r.lrange(`public:levels:hist:${wantHist}`, 0, 599); } catch (_) { raw = []; }
    const points = (raw || [])
      .map((x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch (_) { return null; } })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800');
    return res.status(200).json({ ok: true, ticker: wantHist, delayed: true, points });
  }

  // ?iv=SPY — IV rank and percentile against the ticker's own retained range.
  // NoVo's own computed ATM IV, ranked against NoVo's own history: no third-party feed,
  // and no dealer-map field. Returns nulls with a day count while the window is still short.
  const wantIv = String((req.query && req.query.iv) || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (wantIv) {
    let h = null;
    try { h = await r.hgetall(`iv:hist:${wantIv}`); } catch (_) { h = null; }
    const days = Object.entries(h || {})
      .map(([d, v]) => [d, Number(v)])
      .filter(([, v]) => Number.isFinite(v) && v > 0)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    if (days.length < 2) {
      return res.status(200).json({ ok: true, ticker: wantIv, atmIv: days.length ? days[days.length - 1][1] : null,
        ivRank: null, ivPercentile: null, days: days.length, note: 'building the window' });
    }
    const vals = days.map(([, v]) => v);
    const cur = vals[vals.length - 1];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const rank = hi > lo ? Math.round(((cur - lo) / (hi - lo)) * 1000) / 10 : null;
    const below = vals.filter((v) => v < cur).length;
    const pct = Math.round((below / vals.length) * 1000) / 10;
    return res.status(200).json({ ok: true, ticker: wantIv, atmIv: cur, ivRank: rank, ivPercentile: pct,
      low: lo, high: hi, days: vals.length });
  }

  let snap = null;
  try { snap = await r.get(PUBLIC_KEY); } catch (_) { snap = null; }
  if (typeof snap === 'string') { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
  if (!snap || !Array.isArray(snap.tickers)) {
    return res.status(200).json({ ok: false, tickers: [], note: 'no snapshot yet' });
  }

  const ageMin = snap.asof ? Math.max(0, Math.round((Date.now() - snap.asof) / 60000)) : null;

  // Cache at the edge for a minute. The data underneath only moves every 15, so this costs
  // nothing in freshness and takes the traffic off the function.
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=900');

  // The gamma flip and the expected move now ask for a FREE ACCOUNT (not a paywall -- the walls
  // and spot above are still open to anyone, and the doctrine at the top of this file still
  // holds: the levels are the demo, the cadence is the product).
  //
  // Stripping them from the PUBLIC payload is what makes that ask real. Leaving them here while
  // the page renders a lock would put the number one devtools tab away, which is not a gate --
  // it is a costume. The member portal sends the shared secret and gets the full object.
  const _full = req.headers['x-novo-key'] &&
    process.env.ANALYST_PUBLISH_SECRET &&
    req.headers['x-novo-key'] === process.env.ANALYST_PUBLISH_SECRET;
  const _tickers = _full ? snap.tickers : snap.tickers.map((t) => {
    const { flip, expectedMove, ...rest } = t || {};
    return rest;
  });
  if (!_full) res.setHeader('Vary', 'x-novo-key');

  return res.status(200).json({
    ok: true,
    asof: snap.asof || null,
    ageMinutes: ageMin,
    delayed: true,
    gated: _full ? undefined : ['flip', 'expectedMove'],
    session: snap.session || null,
    tickers: _tickers,
  });
};
