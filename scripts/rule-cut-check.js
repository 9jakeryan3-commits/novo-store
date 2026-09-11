// scripts/rule-cut-check.js — the `rule` cut buckets by RULE, not by sentence.
//
// The cut exists to answer "which signal is losing". That only works if two predictions from the
// same rule land in the same bucket. It read basis.split(" · ")[0].slice(0,40) on every row, which
// is correct for the signal selector ("<rule> · <receipts>") and wrong for every other source —
// free prose has no " · ", so the whole sentence becomes a 40-char bucket key and every prediction
// gets its own bucket. Seen live on build 568711e3: rule = "SPY spot 764.90 sits above flip 761.79 i".
//
// THE TEST THAT MATTERS is the aggregation one: three rows from ONE rule must give ONE bucket, and
// three free-prose rows must give NONE rather than three. A check that only asserted "returns a
// string" would have passed the broken version.
const { ruleOf } = require('../api/_lib/predictions.js');

const SELECTOR = 'flip_cross_down · SPY 764.90 below flip 761.79, GEX -163M';
const SELECTOR_SAME = 'flip_cross_down · IWM 289.42 below flip 290.90, GEX -409M';
const SELECTOR_OTHER = 'gamma_squeeze · QQQ 716.80 pinned at 717 call wall';
// Real basis strings the other writers actually produce.
const PROSE = [
  'SPY spot 764.90 sits above flip 761.79 in long gamma with dealers dampening the tape',
  'his own read of the book',
  'caught in NoVo Analyst · Pre-Market Primer',   // NOTE: contains " · " — see the case below
  'the 09:25 digest',
];

const buckets = (bases) => {
  const b = {};
  for (const x of bases) { const k = ruleOf(x); if (k !== null && k !== '') b[k] = (b[k] || 0) + 1; }
  return b;
};

const T = [
  ['selector basis yields the rule name',
    () => ruleOf(SELECTOR) === 'flip_cross_down'],
  ['THREE rows, ONE rule -> ONE bucket (the whole point of the cut)',
    () => { const b = buckets([SELECTOR, SELECTOR_SAME, SELECTOR_SAME]);
            return Object.keys(b).length === 1 && b.flip_cross_down === 3; }],
  ['two different rules -> two buckets',
    () => Object.keys(buckets([SELECTOR, SELECTOR_OTHER])).length === 2],
  ['free prose yields NO rule, not a sentence fragment',
    () => ruleOf(PROSE[0]) === null && ruleOf(PROSE[1]) === null && ruleOf(PROSE[3]) === null],
  ['the live offender specifically',
    () => ruleOf('SPY spot 764.90 sits above flip 761.79 in long gamma') === null],
  ['three prose rows -> ZERO buckets, not three',
    () => Object.keys(buckets([PROSE[0], PROSE[1], PROSE[3]])).length === 0],
  ['empty / null / undefined basis -> null',
    () => ruleOf('') === null && ruleOf(null) === null && ruleOf(undefined) === null],
  ['a rule longer than 40 chars is still capped',
    () => ruleOf('x'.repeat(60) + ' · receipts').length === 40],
  // A read-caught prediction writes "caught in <title>" and analyst titles contain " · ".
  // That is a REAL bucket key, shared by every prediction caught in that same read — so it
  // aggregates correctly and is not the defect. Asserted so nobody "fixes" it later.
  ['"caught in <title>" still aggregates by title, deliberately',
    () => ruleOf(PROSE[2]) === 'caught in NoVo Analyst'],
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
