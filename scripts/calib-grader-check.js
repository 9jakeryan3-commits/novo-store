#!/usr/bin/env node
// scripts/calib-grader-check.js — the grader vs probe rows, against a mock KV.
//
// THE STALL THIS EXISTS TO CATCH (Jerni, 09-11): the writer LPUSHes to the HEAD of calib:pending,
// the trim evicts from the TAIL at 500, and the grader reads ONLY the newest 50. A probe row that
// is skipped-but-never-LREM'd therefore sits at the head forever; one battery run stacks several;
// at 50 the grading window is all probes, every real forecast behind them ages off the tail
// ungraded, and cells stop growing WITH NOTHING ERRORING — it reads exactly like "nobody is
// voicing forward reads lately". So "the grader skips probe rows" has to mean LREM, and a suite
// that only checks the cells passes on a grader that quietly stopped working. Three assertions,
// and the third is the positive control that catches the stall:
//   1. probe rows count NOTHING — no n, no hit, no cens (asserted per-field, on their own bucket)
//   2. probe rows LEAVE pending — due or not due
//   3. the real row behind them WAS graded — the window was not starved
//
// Shown to fail before the grader skip existed: assertion 1 failed on the due probe (graded into
// cells) and assertion 2 on the undue probe (left clogging the head). Do not soften either.

'use strict';
const gradeDueForecasts = require('../api/analyst-ask.js').gradeDueForecasts;

if (typeof gradeDueForecasts !== 'function') {
  console.error('FAIL cannot reach gradeDueForecasts on the analyst-ask module');
  process.exit(1);
}

// ── minimal in-memory KV: just the five ops the grader uses ────────────────────────────────────
const store = { lists: new Map(), hashes: new Map() };
const L = (k) => { if (!store.lists.has(k)) store.lists.set(k, []); return store.lists.get(k); };
const H = (k) => { if (!store.hashes.has(k)) store.hashes.set(k, {}); return store.hashes.get(k); };
const r = {
  async lrange(k, a, b) { return L(k).slice(a, b + 1); },
  async lrem(k, _count, v) {
    const l = L(k); const i = l.indexOf(v);
    if (i === -1) return 0;
    l.splice(i, 1); return 1;
  },
  async lpush(k, v) { L(k).unshift(v); return L(k).length; },
  async ltrim(k, a, b) { store.lists.set(k, L(k).slice(a, b + 1)); return 'OK'; },
  async hincrby(k, f, by) { const h = H(k); h[f] = (h[f] || 0) + by; return h[f]; },
};

const now = Date.now();
const mkRow = (over) => ({
  id: 'test' + Math.random().toString(36).slice(2, 6),
  asked_at: now, claim: 'test row', confidence: 65,
  ticker: 'SPY', metric: 'spot_above', level: 100, horizon_min: 60, anchor: 'now', ...over,
});

// Probes on bucket 75, the real row on 65 — so a probe leaking into the cells shows up under a
// key the real row cannot have touched. A shared bucket could not discriminate.
const probeDue   = mkRow({ source: 'probe', confidence: 75, asked_at: now - 2 * 3600e3 });
const probeUndue = mkRow({ source: 'probe', confidence: 75, asked_at: now });
const realDue    = mkRow({ asked_at: now - 2 * 3600e3 });   // due an hour ago, SLACK long past

// Head-first, probes at the head — the exact clog arrangement.
store.lists.set('calib:pending', [probeDue, probeUndue, realDue].map((x) => JSON.stringify(x)));
// One hist sample 1 minute from the real row's horizon, above its level -> a clean HIT.
store.lists.set('public:levels:hist:SPY',
  [JSON.stringify({ t: realDue.asked_at + 60 * 60000 + 60000, s: 105 })]);

(async () => {
  await gradeDueForecasts(r);

  let f = 0;
  const t = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { f++; console.log('FAIL', label, '->', got, 'want', want); }
    else console.log('ok  ', label);
  };

  const cells = H('calib:cells');
  const pending = L('calib:pending').map((x) => JSON.parse(x));

  // 1. probes counted NOTHING — every field of their bucket, not just n
  t('probe bucket has no n',    cells['75:n']    || 0, 0);
  t('probe bucket has no hit',  cells['75:hit']  || 0, 0);
  t('probe bucket has no cens', cells['75:cens'] || 0, 0);

  // 2. probes LEFT pending — due or not, they must not clog the head
  t('no probe row remains in pending', pending.filter((c) => c.source === 'probe').length, 0);

  // 3. positive control: the real row behind the probes WAS graded
  t('real row graded: n counted',   cells['65:n']   || 0, 1);
  t('real row graded: hit counted', cells['65:hit'] || 0, 1);
  t('real row left pending', pending.length, 0);

  console.log(f ? f + ' FAILURE(S)' : 'calib grader suite: ALL PASS (7)');
  process.exit(f ? 1 : 0);
})();
