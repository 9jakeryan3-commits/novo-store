// api/base-rates.js — conditional base rates over NoVo's own logged dealer history.
//
// The engine banks a wide market-state row every ~60s, then aggregates it into "given this dealer
// state, here is what has actually happened next, and here is how many times we have seen it" and
// POSTs the result here. This serves it back to the Analyst's tool layer, which runs in the cloud
// and cannot reach that SQLite file directly.
//
// Aggregate-only: counts, medians and sample sizes over past sessions. It carries no live level, so
// it holds none of the dealer map's value. It is also NOT a forecast — every cell ships with `n`,
// `sessions` and a precomputed `usable` flag, because a base rate drawn from one afternoon reads
// authoritative while being noise, and that is the failure mode worth engineering against.

const { kv } = require("./_kv.js");

const KEY = "novo:base_rates";
const TTL = 14 * 24 * 60 * 60;   // survives a long engine outage; staleness is shown, not hidden

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
    if (!b || b.ok !== true || !b.tickers) return res.status(400).json({ error: "bad payload" });
    if (!r) return res.status(200).json({ ok: false, note: "kv unavailable" });
    try {
      await r.set(KEY, JSON.stringify({ ...b, received: Date.now() }), { ex: TTL });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET or POST" });

  res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
  if (!r) return res.status(200).json({ ok: false, note: "unavailable" });
  let snap = null;
  try { snap = await r.get(KEY); } catch (_) { snap = null; }
  if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
  if (!snap) return res.status(200).json({ ok: false, note: "not published yet" });
  return res.status(200).json(snap);
};
