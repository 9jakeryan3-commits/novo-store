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
const { novoRecord } = require("./_lib/predictions.js");
const { funnel } = require("./_lib/funnel.js");
const { kv } = require("./_kv.js");

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
    // ?calib=1 — the calibration ledger, observable again (Jake's go 09-11, item 20).
    // f5e919c9c took the cells off every PUBLIC surface ("I never said to publish it anywhere"),
    // which also removed the only external read path: nobody — including the person who asked
    // for it — could verify that the probe marker (forecast.js source:'probe') actually lands
    // on eval-seat rows, because calib:pending is read only inside the grader and calib:cells
    // only by the chat's own calibBlock. This is an OPS read behind the same secret as the
    // prediction record above, for the same reason: observability is not publication.
    if (req.query && req.query.calib) {
      const r = kv();
      if (!r) return res.status(200).json({ ok: false, note: "kv unavailable" });
      const [pendingRaw, cells, missesKept] = await Promise.all([
        r.lrange("calib:pending", 0, 99).catch(() => []),
        r.hgetall("calib:cells").catch(() => null),
        r.llen("calib:misses").catch(() => null),
      ]);
      const pending = (pendingRaw || []).map((x) => {
        try { return typeof x === "string" ? JSON.parse(x) : x; } catch (_) { return { unparsable: true }; }
      });
      res.setHeader("cache-control", "no-store");
      return res.status(200).json({
        ok: true,
        pending,
        probe_rows: pending.filter((c) => c && c.source === "probe").length,
        cells: cells || {},
        misses_kept: missesKept,
        generated: Date.now(),
      });
    }
    const rec = await novoRecord();
    /* The funnel rides along on the same authenticated read. Jake's expected shape is a
       RATIO between stages, so the two only mean something side by side. */
    try { rec.funnel = await funnel(14); } catch (_) { rec.funnel = null; }
    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ ok: true, ...rec, generated: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
