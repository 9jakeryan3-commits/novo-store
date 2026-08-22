// api/vol.js — the public volatility record.
//
// Serves what the engine publishes from macro_history: VIX back to 1990, VIX9D to 2011, the
// VIX3M/VIX6M term structure, VXN, RVX, VVIX and CBOE SKEW — current level, percentile against
// the full daily history, and monthly closes for charting.
//
// FREE AND PUBLIC BY DESIGN. Every series here is a CBOE-published index. Nothing derived from
// the paid dealer map is in this payload — no levels, no walls, no flip — so there is no path
// for the thing being sold to leak through the thing being given away.

const { kv } = require('./_kv.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const r = kv();
    if (!r) return res.status(503).json({ ok: false, error: 'store unavailable' });
    const raw = await r.get('novo:vol');
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!d || !d.series) {
      return res.status(503).json({ ok: false, error: 'not published yet' });
    }

    // It updates once a session, so an hour of edge cache is generous and still same-day fresh.
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ ok: true, ...d });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
};
