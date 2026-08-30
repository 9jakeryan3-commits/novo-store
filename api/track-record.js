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
  let snap = null, ch = null;
  try { snap = await r.get(KEY); } catch (_) { snap = null; }
  // Crypto is additive: if this read fails the equity record still serves whole.
  try { ch = await r.get("crypto:map:history"); } catch (_) { ch = null; }
  if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
  if (typeof ch === "string") { try { ch = JSON.parse(ch); } catch (_) { ch = null; } }
  if (!snap) return res.status(200).json({ ok: false, note: "not published yet" });

  // The CRYPTO half of the same record. The collector scores its own claims (gamma pin, funding
  // extreme, OI quadrant, cost anomaly) exactly the way the equity engine scores its own — and a
  // track record that shows one asset class while the analyst runs two reads as curated. Only the
  // crypto-class aggregates ride here; each row carries `trustworthy` and its own caveat, and a
  // row that has not survived more than one market says so instead of wearing a hit rate.
  if (ch && ch.base_rates && Object.keys(ch.base_rates).length) {
    snap.crypto = {
      baseRates: ch.base_rates,
      retired: ch.base_rates_retired || null,
      openClaims: ch.open_claims ?? null,
      asOf: ch.received || null,
      note: "Self-scored crypto claims, graded at their own horizons against the series each " +
            "claim was made on. n_cells (independent coin-days) is the denominator that matters; " +
            "a row with trustworthy:false is an early reading, not a base rate. Directional kinds " +
            "report per predicted side with the market's own drift beside them.",
    };
  }
  return res.status(200).json(snap);
};
