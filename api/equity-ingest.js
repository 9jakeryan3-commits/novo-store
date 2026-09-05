// api/equity-ingest.js — engine → store push of Jake's private equities signal feed.
//
// The equities signal desk (NoVo-Pulse skills/equity_signals.py) fires flip-cross tickets,
// grades them against minute bars, and publishes its feed here on every fire/resolution
// plus a 15-minute heartbeat. Same secret and same store-what-arrived doctrine as
// /api/crypto-ingest: the body is written WHOLE, because the field-by-field rebuild
// whitelist silently deleted a section three separate times on the crypto path.
//
// PRIVACY: this lands on a key only the comp-gated analyst grounding reads
// (analyst-ask.js). Nothing public serves it, and per Jake's 2026-09-04 ruling the ONLY
// surface is chat-pull — no page, no email, no webhook grows from this endpoint.

const { kv } = require("./_kv");

const MAX_BYTES = 256 * 1024; // the feed is 20 open + 20 recent + record rows; 256KB is generous

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
  if (!b || typeof b !== "object" || !Array.isArray(b.record) && !Array.isArray(b.open)) {
    return res.status(400).json({ error: "expected {as_of, open, recent_resolved, record, ...}" });
  }

  const payload = JSON.stringify(Object.assign({}, b, {
    as_of: b.as_of || new Date().toISOString(),
    received: Date.now(),
  }));
  if (payload.length > MAX_BYTES) {
    return res.status(413).json({ error: `feed ${payload.length}b exceeds ${MAX_BYTES}b` });
  }

  const r = kv();
  if (!r) return res.status(503).json({ error: "kv unavailable" });
  try {
    // 7d TTL for the same reason crypto:map:live carries it: the feed self-describes its
    // freshness (as_of/received) and a labelled old record beats a vanished one.
    await r.set("equity:signals:live", payload, { ex: 604800 });
    return res.status(200).json({ ok: true, bytes: payload.length,
                                  open: (b.open || []).length, record: (b.record || []).length });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 140) });
  }
};
