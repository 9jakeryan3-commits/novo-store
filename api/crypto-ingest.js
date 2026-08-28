// api/crypto-ingest.js — owner-box → store push of the NoVo Crypto Map snapshot.
//
// The crypto corpus lives on the owner box (SQLite, written by Novo-crypto/run.py). Vercel
// can't reach it, so the box pushes a rendered snapshot here each pass and the gated
// dashboard reads it back out of KV. Same shape as /api/pulse-ingest, same secret.
//
// What lands here IS the paid dealer map — gamma by strike, flip, walls, funding by venue,
// liquidations. It is written to a KEY THE PUBLIC ENDPOINTS NEVER READ, and is served only
// by /api/crypto-map behind the subscriber HMAC. Nothing on this path is public.

const { kv } = require("./_kv");

const MAX_BYTES = 900 * 1024;   // one snapshot; well inside Upstash's value ceiling

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.ANALYST_PUBLISH_SECRET || "";
  if (!secret || req.headers["x-analyst-secret"] !== secret) {
    return res.status(403).json({ error: "forbidden" });
  }

  let b = {};
  try { b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: "bad json" }); }

  if (!b || typeof b !== "object") return res.status(400).json({ error: "expected an object" });

  // Two kinds ride this endpoint. The MAP is the current pass, read back by the gated
  // dashboard. The HISTORY rollup is the corpus reduced to distributions and daily series,
  // read by NoVo's tools - without it he can see the current pass and nothing behind it.
  // Separate keys and separate TTLs: history is rebuilt every pass but is worth keeping
  // longer, because a stale distribution is still a usable one and a missing one is not.
  if (b.kind === "history") {
    if (!b.coins || typeof b.coins !== "object") {
      return res.status(400).json({ error: "history needs {coins:{...}}" });
    }
    const hp = JSON.stringify({
      coins: b.coins, base_rates: b.base_rates || null, coverage: b.coverage || null,
      open_claims: b.open_claims ?? null, received: Date.now(),
    });
    if (hp.length > MAX_BYTES) {
      return res.status(413).json({ error: `history ${hp.length}b exceeds ${MAX_BYTES}b` });
    }
    const rh = kv();
    if (!rh) return res.status(503).json({ error: "kv unavailable" });
    try {
      await rh.set("crypto:map:history", hp, { ex: 86400 });
      return res.status(200).json({ ok: true, kind: "history", bytes: hp.length,
                                    coins: Object.keys(b.coins).length });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e).slice(0, 140) });
    }
  }

  if (!b.coins || typeof b.coins !== "object") {
    return res.status(400).json({ error: "expected {as_of, coins:{...}, breadth, health}" });
  }

  const payload = JSON.stringify({
    as_of: b.as_of || new Date().toISOString(),
    coins: b.coins,
    breadth: b.breadth || null,
    health: b.health || null,
    received: Date.now(),
  });
  if (payload.length > MAX_BYTES) {
    return res.status(413).json({ error: `snapshot ${payload.length}b exceeds ${MAX_BYTES}b` });
  }

  const r = kv();
  if (!r) return res.status(503).json({ error: "kv unavailable" });
  try {
    // 2h TTL: long enough to survive a collector restart or a quiet stretch, short enough
    // that a dead box shows as stale rather than silently serving yesterday's map.
    await r.set("crypto:map:live", payload, { ex: 7200 });
    return res.status(200).json({ ok: true, bytes: payload.length, coins: Object.keys(b.coins).length });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e).slice(0, 140) });
  }
};
