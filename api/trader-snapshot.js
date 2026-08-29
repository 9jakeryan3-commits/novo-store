// api/trader-snapshot.js — the free, delayed Trader chart.
//
// POST (from NoVo's box, x-analyst-secret): store the snapshot.
// GET  (any signed-in member): read it back.
//
// THE DELAY IS NOT ENFORCED HERE, AND THAT IS DELIBERATE.
//
// The box only ever publishes a frame that is ALREADY past the delay — it holds a rolling buffer and
// sends the newest ripe one. So what lands in KV contains nothing fresher than the stated delay, and
// there is nothing to leak even if someone reads this endpoint raw. Enforcing the delay on the way
// OUT instead would mean the live values sat in KV and travelled to the browser with a flag asking it
// not to look, which is not a delay at all.
//
// Consequently this handler does no filtering: it hands back exactly what the box published, and
// as_of says what instant it represents. If the box ever starts publishing live frames, that is a bug
// in the box, and it is the only place that can be a bug.

const crypto = require("crypto");
const { kv } = require("./_kv");

const KEY = "trader:snapshot:delayed";

// A little over the publish interval, so a stalled box expires rather than serving a stale chart
// forever. The page shows as_of regardless, but a missing key is a clearer failure than an old one.
const TTL_SECONDS = 900;

function verifyMemberToken(token) {
  try {
    const secret = process.env.ANALYST_LIVE_SECRET || process.env.ANALYST_PUBLISH_SECRET || "";
    if (!secret || !token) return null;
    const [payload, sig] = String(token).split(".");
    if (!payload || !sig) return null;
    const want = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return (j && j.x > Date.now()) ? j.e : null;
  } catch (_) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const r = kv();
  if (!r) return res.status(503).json({ error: "store unavailable" });

  // ---- publish ------------------------------------------------------------------------------
  if (req.method === "POST") {
    const secret = process.env.ANALYST_PUBLISH_SECRET || "";
    const sent = req.headers["x-analyst-secret"] || "";
    if (!secret || sent !== secret) return res.status(401).json({ error: "unauthorized" });

    const b = req.body || {};
    if (!b.as_of || !Array.isArray(b.candles)) {
      return res.status(400).json({ error: "as_of and candles required" });
    }
    // A frame that is not actually delayed must never be stored, whatever the box says about it.
    // This is a backstop on the box's own rule, not a substitute for it.
    const delayMin = Number(b.delay_min) || 15;
    const ageMin = (Date.now() / 1000 - Number(b.as_of)) / 60;
    if (ageMin < delayMin - 1) {
      return res.status(400).json({ error: "snapshot is not delayed", age_min: Math.round(ageMin) });
    }

    const doc = {
      as_of: Number(b.as_of),
      delay_min: delayMin,
      ticker: String(b.ticker || "SPY").toUpperCase().slice(0, 6),
      price: b.price == null ? null : Number(b.price),
      levels: b.levels && typeof b.levels === "object" ? b.levels : {},
      candles: b.candles.slice(-180),
      received: Date.now(),
    };
    try { await r.set(KEY, JSON.stringify(doc), { ex: TTL_SECONDS }); }
    catch (e) { return res.status(503).json({ error: "store write failed" }); }

    // Report what actually landed. A 200 that says only "ok" is how a dropped field goes unnoticed
    // for three surfaces — this endpoint states its own payload back.
    return res.status(200).json({
      ok: true, as_of: doc.as_of, delay_min: doc.delay_min, ticker: doc.ticker,
      candles: doc.candles.length, levels: Object.keys(doc.levels).length,
    });
  }

  // ---- read ---------------------------------------------------------------------------------
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  // Signed in, but NOT entitlement-checked: this is the free tier's chart. The gate is a member
  // account, which is the whole point — it is a reason to sign up rather than a thing to bookmark.
  const email = verifyMemberToken((req.query && req.query.t) || "");
  if (!email) return res.status(401).json({ error: "sign in to see the delayed chart" });

  let raw = null;
  try { raw = await r.get(KEY); } catch (_) { return res.status(503).json({ error: "store read failed" }); }
  if (!raw) return res.status(503).json({ error: "no snapshot yet" });

  let doc = raw;
  if (typeof doc === "string") { try { doc = JSON.parse(doc); } catch { doc = null; } }
  if (!doc) return res.status(503).json({ error: "snapshot unreadable" });

  return res.status(200).json(doc);
};
