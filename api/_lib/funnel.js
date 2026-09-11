// api/_lib/funnel.js — count the four stages, so the bar can be tuned against something.
//
// Jake, 2026-09-09, describing what a healthy day looks like:
//   "100s to 1000s of reads from the Eye/Collector, <100 alerts, <10 released comp seat alerts,
//    and like ~1 prediction a day from Dr. NoVo. anything else and the system/Dr. NoVo is fire
//    hosing and not getting anywhere or working as it should to improve."
//
// Those are RATIOS, and the ratio is the tuning signal — not any single stage's count. If reads
// become alerts one-in-two instead of one-in-twenty, the alert bar is too loose and nothing
// downstream can fix it. If he fires forty times a day his bar is too loose; if he fires zero for
// a week his bar is too tight, or he is not being reached at all, and those two look identical
// from the outside. Nothing counted any of it until now.
//
// ⚠ THIS COUNTS, IT DOES NOT GATE. No stage here may ever refuse anything. The moment a counter
// starts capping, the numbers stop describing the system and start describing the cap — and Jake
// ruled that out explicitly: "we dont want to restrict it with a max output."
//
// ⚠ TOTALS ARE PERMANENT, DAYS EXPIRE. `funnel:total` has no TTL, same rule as the prediction
// tally: useful data is not deleted. The per-day hashes carry 400 days so a year of ratios is
// always in reach without the key count growing forever.
//
// ⚠ NEVER THROWS, NEVER BLOCKS. Every call is best-effort. A counter that can break an ingest is
// worse than no counter.

const { kv } = require('../_kv.js');

// The stages, in order. Named for what Jake called them.
/* `errored` added 2026-09-11. After bump('asked') there are FOUR possible outcomes and only two
   were counted: a considered no (declined) and a call (calls). A model error and an unparseable
   response both returned declined:true and incremented NOTHING, so an outage vanished from the
   funnel instead of appearing in it. Measured live: asked 254, declined 253, calls 0 — one ask
   already lost, and a day of Vertex failures would have read "asked 86, declined 0, calls 0",
   which nobody can distinguish from an analyst who simply said no 86 times.
   ITS OWN STAGE, NOT FOLDED INTO declined, because a crashed model call and a considered no are
   OPPOSITE problems: one is an outage to fix, the other is a bar to tune. Sharing a counter is
   how the tuning number hides the outage. */
const STAGES = ['reads', 'alerts', 'released', 'calls', 'asked', 'skipped', 'declined', 'errored'];

/** ET calendar day — the same clock the trading day and the record already use. */
function etDay(ms) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms || Date.now()));
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}

/**
 * Add n to a stage. Fire-and-forget: callers must not await correctness on it.
 * @param {string} stage one of STAGES
 * @param {number} n     defaults to 1
 */
async function bump(stage, n) {
  try {
    if (!STAGES.includes(stage)) return;
    const c = Number(n == null ? 1 : n);
    if (!isFinite(c) || c <= 0) return;
    const r = kv();
    if (!r) return;
    const day = 'funnel:' + etDay();
    await r.hincrby(day, stage, c);
    await r.expire(day, 400 * 24 * 3600);
    await r.hincrby('funnel:total', stage, c);       // no TTL: the permanent record
  } catch (_) { /* a counter must never cost the thing it is counting */ }
}

/** Read the last `days` ET days plus the all-time totals. Read-only. */
async function funnel(days) {
  const r = kv();
  if (!r) return { error: 'kv unavailable', days: [], total: null };
  const want = Math.max(1, Math.min(Number(days) || 14, 60));
  const out = [];
  const now = Date.now();
  for (let i = 0; i < want; i++) {
    const day = etDay(now - i * 86400000);
    let h = null;
    try { h = await r.hgetall('funnel:' + day); } catch (_) { h = null; }
    if (!h || !Object.keys(h).length) { out.push({ day, empty: true }); continue; }
    const row = { day };
    for (const s of STAGES) row[s] = Number(h[s] || 0);
    /* The ratios ARE the signal, so they are computed here rather than left to a caller who may
       or may not bother. Guarded: a zero upstream stage makes a ratio undefined, not Infinity. */
    row.reads_per_alert = row.alerts ? +(row.reads / row.alerts).toFixed(1) : null;
    row.alerts_per_release = row.released ? +(row.alerts / row.released).toFixed(1) : null;
    row.released_per_call = row.calls ? +(row.released / row.calls).toFixed(1) : null;
    out.push(row);
  }
  let t = null;
  try { t = await r.hgetall('funnel:total'); } catch (_) { t = null; }
  const total = t ? Object.fromEntries(STAGES.map((s) => [s, Number(t[s] || 0)])) : null;
  return { days: out, total };
}

module.exports = { bump, funnel, STAGES };
