/* api/novo-record.js — publish Dr. NoVo's own graded record, for the owner dashboard.
 *
 * Jake, 2026-09-09: "every alert, prediction, report bias, audit bias, convo prediction every
 * single thing everything that comes from Dr. novo and gets graded must be included in the all
 * time grade. not engine math scores. Dr. novo scores."
 *
 * The bias records (Pre-Market Primer lean, hourly structural audit) already reach the dashboard
 * through /api/track-record. The PREDICTION record did not reach it at all: it lives in KV behind
 * _lib/predictions.js and nothing published it, so three quarters of what Jake asked for — the
 * alerts, the calls the catcher pulls out of published reports, and the calls he makes in
 * conversation — were graded and then invisible.
 *
 * THIS GRADES NOTHING. Every row counted was already graded by _grade() at its horizon and carries
 * `hit` true/false. novoRecord() tallies. One grader, one answer.
 *
 * ⚠ GATED, AND NOT BECAUSE THE NUMBERS ARE SECRET. The `novo` and `conversation` sources are
 * comp-seat-only calls (see predictions.js: "a call he initiated himself off the data — comp seats
 * only"). A public endpoint returning their hit counts would leak the existence and cadence of
 * private calls to anyone who curled it. Same shared secret the rest of the ops surface uses.
 *
 * ⚠ THE MEMBER'S OWN PREDICTIONS ARE EXCLUDED at the source (novoRecord skips source "user").
 * Those are other people's calls; counting them would put them in his grade.
 */
const { novoRecord, migrateGateRows } = require("./_lib/predictions.js");

module.exports = async (req, res) => {
  const want = process.env.OPS_SECRET || process.env.ANALYST_PUBLISH_SECRET || "";
  if (!want) return res.status(503).json({ error: "not configured" });

  const got = req.headers["x-ops-secret"]
    || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  /* Length-first compare, then a constant-time byte compare. timingSafeEqual THROWS on a length
     mismatch, so the naive call is itself an oracle for the secret's length. */
  const ok = got.length === want.length
    && require("crypto").timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) return res.status(401).json({ error: "unauthorized" });

  try {
    /* ?migrate=1 re-attributes the rows the edge gate minted in his name (see migrateGateRows).
       Behind the same secret as the read, and idempotent, so a repeat is a no-op rather than a
       second pass over the same rows. */
    let migrated = null;
    if (String(req.query && req.query.migrate) === "1") migrated = await migrateGateRows();
    const rec = await novoRecord();
    if (migrated) rec.migrated = migrated;
    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ ok: true, ...rec, generated: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
