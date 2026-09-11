// api/equity-record.js — the equity rules' graded record. Ops-gated, read-only.
//
// Yuri (65a79700), 2026-09-11: the number that decides whether the equity prediction gate is
// CALIBRATED or merely SLOW is computed, published, and unreadable. He ruled out four surfaces by
// measurement — /api/equity-ingest is POST-only; the archive channel's allowlist does not include
// equity_signals or equity_signal_resolutions so the SQLite authorizer refuses; the engine's
// /api/ops secret appears nowhere in the creds map; and /api/track-record carries the crypto
// record but nothing equity (verified with a positive control on the same payload).
//
// So Jake could not tell "the rules have not resolved enough yet" from "they resolved plenty and
// have no edge" — and those call for opposite actions: wait, versus change the rules.
//
// ⚠ THIS ADDS NO DATA AND NO STORAGE. equity_signals.py::feed() already computes and publishes
// exactly what is needed, per rule: n_graded, hits, misses, flats, no_data, n_cells, hit_rate_all,
// decisive_rate, own_baseline.same_dir_rate, edge_pp and a `meaningful` flag. It lands whole in
// `equity:signals:live` on every push. This is one read of a key that is already there, behind the
// same gate /api/novo-record and /api/alert-score already use for the other two books.
//
// ⚠ IT ANSWERS THE QUESTION IN WORDS, NOT JUST NUMBERS. `verdict` per rule says which of the two
// states a rule is in, because the whole point is that a human could not tell from outside.

const crypto = require('node:crypto');
const { kv } = require('./_kv.js');

/* The store's own release gate, mirrored from _lib/predictions.js so the verdict below is measured
   against the bar that actually blocks a release rather than a number invented here. */
const EQ_MIN_RESOLUTIONS = 30;
const EQ_MIN_EDGE_PP = 5;

function authed(req) {
  const want = process.env.OPS_SECRET || process.env.ANALYST_PUBLISH_SECRET || '';
  const got = String(req.headers['x-ops-secret'] || req.headers['x-analyst-secret']
    || (req.query && req.query.secret) || '');
  if (!want || !got || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (_) { return false; }
}

const num = (v) => (v == null || !isFinite(Number(v)) ? null : Number(v));

module.exports = async (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'forbidden' });
  const r = kv();
  if (!r) return res.status(503).json({ error: 'kv unavailable' });
  res.setHeader('Cache-Control', 'no-store');

  let feed = null;
  try {
    feed = await r.get('equity:signals:live');
    if (typeof feed === 'string') feed = JSON.parse(feed);
  } catch (_) { feed = null; }

  /* ⚠ "THE ENGINE HAS NOT PUBLISHED" IS NOT "THE RULES HAVE NO RECORD". Say which. The key carries
     a 7-day TTL, so an absent key means the equity engine has been silent for a week — itself the
     most important thing this endpoint could report. */
  if (!feed) {
    return res.status(200).json({
      reachable: false,
      note: 'equity:signals:live is absent. The equity engine has not published within its 7-day '
          + 'TTL — that is an engine-liveness finding, not an empty record.',
    });
  }

  const record = Array.isArray(feed.record) ? feed.record : [];
  const rules = record.map((x) => {
    const nGraded = num(x.n_graded);
    const cells = num(x.n_cells);
    const edge = num(x.edge_pp);
    const enoughN = nGraded != null && nGraded >= EQ_MIN_RESOLUTIONS;
    const hasEdge = edge != null && edge >= EQ_MIN_EDGE_PP;

    /* The two states Jake cannot currently distinguish, named. A rule that has not resolved enough
       is a WAIT; a rule that has resolved plenty and shows no edge is a CHANGE THE RULE. */
    let verdict;
    if (!enoughN) verdict = 'accruing — not enough resolutions yet (' + nGraded + '/' + EQ_MIN_RESOLUTIONS + ')';
    else if (!hasEdge) verdict = 'resolved enough, NO EDGE (' + edge + 'pp vs the ' + EQ_MIN_EDGE_PP + 'pp bar)';
    else verdict = 'clears the bar (' + edge + 'pp over ' + nGraded + ' resolutions)';

    return {
      /* ⚠ THE ROW KEY IS (rule, horizon_min, era), NOT rule. equity_signals.py:426 groups by all
         three, so one rule name legitimately appears once per horizon — my first read of this
         endpoint showed seven rows all called "flip_cross_down" and looked like duplicate data.
         Naming the horizon is the difference between a record and a confusing list. */
      rule: x.rule || x.kind || null,
      horizon_min: num(x.horizon_min),
      era: x.era || null,
      key: [x.rule || x.kind || '?', num(x.horizon_min) != null ? num(x.horizon_min) + 'm' : '?',
            x.era || '?'].join(' · '),
      n_graded: nGraded, n_cells: cells,
      hits: num(x.hits), misses: num(x.misses), flats: num(x.flats), no_data: num(x.no_data),
      hit_rate_all: num(x.hit_rate_all), decisive_rate: num(x.decisive_rate),
      baseline: x.own_baseline ? num(x.own_baseline.same_dir_rate) : null,
      edge_pp: edge,
      meaningful: !!x.meaningful,
      clears_release_gate: enoughN && hasEdge,
      verdict,
      /* ⚠ THE CALENDAR WALL, because it is not obvious and it is not about volume. The engine's own
         `meaningful` flag needs n_cells >= 30 DISTINCT DAYS. The Eye's rules were registered
         2026-09-07, so no equity rule can read meaningful before roughly 2026-10-19 however often
         it fires — and analyst-ask instructs Dr. NoVo to say "still accruing" until it does. */
      days_short_of_meaningful: cells == null ? null : Math.max(0, 30 - cells),
    };
  });

  return res.status(200).json({
    reachable: true,
    note: "The equity rules' own graded record, read from what the engine already publishes. "
        + 'Answers whether the gate is calibrated or merely slow — per rule, in words.',
    as_of: feed.as_of || null,
    gate: { min_resolutions: EQ_MIN_RESOLUTIONS, min_edge_pp: EQ_MIN_EDGE_PP },
    rules_total: rules.length,
    clearing_the_gate: rules.filter((x) => x.clears_release_gate).length,
    rules,
    open_signals: Array.isArray(feed.open) ? feed.open.length : null,
    recent_resolved: Array.isArray(feed.recent_resolved) ? feed.recent_resolved.length : null,
  });
};
