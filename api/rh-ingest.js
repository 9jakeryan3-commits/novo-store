/* api/rh-ingest.js — ops-gated intake for Robinhood-MCP agent snapshots (Jake's go, 09-12:
 * items 1 and 2 of the RH map — order-book depth and the fundamentals layer — into the product).
 *
 * WHY AN INGEST ENDPOINT EXISTS AT ALL. The RH MCP is OAuth-bound to Jake's own account through
 * agent sessions — no Vercel function and no engine process can ever call it. So RH data enters
 * the product the only way it can: an agent session (fleet session, desktop, or a scheduled run)
 * pulls through the connector and POSTs compact snapshots here. This endpoint is the ONE door.
 *
 * POSTURE (Jake, 09-12, verbatim intent): their data is never resold in abundance and never
 * replaces our own sources. What lands here is GROUNDING and WITNESS material: depth context for
 * the tape panels, primary-source fundamentals for Dr. NoVo to cite. Consumers render OUR
 * readouts and OUR analyst's words; raw RH payloads stay behind this ops wall.
 *
 * SHAPE-AGNOSTIC ON PURPOSE. v1 stores what the agent sends under a validated kind + ticker and
 * stamps provenance. The product-facing renderers get built against REAL captured shapes, not
 * guessed ones — designing storage first and renderers second is the whole lesson of 09-11/12
 * (fields that don't exist, units unstated, whitelists that eat). When shapes settle, consumers
 * read the keys below; nothing about this door changes.
 *
 * KEYS: rh:<kind>[:<TICKER>] — latest-only in v1, TTL per kind. No history accrual here yet:
 * that (the OI-diff baseline) is a separate approved wire with its own design.
 * Same secret discipline as novo-record.js: OPS_SECRET / ANALYST_PUBLISH_SECRET, length-first
 * timing-safe compare. GET lists stored rh:* keys with ages — the verification read, so "did
 * the feeder run" is answerable without a member surface or a KV console.
 */
const { kv } = require("./_kv.js");

const KINDS = {
  depth:        { ttl: 86400,      ticker: true  },   // get_equity_price_book snapshots
  fundamentals: { ttl: 7 * 86400,  ticker: true  },   // get_equity_fundamentals / get_financials
  earnings:     { ttl: 7 * 86400,  ticker: true  },   // get_earnings_results (actual vs estimate)
  filing_facts: { ttl: 30 * 86400, ticker: true  },   // get_sec_filing_facts extracts
  news:         { ttl: 86400,      ticker: true  },   // get_equity_news items (display + grounding)
  earnings_calendar: { ttl: 86400, ticker: false },   // get_earnings_calendar — market-wide, not per-ticker
  index_vol:    { ttl: 86400,      ticker: false },   // get_index_quotes witness (VIX/VXN/RVX)
};

module.exports = async (req, res) => {
  // Two doors' worth of keys: the ops secret (fleet, this box), and RH_INGEST_SECRET — a
  // purpose-minted token for the CLOUD FEEDER routine only (09-12). Separate on purpose: the
  // feeder's credential opens exactly this one write door and can be rotated in Vercel without
  // touching anything else. Timing-safe per candidate, length-first (timingSafeEqual throws on
  // length mismatch, which would itself be an oracle).
  const _crypto = require("crypto");
  const candidates = [process.env.OPS_SECRET, process.env.ANALYST_PUBLISH_SECRET,
                      process.env.RH_INGEST_SECRET].filter(Boolean);
  if (!candidates.length) return res.status(503).json({ error: "not configured" });
  const got = req.headers["x-ops-secret"]
    || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const ok = candidates.some((want) => got.length === want.length
    && _crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)));
  if (!ok) return res.status(401).json({ error: "unauthorized" });

  const r = kv();
  if (!r) return res.status(503).json({ error: "kv unavailable" });
  res.setHeader("cache-control", "no-store");

  if (req.method === "GET") {
    try {
      const keys = (await r.keys("rh:*")) || [];
      const out = [];
      for (const k of keys.slice(0, 200)) {
        let age_min = null;
        try {
          const v = await r.get(k);
          const j = typeof v === "string" ? JSON.parse(v) : v;
          if (j && j.received) age_min = Math.round((Date.now() - j.received) / 60000);
        } catch (_) { /* an unreadable key still gets listed */ }
        out.push({ key: k, age_min });
      }
      return res.status(200).json({ ok: true, count: out.length, keys: out,
        note: out.length ? undefined
          : "No RH snapshots stored yet — this is an empty read, not a passing one. " +
            "The feeder has not run (or its POSTs are failing before this door)." });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });

  let b = {};
  try { b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); } catch (_) { b = {}; }
  const spec = KINDS[b.kind];
  if (!spec) return res.status(400).json({ error: "kind must be one of: " + Object.keys(KINDS).join(", ") });
  let T = null;
  if (spec.ticker) {
    T = String(b.ticker || "").toUpperCase().replace(/[^A-Z0-9.]/g, "").slice(0, 10);
    if (!T) return res.status(400).json({ error: "ticker required for kind " + b.kind });
  }
  if (b.data == null) return res.status(400).json({ error: "data required" });
  // A 256KB ceiling keeps a runaway agent dump from bloating KV; real snapshots are far smaller.
  const payload = JSON.stringify({ data: b.data, as_of: b.as_of || Date.now(),
                                   received: Date.now(), source: "robinhood-mcp" });
  if (payload.length > 262144) return res.status(413).json({ error: "snapshot too large (256KB cap)" });

  const key = "rh:" + b.kind + (T ? ":" + T : "");
  try {
    await r.set(key, payload, { ex: spec.ttl });
    return res.status(200).json({ ok: true, key, bytes: payload.length, ttl_s: spec.ttl });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
