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

  // The on-chain half's history — its own kind and key. Tokens are keyed network:address;
  // stored whole (minus the kind tag) for the same store-what-arrived reason as the map.
  if (b.kind === "chainhist") {
    if (!b.tokens || typeof b.tokens !== "object") {
      return res.status(400).json({ error: "chainhist needs {tokens:{...}}" });
    }
    const { kind, ...rest } = b;
    const cp = JSON.stringify(Object.assign(rest, { received: Date.now() }));
    if (cp.length > MAX_BYTES) {
      return res.status(413).json({ error: `chainhist ${cp.length}b exceeds ${MAX_BYTES}b` });
    }
    const rc = kv();
    if (!rc) return res.status(503).json({ error: "kv unavailable" });
    try {
      await rc.set("crypto:map:chainhist", cp, { ex: 86400 });
      return res.status(200).json({ ok: true, kind: "chainhist", bytes: cp.length,
                                    tokens: Object.keys(b.tokens).length });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e).slice(0, 140) });
    }
  }

  if (!b.coins || typeof b.coins !== "object") {
    return res.status(400).json({ error: "expected {as_of, coins:{...}, breadth, health}" });
  }

  // STORE WHAT ARRIVED. This used to rebuild the snapshot field by field, and that whitelist
  // silently deleted a section THREE separate times -- chain, then alerts, then feed. The shape is
  // identical every time: the collector reports a successful publish, this endpoint answers 200, KV
  // never receives the data, and it surfaces later as "the dashboard is broken" in whatever renders
  // it. Adding the missing field would have fixed today and guaranteed a fourth.
  //
  // A field list that fails closed is right for input you do not trust. This is not that: the body
  // comes over the publish secret from a collector in this same codebase and is already bounded by
  // MAX_BYTES. What must stay server-authoritative stays server-authoritative -- `received` is
  // stamped here so a stale box cannot lie about its own freshness, and as_of falls back to now.
  const payload = JSON.stringify(Object.assign({}, b, {
    as_of: b.as_of || new Date().toISOString(),
    received: Date.now(),
  }));
  if (payload.length > MAX_BYTES) {
    return res.status(413).json({ error: `snapshot ${payload.length}b exceeds ${MAX_BYTES}b` });
  }

  const r = kv();
  if (!r) return res.status(503).json({ error: "kv unavailable" });
  try {
    // 2h TTL: long enough to survive a collector restart or a quiet stretch, short enough
    // that a dead box shows as stale rather than silently serving yesterday's map.
    await r.set("crypto:map:live", payload, { ex: 7200 });
    const shape = {};
    for (const k of Object.keys(b)) {
      const v = b[k];
      shape[k] = Array.isArray(v) ? v.length : (v && typeof v === "object" ? Object.keys(v).length : typeof v);
    }
    return res.status(200).json({ ok: true, bytes: payload.length, sections: shape });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e).slice(0, 140) });
  }
};
