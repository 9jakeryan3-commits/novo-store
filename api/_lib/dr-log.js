// api/_lib/dr-log.js — every conversation with Dr. NoVo, saved for tuning.
//
// Jake, 2026-09-10: "we need to be saving every conversation with Dr. NoVo somewhere so we can
// easily tune and make sure he is the perfect analyst and not bugging out."
//
// This is NOT api/chat-log.js. That one syncs a member's own transcript across their devices for
// their convenience (30-day TTL, per member). This is the internal quality record: every turn
// across every seat, kept so the desk can be tuned and its failures caught.
//
// ⚠ THE FAILURES ARE THE POINT, NOT AN AFTERTHOUGHT. "Not bugging out" is the ask, so a turn that
// came back EMPTY, ERRORED, hit the record-guard, or had a tool fail is logged with the same care
// as a clean one and counted separately. A log that only kept the good answers would hide exactly
// what it exists to surface.
//
// ⚠ NOTHING IS DELETED. Full records append into `dr:log:<YYYY-MM>` with NO TTL — the standing rule
// on this system is that useful data is never deleted, and a month of conversations is the corpus
// the tuning runs on. `dr:log:recent` is a rolling 400-turn convenience view and MAY be trimmed,
// because the durable copy is already in the monthly bucket.
//
// ⚠ IDENTITIES ARE HASHED, READS ARE GATED. The email never becomes a key or a value — it is the
// same 16-char sha256 prefix member-memory.js uses. The read endpoint (api/dr-log.js) is behind the
// ops secret. These are real member conversations; they are kept for quality, not exposure.
//
// ⚠ BEST-EFFORT, NEVER BLOCKS THE ANSWER. A logging failure must never cost a subscriber their
// reply. Every path is wrapped; logTurn resolves even when KV is down.

const { kv } = require('../_kv.js');

const MAX_Q = 4000;        // a question, capped — a pasted essay is not a question
const MAX_A = 12000;       // a deep desk report is long; a runaway one is not
const RECENT_KEEP = 400;   // the rolling quick-view window
const DAY_TTL_S = 400 * 24 * 3600;

function etParts(ms) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return { ym: g('year') + '-' + g('month'), ymd: g('year') + '-' + g('month') + '-' + g('day') };
}

function clip(s, n) {
  if (s == null) return null;
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…[' + s.length + ']' : s;
}

/**
 * Record one Dr. NoVo turn. Fire-and-forget from the caller's view: awaited, but never rejects.
 *
 * @param {object} r
 *   app        'analyst' | 'trader' | 'crypto'
 *   seat       'comp' | 'member' | 'anon'
 *   userHash   16-char email hash, or null
 *   deep       boolean (the flagship deep-read lane)
 *   status     'ok' | 'empty' | 'error'  — the health signal
 *   question   the member's text
 *   answer     Dr. NoVo's text (null on empty/error)
 *   tools      [{ tool, ok, empty }]  (the ledger)
 *   modelCalls / toolCalls   counts
 *   finishReason             the model's stop reason
 *   guard      { fabricated, mislabeled, uncaveated } | null  (record-guard hits)
 *   verified   corrected-figure count | null
 *   ms         latency in milliseconds
 *   error      message | null
 */
async function logTurn(r) {
  try {
    const c = kv();
    if (!c) return;
    const t = Date.now();
    const { ym, ymd } = etParts(t);
    const app = ['analyst', 'trader', 'crypto'].includes(r.app) ? r.app : 'analyst';
    const seat = ['comp', 'member', 'anon'].includes(r.seat) ? r.seat : 'anon';
    const status = ['ok', 'empty', 'error'].includes(r.status) ? r.status : 'ok';
    const guard = r.guard && (r.guard.fabricated || r.guard.mislabeled || r.guard.uncaveated)
      ? { f: r.guard.fabricated | 0, m: r.guard.mislabeled | 0, c: r.guard.uncaveated | 0 } : null;

    const rec = {
      t, app, seat, u: r.userHash || null, deep: r.deep ? 1 : 0, st: status,
      q: clip(r.question, MAX_Q), a: clip(r.answer, MAX_A),
      tl: Array.isArray(r.tools) ? r.tools.map((l) => ({ n: l.tool, ok: l.ok ? 1 : 0, e: l.empty ? 1 : 0 })) : [],
      mc: r.modelCalls | 0, tc: r.toolCalls | 0,
      fr: r.finishReason || null, gd: guard, vf: (r.verified != null ? (r.verified | 0) : null),
      ms: r.ms | 0, err: r.error ? clip(r.error, 300) : null,
    };
    const line = JSON.stringify(rec);

    // durable, no TTL — the archive the tuning reads
    await c.rpush('dr:log:' + ym, line).catch(() => {});
    // rolling quick-view — trimmed, because the durable copy already exists
    await c.rpush('dr:log:recent', line).catch(() => {});
    await c.ltrim('dr:log:recent', -RECENT_KEEP, -1).catch(() => {});

    // counters: the health dashboard, no TTL
    const tally = {
      turns: 1, ['st:' + status]: 1, ['app:' + app]: 1, ['seat:' + seat]: 1,
    };
    if (rec.deep) tally.deep = 1;
    if (guard) tally.guarded = 1;
    for (const l of rec.tl) { tally['tool:' + l.n] = (tally['tool:' + l.n] || 0) + 1; if (!l.ok) tally['toolfail:' + l.n] = (tally['toolfail:' + l.n] || 0) + 1; }
    for (const [k, v] of Object.entries(tally)) await c.hincrby('dr:log:tally', k, v).catch(() => {});

    // per-day trend, kept ~13 months
    const dk = 'dr:log:day:' + ymd;
    await c.hincrby(dk, 'turns', 1).catch(() => {});
    await c.hincrby(dk, status, 1).catch(() => {});
    await c.expire(dk, DAY_TTL_S).catch(() => {});
  } catch (_) { /* a quality log must never cost a subscriber their answer */ }
}

module.exports = { logTurn };
