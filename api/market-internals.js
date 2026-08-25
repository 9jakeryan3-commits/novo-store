// api/market-internals.js — FINRA off-exchange short volume and index-mover earnings.
//
// What this serves, and why it is on a free page:
//
//   Both feeds are PUBLIC data. FINRA publishes consolidated short volume free to anyone, and
//   earnings dates are on every finance site. Nothing here carries the dealer map's value, so
//   none of it is gated — it makes the free tier better, which is what the free tier is for.
//
//   The part NoVo adds is the percentile: a raw 55% short-volume ratio means nothing on its own
//   because SPY sits in the fifties most days. Ranking today against this ticker's own recent
//   distribution is what turns a number into a reading, and that is computed engine-side off
//   logged history rather than here.
//
//   Where these genuinely earn is one layer down — inside the written read, where short volume
//   conditioned on the gamma regime is a sentence nobody else can write. That pairing needs the
//   dealer map and stays paid. This endpoint is deliberately just the raw side.

const { kv } = require("./_kv.js");

const KEY = "novo:market_internals";
// A week. Short volume publishes daily and earnings refresh continuously, so anything older
// than this means the engine has been down for days — at which point the staleness should be
// visible on the page rather than papered over by a long TTL.
const TTL = 7 * 24 * 60 * 60;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  const r = kv();

  if (req.method === "POST") {
    const secret = process.env.ANALYST_PUBLISH_SECRET || "";
    if (!secret || req.headers["x-analyst-secret"] !== secret) {
      return res.status(403).json({ error: "forbidden" });
    }
    let b = {};
    try { b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { b = {}; }
    // shortVolume is the payload's reason to exist; earnings can legitimately be empty for weeks.
    if (!b || b.ok !== true || !b.shortVolume) return res.status(400).json({ error: "bad payload" });
    if (!r) return res.status(200).json({ ok: false, note: "kv unavailable" });
    try {
      await r.set(KEY, JSON.stringify({ ...b, received: Date.now() }), { ex: TTL });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET or POST" });

  // Short volume lands once a day after the close, so a minute of revalidation is plenty and
  // keeps a fresh push from sitting invisible behind edge cache.
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=600");
  if (!r) return res.status(200).json({ ok: false, note: "unavailable" });
  let snap = null;
  try { snap = await r.get(KEY); } catch (_) { snap = null; }
  if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
  if (!snap) return res.status(200).json({ ok: false, note: "not published yet" });
  return res.status(200).json(snap);
};
