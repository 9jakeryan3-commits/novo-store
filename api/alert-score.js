// api/alert-score.js — the score for MARKET ALERTS. Ops-gated, for the Owner Dashboard.
//
// ⚠ THIS IS THE ENGINE'S SCORE, NOT DR. NoVo'S (Jake, 2026-09-12): the alerts surfaced to comp
// seats are engine fires whose rule showed an edge and held it, so their hit rate belongs on the
// engine's side of the dashboard — beside the map's own math — and must NEVER be folded into his
// all-time grade. His grade is predictions, conversation calls, report bias and audit bias. See
// _lib/alert-record.js for the re-attribution and the ruling that drove it.
//
// Jake, 2026-09-11: "alerts are comp only, im the only comp, owner dashboard score tracking."
//
// So this is deliberately NOT a member surface. The alerts themselves are comp-only, Jake is the
// only comp seat, and the score of those alerts is an owner's instrument — it belongs beside the
// revenue numbers, not on a dashboard tab. Same gate as api/dr-log.js.
//
// ⚠ WHAT THIS IS NOT: the rule records. Those already exist and already gate what gets released
// (a crypto kind must clear its own out-of-sample floor; an equity rule needs 30 resolutions and
// 5pp of edge). THIS scores the alerts that were actually RELEASED — the tickets Dr. NoVo put in
// front of the seat — which is a different and smaller set, and the only one that answers "were
// his calls any good".
//
// Query:
//   ?limit=N     rows to return (default 100, max 400)
//   ?class=crypto|equity
//   ?status=open|graded|unresolved
//   ?rows=0      omit the individual alerts, return only the scoreboard

const crypto = require('node:crypto');
const { kv } = require('./_kv.js');
const AR = require('./_lib/alert-record.js');

function authed(req) {
  const want = process.env.OPS_SECRET || process.env.ANALYST_PUBLISH_SECRET || '';
  const got = String(req.headers['x-ops-secret'] || req.headers['x-analyst-secret']
    || (req.query && req.query.secret) || '');
  if (!want || !got || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (_) { return false; }
}

module.exports = async (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'forbidden' });
  const r = kv();
  if (!r) return res.status(503).json({ error: 'kv unavailable' });
  res.setHeader('Cache-Control', 'no-store');

  const q = req.query || {};
  const limit = Math.max(1, Math.min(parseInt(q.limit, 10) || 100, 400));

  /* Sweep first, so the numbers below are current rather than as-of-the-last-ingest. An alert whose
     verdict never arrived should already be written off by the time anyone reads the rate. */
  let swept = null;
  try { swept = await AR.reconcile(); } catch (_) { swept = null; }

  const score = await AR.scoreboard();
  if (!score) return res.status(503).json({ error: 'scoreboard unavailable' });

  let rows = [];
  if (q.rows !== '0') {
    try {
      let l = await r.get(AR.KEY);
      if (typeof l === 'string') l = JSON.parse(l);
      rows = Array.isArray(l) ? l : [];
    } catch (_) { rows = []; }
    if (q.class) rows = rows.filter((a) => a.asset_class === q.class);
    if (q.status) rows = rows.filter((a) => a.status === q.status);
    rows = rows.slice(-limit).reverse().map((a) => ({
      when: new Date(a.ts).toISOString(),
      asset_class: a.asset_class, symbol: a.symbol, kind: a.kind,
      action: a.action, direction: a.direction,
      entry: a.entry_px, target: a.target_px, stop: a.stop_px,
      horizon_min: a.horizon_min, deadline: a.deadline,
      status: a.status,
      outcome: a.outcome,                 // win | loss | flat | null
      engine_said: a.result_raw,          // the engine's own word, unchanged
      move_pct: a.outcome_pct, move_bp: a.move_bp,
      graded: a.graded_ts ? new Date(a.graded_ts).toISOString() : null,
      title: a.title,
    }));
  }

  return res.status(200).json({
    note: "Dr. NoVo's released alerts, graded as alerts. Not the rule records, and not predictions.",
    /* ⚠ THE CAVEAT TRAVELS WITH THE NUMBER. A hit rate whose denominator excludes flats and
       unresolved rows is the honest one, but only if the reader can see what was excluded — so
       the basis string and the reconciliation ride in the same object, not in a doc somewhere. */
    score,
    swept,
    count: rows.length,
    rows,
  });
};
