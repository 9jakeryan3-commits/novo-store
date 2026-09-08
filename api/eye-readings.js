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

  // ── THE ENGINE'S WRITE ────────────────────────────────────────────────────────────────────
  // Jake, 2026-09-07: "it already works in crypto live readings works, this aint new."
  // He was right, and it is the reason this took four rounds. The crypto readings land because
  // they POST to a DEDICATED endpoint (api/crypto-ingest.js): one file, one job, no routing to
  // get wrong. The equity readings were pushed into api/analyst-publish.js instead - a handler
  // with a dozen POST branches, matched on query keys and body markers - and every one of those
  // four debugging rounds was spent on routing I had invented for myself. The publish never
  // reached its branch and fell through to the journal handler, which asked for a title.
  //
  // Same shape as crypto-ingest now, and the same secret. Nothing to route, nothing to miss.
  if (req.method === "POST") {
    const secret = process.env.ANALYST_PUBLISH_SECRET || "";
    if (!secret || req.headers["x-analyst-secret"] !== secret) {
      return res.status(401).json({ error: "unauthorized" });
    }
    let b = req.body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (_) { b = null; } }
    if (Buffer.isBuffer(b)) { try { b = JSON.parse(b.toString("utf8")); } catch (_) { b = null; } }
    // A RULE FIRE, not a readings snapshot. The Eye reports it; NoVo decides in onEquityFire
    // whether it has earned a call and a place in his alerts. Same endpoint because it is the
    // same channel — the Eye talking to the store — and one door is the entire lesson here.
    if (b && b.kind === "eye_fire") {
      if (!b.rule || !b.symbol) return res.status(400).json({ error: "rule and symbol required" });
      const out = await require("./_lib/predictions.js").onEquityFire({ ...b, ts: Date.now() });
      return res.status(200).json({ ok: true, ...out });
    }
    if (!b || !Array.isArray(b.readings)) {
      return res.status(400).json({ error: "readings[] required",
        got: Object.prototype.toString.call(b) });
    }
    const w = kv();
    if (!w) return res.status(503).json({ error: "store unavailable" });
    // A snapshot of now, replaced whole - nothing to merge, nothing to age out. The 6h TTL is a
    // dead-engine detector: stop publishing and the key expires, so the strip goes quiet rather
    // than showing yesterday as though it were today.
    await w.set("eye:readings:live", JSON.stringify({
      as_of: b.as_of || new Date().toISOString(),
      readings: b.readings.slice(0, 60),
      rules: Array.isArray(b.rules) ? b.rules.slice(0, 40) : [],
      n: Number(b.n) || b.readings.length,
    }), { ex: 6 * 3600 });
    /* READ IT BACK BEFORE CLAIMING IT LANDED. A 200 here has meant "the write call returned",
       which is not the same as "a member can now fetch this" — different serialisation, a TTL
       that did not take, a key written to a store the read path does not share, all look like
       success from the write side. The response reports what the GET path would actually find,
       so the engine log carries an end-to-end fact instead of a local one. */
    let readable = null;
    try {
      let back = await w.get('eye:readings:live');
      if (typeof back === 'string') back = JSON.parse(back);
      readable = (back && Array.isArray(back.readings)) ? back.readings.length : -1;
    } catch (_) { readable = -1; }
    return res.status(200).json({ ok: true, stored: b.readings.length, readable: readable });
  }

  const email = verifyToken(
    req.query.t || String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, ""));
  if (!email) return res.status(401).json({ error: "unauthorized" });

  const r = kv();
  if (!r) return res.status(503).json({ error: "store unavailable" });

  /* THE DAILY CRYPTO RUNDOWN rides this endpoint rather than getting one of its own: it is the
     same shape of thing (a member-gated read of something the system published on a schedule)
     and the auth above is already the right auth. ?crypto=1 selects it. */
  if (req.query && "crypto" in req.query) {
    let rd = null;
    try { rd = await r.get("crypto:read:daily"); } catch (_) { rd = null; }
    if (typeof rd === "string") { try { rd = JSON.parse(rd); } catch (_) { rd = null; } }
    let pred = null;
    try {
      pred = await require("./_lib/predictions.js").listPredictions(40, "crypto");
    } catch (_) { pred = null; }
    if (!rd || !rd.text) {
      return res.status(200).json({ ok: true, live: false,
        note: "No rundown published yet today." });
    }
    return res.status(200).json({ ok: true, live: true, read: rd,
      // The score for BTC direction calls — the family this read's bias belongs to, so the page
      // can show the record without computing one of its own.
      score: pred && pred.score ? pred.score : null,
      overall: pred && pred.overall ? pred.overall : null });
  }

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
