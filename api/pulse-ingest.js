// Owner-box → store push of the two SANITIZED aggregates the public Market Pulse can't get free: market breadth
// (from NoVo's ~50-stock leader basket) and the SPY put/call ratio. These are aggregate SENTIMENT numbers, NOT
// the dealer map — folded into the Pulse score + shown only as qualitative factor labels (no-leak). Auth reuses
// ANALYST_PUBLISH_SECRET (the same secret the engine already uses for /api/analyst-publish). Stored in KV, 30m TTL.

const { kv } = require("./_kv");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const secret = process.env.ANALYST_PUBLISH_SECRET || "";
  if (!secret || req.headers["x-analyst-secret"] !== secret) return res.status(403).json({ error: "forbidden" });
  let b = {};
  try { b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch { b = {}; }
  const out = { ts: Date.now() };
  if (typeof b.breadth === "number" && isFinite(b.breadth)) out.breadth = Math.max(0, Math.min(100, b.breadth));
  if (typeof b.putcall === "number" && isFinite(b.putcall) && b.putcall > 0) out.putcall = b.putcall;
  const r = kv();
  if (r) { try { await r.set("mkt:pulse:inputs", JSON.stringify(out), { ex: 1800 }); } catch {} }
  return res.status(200).json({ ok: true, stored: out });
};
