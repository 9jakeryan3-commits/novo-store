/* desk-columns-check.js — every Trader desk column must appear in ALL FOUR places that govern it.
 *
 * WHY THIS EXISTS. Adding the Congress panel meant touching six separate lists in one file, and I
 * found them one failure at a time, in production, twice:
 *
 *   1. the DESK registry            — missing: the panel has no mount
 *   2. #desk-rail markup            — missing: no button on desktop at all (Jake: "I do not see
 *                                     the congress tab on desktop")
 *   3. `body[data-desk=x] #col-x { display:block }`  — missing: the button does nothing
 *   4. the hide-by-default list     — missing: THE PANEL IS PERMANENTLY VISIBLE, full width,
 *                                     across the whole workspace, covering the chart, and it does
 *                                     not go away when another panel opens. A plain div with no
 *                                     rule hiding it is display:block forever.
 *   5. the desktop geometry rule    — missing: no 400px column; it falls into the document flow
 *   6. the .mob-active list         — missing: same failure again on the phone
 *
 * Four of those six are silent in the sense that the HTML looks complete and the JS runs without
 * error. Only looking at the rendered page catches them, and only if you look at the RIGHT
 * breakpoint. So they get asserted instead.
 *
 * Run: node scripts/desk-columns-check.js
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'trader-live.html');
const src = fs.readFileSync(FILE, 'utf8');

// The columns that are DESK PANELS (reached from the rail). #col-perf/#col-capital/#col-intel/
// #col-feed/#col-novo are the primary workspace columns and are governed differently.
const RAIL = [...src.matchAll(/data-desk="([a-z]+)"/g)].map((m) => m[1]);
const PANELS = [...new Set(RAIL)].filter((k) => k !== 'afeed' && k !== 'books');

const CHECKS = [
  ['DESK registry', (k) => new RegExp(`\\b${k}:\\s*\\[\\d+,`).test(src)],
  ['rail button', (k) => new RegExp(`data-desk="${k}"[^>]*onclick`).test(src)],
  ['reveal rule', (k) => new RegExp(`body\\[data-desk="${k}"\\]\\s*#col-${k}\\s*\\{[^}]*display:\\s*block`).test(src)],
  ['hidden by default', (k) => new RegExp(`#col-${k}\\b[^{]*\\{\\s*display:\\s*none`).test(src)
      || new RegExp(`#col-${k}\\s*[,\\n][^{]*\\{\\s*display:\\s*none`).test(src)
      || new RegExp(`#col-${k}\\s*,`).test(src) && /\{\s*display:\s*none\s*!important/.test(src)],
  ['desktop geometry', (k) => new RegExp(`body\\[data-desk="${k}"\\]\\s*#col-${k}\\s*\\{[^}]*position:\\s*fixed`).test(src)],
  ['mobile reveal', (k) => new RegExp(`#col-${k}\\.mob-active`).test(src)],
];

let bad = 0;
const width = Math.max(...PANELS.map((p) => p.length));
console.log('  %d desk panels found on the rail\n', PANELS.length);
for (const k of PANELS) {
  const missing = CHECKS.filter(([, fn]) => !fn(k)).map(([name]) => name);
  if (missing.length) bad++;
  console.log('  %s  %s', k.padEnd(width),
    missing.length ? 'MISSING: ' + missing.join(', ') : 'ok');
}

/* POSITIVE CONTROL. A checker that silently matches nothing prints a clean sheet and means
   nothing at all — the exact failure mode this file is about. Prove the assertions can fail by
   running them against a panel key that does not exist. */
const ghost = CHECKS.filter(([, fn]) => fn('doesnotexist')).map(([n]) => n);
console.log('\n  control (a panel that does not exist should fail every check): %s',
  ghost.length ? 'BROKEN — these passed anyway: ' + ghost.join(', ') : 'all six correctly fail');
if (ghost.length) process.exit(1);

console.log('  %s', bad ? `\n  ${bad} panel(s) incomplete` : '\n  every desk panel is wired in all six places');
process.exit(bad ? 1 : 0);
