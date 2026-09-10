// scripts/caveat-check.js — the sabotage suite for caveatAudit. Run after touching it.
//
// Mostly NEGATIVE cases on purpose. Widening a guard is exactly where false positives appear, and
// a guard that flags honest answers gets switched off by whoever is on call — so the cases that
// must stay CLEAN outnumber the one that must flag.
//
// The positive case is the real sentence from a live deep read on the comp seat, 2026-09-09:
// "93.9% hit rate across 280 independent coin-day cells" quoted as the corpus the engine calls
// fell short of, while the words mechanical / construction / timing were absent from all 3,793
// characters of that answer. Right number, right cell, right denominator, prohibition dropped.
const { caveatAudit } = require('../api/_lib/analyst-brain.js');

const CELL = {
  crypto: { baseRates: {
    cost_anomaly: {
      n_claims: 921, n_cells: 280, hit: 865, rate: 93.9, trustworthy: true,
      note: "Near-mechanical: an anomalously wide spread narrows mostly by construction. The alert's value is the timing; this rate must never be quoted as edge.",
    },
    gamma_damp: { n_cells: 140, rate: 61.2, note: 'Ordinary cell, no prohibition, quote it freely.' },
  } },
};
const MJ = JSON.stringify(CELL);

const REAL_VIOLATION = 'While the underlying historical corpus shows a 93.9% hit rate across 280 ' +
  'independent coin-day cells, the short-horizon 4-hour engine instances struggled against momentum.';
const CAVEAT_CARRIED = 'The cost anomaly corpus shows 93.9%, but that is near-mechanical — a wide ' +
  'spread narrows mostly by construction, so the value is the timing, not edge.';
const OTHER_CELL = 'My gamma damp cell scores 61.2% across 140 coin-day cells.';
const NO_FIGURE = 'My engine calls have underperformed and I have halted that rule.';

const T = [
  ['the live violation flags', () => caveatAudit(REAL_VIOLATION, MJ).length === 1],
  ['...and names the RATE, not the denominator', () => caveatAudit(REAL_VIOLATION, MJ)[0].value === 93.9],
  ['caveat carried -> CLEAN', () => caveatAudit(CAVEAT_CARRIED, MJ).length === 0],
  ['cell without a prohibition never flags', () => caveatAudit(OTHER_CELL, MJ).length === 0],
  ['figure absent -> CLEAN', () => caveatAudit(NO_FIGURE, MJ).length === 0],
  ['empty answer -> CLEAN', () => caveatAudit('', MJ).length === 0],
  ['unparseable payload -> CLEAN (fails open)', () => caveatAudit(REAL_VIOLATION, 'not json').length === 0],
  ['null payload -> CLEAN', () => caveatAudit(REAL_VIOLATION, null).length === 0],
  ['bare small integers do not collide', () => caveatAudit('I ran 3 rounds and 5 checks.', MJ).length === 0],
  ['one flag per cell, not one per figure', () => caveatAudit(REAL_VIOLATION + ' Also 921 claims over 280 cells.', MJ).length === 1],
];

let pass = 0;
for (const [name, fn] of T) {
  let ok = false, err = '';
  try { ok = !!fn(); } catch (e) { err = ' THREW ' + e.message; }
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + err);
  if (ok) pass++;
}
console.log('\n' + pass + '/' + T.length);
process.exit(pass === T.length ? 0 : 1);
