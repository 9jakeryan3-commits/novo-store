// api/datapoints.js — the PUBLIC live data-point counter.
//
// The number is real: the engine counts its own stores every ~5 minutes — the 2008-to-today
// options-chain archive, the crypto collector's database, the intelligence stores, redis — and
// publishes the total together with the growth rate MEASURED between consecutive counts. This
// endpoint just serves that record; the /ai page ticks the display forward at the published rate
// between polls and re-anchors on every fetch. Nothing here invents motion: until the engine has
// two counts to diff, per_sec is null and the page shows a static figure.
//
// Public on purpose — it is a count of how much data exists, not the data.

const { kv } = require('./_kv.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  const r = kv();
  if (!r) return res.status(200).json({ ok: false });
  let d = null;
  try {
    d = await r.get('public:datapoints');
    if (typeof d === 'string') d = JSON.parse(d);
  } catch (_) { d = null; }
  if (!d || !d.total) return res.status(200).json({ ok: false });
  return res.status(200).json({ ok: true, total: d.total, per_sec: d.per_sec ?? null,
    crypto_per_hr: d.crypto_per_hr ?? null, ts: d.ts });
};
