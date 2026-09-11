// api/dr-log.js — read the Dr. NoVo conversation log, for tuning.
//
// Jake, 2026-09-10, wants to see every conversation with Dr. NoVo so the desk can be tuned and its
// bugs caught. api/_lib/dr-log.js writes the turns; this reads them back, ops-gated.
//
// ⚠ THIS IS INTERNAL AND GATED. These are real member conversations, hashed to identities but full
// text. The read is behind the ops secret, the same gate the crypto ingest and ops console use.
//
// ⚠ THE HEALTH NUMBERS LEAD, because "not bugging out" is the point. The tally puts the empty/error
// rate, the record-guard rate and the tool-failure tallies up top, so a regression shows before you
// read a single transcript.
//
// Query:
//   ?status=empty|error|ok   only turns with that status (empty/error are the bug hunt)
//   ?app=analyst|trader|crypto
//   ?seat=comp|member
//   ?tool=get_dealer_levels  turns that reached for a given tool
//   ?q=<substring>           turns whose question/answer contains it
//   ?month=YYYY-MM           read that month's full archive instead of the rolling recent window
//   ?limit=N                 rows to return (default 120, max 400)
//   ?days=N                  include the last N days of the turns/ok/empty/error trend (default 14)

const crypto = require('node:crypto');
const { kv } = require('./_kv.js');

function authed(req) {
  const want = process.env.OPS_SECRET || process.env.ANALYST_PUBLISH_SECRET || '';
  const got = String(req.headers['x-ops-secret'] || req.headers['x-analyst-secret']
    || (req.query && req.query.secret) || '');
  if (!want || !got || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (_) { return false; }
}

function etDay(ms) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}

module.exports = async (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'forbidden' });
  const r = kv();
  if (!r) return res.status(503).json({ error: 'kv unavailable' });
  res.setHeader('Cache-Control', 'no-store');

  const q = req.query || {};
  const limit = Math.max(1, Math.min(parseInt(q.limit, 10) || 120, 400));

  // ── health, straight off the counters ──────────────────────────────────────────────────────
  let tally = {};
  try { tally = (await r.hgetall('dr:log:tally')) || {}; } catch (_) { tally = {}; }
  const num = (k) => Number(tally[k] || 0);
  const turns = num('turns');
  const pct = (n) => (turns ? +(100 * n / turns).toFixed(1) : 0);
  const pick = (prefix) => Object.keys(tally)
    .filter((k) => k.startsWith(prefix))
    .map((k) => [k.slice(prefix.length), Number(tally[k])])
    .sort((a, b) => b[1] - a[1]);

  const health = {
    turns,
    ok: num('st:ok'), empty: num('st:empty'), error: num('st:error'),
    empty_rate_pct: pct(num('st:empty')), error_rate_pct: pct(num('st:error')),
    guarded: num('guarded'), guarded_rate_pct: pct(num('guarded')),
    deep: num('deep'),
    by_app: Object.fromEntries(pick('app:')),
    by_seat: Object.fromEntries(pick('seat:')),
    top_tools: pick('tool:').slice(0, 15),
    tool_failures: pick('toolfail:').slice(0, 15),
  };

  // ── the trend, last N days ─────────────────────────────────────────────────────────────────
  const days = Math.max(0, Math.min(parseInt(q.days, 10) || 14, 60));
  const trend = [];
  for (let i = 0; i < days; i++) {
    const d = etDay(Date.now() - i * 86400000);
    let h = null;
    try { h = await r.hgetall('dr:log:day:' + d); } catch (_) { h = null; }
    trend.push({ day: d, turns: Number((h && h.turns) || 0), ok: Number((h && h.ok) || 0),
      empty: Number((h && h.empty) || 0), error: Number((h && h.error) || 0) });
  }

  // ── the turns themselves ───────────────────────────────────────────────────────────────────
  const src = q.month ? ('dr:log:' + String(q.month).slice(0, 7)) : 'dr:log:recent';
  // recent is small; a month can be large, so cap the raw pull and filter down.
  const raw = await r.lrange(src, -4000, -1).catch(() => []);
  let rows = [];
  for (const line of raw || []) {
    try { rows.push(typeof line === 'string' ? JSON.parse(line) : line); } catch (_) { /* skip */ }
  }
  // newest first
  rows.reverse();

  if (q.status) rows = rows.filter((x) => x.st === q.status);
  if (q.app) rows = rows.filter((x) => x.app === q.app);
  if (q.seat) rows = rows.filter((x) => x.seat === q.seat);
  if (q.tool) rows = rows.filter((x) => Array.isArray(x.tl) && x.tl.some((l) => l.n === q.tool));
  if (q.q) {
    const needle = String(q.q).toLowerCase();
    rows = rows.filter((x) => (String(x.q || '') + ' ' + String(x.a || '')).toLowerCase().includes(needle));
  }
  const matched = rows.length;
  rows = rows.slice(0, limit).map((x) => ({
    when: new Date(x.t).toISOString(),
    app: x.app, seat: x.seat, deep: !!x.deep, status: x.st,
    q: x.q, a: x.a,
    tools: (x.tl || []).map((l) => l.n + (l.ok ? '' : l.e ? '·empty' : '·fail')),
    finish: x.fr, guard: x.gd || null, verified: x.vf, model_calls: x.mc, tool_calls: x.tc,
    latency_ms: x.ms, error: x.err || null, who: x.u || null,
  }));

  return res.status(200).json({
    source: q.month ? ('archive ' + src) : 'recent (rolling 400)',
    note: 'Conversations with Dr. NoVo, saved for tuning. Identities are hashed; text is full.',
    health, trend, matched, count: rows.length, rows,
  });
};
