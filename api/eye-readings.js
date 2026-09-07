// api/eye-readings.js — the Eye's live readings, for the equity dashboards.
//
// Jake, 2026-09-07: "equities side needs the same live readings feature or similar as crypto, in
// its own way the page and bar across the top like crypto has, reading from the Eye ... analyst
// would get the bar that crypto has and trader would get a nav bar tab."
//
// WHAT THIS SERVES, AND THE GATE IT SITS BEHIND
// Readings are DESCRIPTIVE readouts of dealer state the analyst dashboard already renders — "SPY
// is 0.06% under its gamma flip, and dealer hedging reverses sign across it" — each carrying the
// measurement and the sample it rests on. They are not calls, they carry no side, and none of them
// is graded. That is what makes them shareable with members: the standing ruling on the private
// equity desk is about the TICKETS (the directional fires, the buy/sell calls), which stay exactly
// where they were — comp-gated, in Dr. NoVo's Alerts and the prediction record. The line is the
// one drawn on the crypto side on 2026-08-30 and quoted in get_chain_alerts: THE RESEARCH IS
// SHAREABLE; THE TICKETS ARE NOT.
//
// AUTH is api/alerts.js's verifier, copied exactly rather than reinvented — the signed ticket
// carries the member's email and an expiry, and nothing here consults the plan claim, because both
// equity dashboards have always included the dealer state these readings describe.
//
// ⚠ NO COMPUTATION HERE. The claims, the z-scores and the samples are all written by the engine
// (skills/eye_readings.py) against the Eye's own grid. If this file ever starts deriving a number,
// there are two implementations of what a reading means and they will disagree — the same failure
// the chain-alert baselines were pre-joined server-side to avoid.
const crypto = require("crypto");
const { kv } = require("./_kv.js");

function verifyToken(token) {
  try {
    const secret = process.env.ANALYST_LIVE_SECRET || process.env.ANALYST_PUBLISH_SECRET || "";
    if (!secret || !token) return null;
    const [payload, sig] = String(token).split(".");
    if (!payload || !sig) return null;
    const want = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(want);
    // Length first: timingSafeEqual THROWS on a length mismatch rather than returning false, and a
    // thrown comparison inside a catch that returns null reads as "bad token" by luck, not by check.
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claim || !claim.e || !claim.x || Date.now() > claim.x) return null;
    return String(claim.e).trim().toLowerCase();
  } catch (_) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const email = verifyToken(
    req.query.t || String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, ""));
  if (!email) return res.status(401).json({ error: "unauthorized" });

  const r = kv();
  if (!r) return res.status(503).json({ error: "store unavailable" });
  let snap = null;
  try { snap = await r.get("eye:readings:live"); } catch (_) { snap = null; }
  if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }

  // ABSENT, NOT EMPTY. An empty readings array means "the Eye looked and nothing cleared the bar",
  // which is a real and common answer. A missing key means "the Eye has not published in six
  // hours" — a different fact entirely, and one the page has to be able to say out loud instead of
  // rendering a quiet market that is actually a dead publisher.
  if (!snap || !Array.isArray(snap.readings)) {
    return res.status(200).json({ ok: true, live: false,
      note: "The Eye has not published readings recently." });
  }
  return res.status(200).json({
    ok: true, live: true, as_of: snap.as_of,
    readings: snap.readings, rules: Array.isArray(snap.rules) ? snap.rules : [],
    n: snap.n != null ? snap.n : snap.readings.length,
  });
};
