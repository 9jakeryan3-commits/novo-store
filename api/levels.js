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
  return res.status(200).json({
    ok: true,
    asof: snap.asof || null,
    ageMinutes: ageMin,
    delayed: true,
    session: snap.session || null,
    tickers: snap.tickers,
  });
};
