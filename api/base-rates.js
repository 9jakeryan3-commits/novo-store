// api/base-rates.js — conditional base rates over NoVo's own logged dealer history. INTERNAL.
//
// The engine banks a wide market-state row every ~60s, then aggregates it into "given this dealer
// state, here is what has actually happened next, and here is how many times we have seen it" and
// POSTs the result here. This serves it back to the Analyst's tool layer, which runs in the cloud
// and cannot reach that SQLite file directly.
//
// BOTH verbs are secret-gated. The aggregate carries no live level, but it IS derived from the paid
// dealer map, and the standing rule is that dealer-derived data stays gated (Jake, 2026-08-20). There
// is no cost to locking it: NoVo's tool layer reads novo:base_rates from KV in-process, never over
// HTTP, and no page renders this — the GET exists for inspection, not for a consumer.
//
// Aggregate-only: counts, medians and sample sizes over past sessions. It is NOT a forecast —
// every cell ships with `n`,
// `sessions` and a precomputed `usable` flag, because a base rate drawn from one afternoon reads
// authoritative while being noise, and that is the failure mode worth engineering against.

const { kv } = require("./_kv.js");

const KEY = "novo:base_rates";
const TTL = 14 * 24 * 60 * 60;   // survives a long engine outage; staleness is shown, not hidden

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();

  // Gate both verbs on the engine secret. No browser origin is allowed on purpose — nothing in a page
  // reads this, so a CORS allowance would only widen the surface.
  const secret = process.env.ANALYST_PUBLISH_SECRET || "";
  if (!secret || req.headers["x-analyst-secret"] !== secret) {
    return res.status(403).json({ error: "forbidden" });
  }

  const r = kv();

  if (req.method === "POST") {
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

  res.setHeader("Cache-Control", "no-store");
  if (!r) return res.status(200).json({ ok: false, note: "unavailable" });
  let snap = null;
  try { snap = await r.get(KEY); } catch (_) { snap = null; }
  if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
  if (!snap) return res.status(200).json({ ok: false, note: "not published yet" });
  return res.status(200).json(snap);
};
