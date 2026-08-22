// api/track-record.js — NoVo's audited track record.
//
// The engine scores NoVo's own published claims against its own logged dealer history and POSTs
// the result here; this serves it publicly. It is an AGGREGATE of past sessions — hit rates,
// medians and sample sizes — never a live level, so it carries none of the dealer map's value
// and is safe on a free page. No third-party data is involved at all: NoVo's claims, NoVo's log.
//
// The reason this exists: nothing in the category publishes a track record, which is a large part
// of why the category gets called a grift. Publishing a thin or unflattering one honestly is worth
// more than publishing nothing.

const { kv } = require("./_kv.js");

const KEY = "novo:track_record";
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

  // 30 minutes of edge cache with no browser max-age meant a fresh push could sit invisible for
  // half an hour, and browsers fell back to heuristic caching on top of that. The record changes
  // on every engine publish, so it revalidates in a minute and serves stale only while refreshing.
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=600");
  if (!r) return res.status(200).json({ ok: false, note: "unavailable" });
  let snap = null;
  try { snap = await r.get(KEY); } catch (_) { snap = null; }
  if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
  if (!snap) return res.status(200).json({ ok: false, note: "not published yet" });
  return res.status(200).json(snap);
};
