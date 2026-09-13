/* Only novo-token.js may delete the live credential.
 *
 * WHY. `novo_live_t` is ONE key shared by all three dashboards, and until 2026-09-12 each of them
 * deleted it unconditionally on a 401 — so a single rotated secret 401'd every dashboard at once
 * and whichever tab was open first wiped the credential for the rest. Fixing one copy achieved
 * nothing; the bug fired from the other two and merely looked addressed.
 *
 * This guard exists so a fourth call site cannot appear. It is the mechanical half of that fix:
 * the module is the correction, this is what stops the correction eroding.
 *
 * Run with --self-test to prove it can fail before believing that it passed.
 */
'use strict';
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const OWNER = 'public/js/novo-token.js';
const KEY = 'novo_live_t';

/* Where a dashboard is allowed to mention the key at all. Reading it directly is tolerated —
   plenty of call sites just need the string for a fetch — but REMOVING it is the destructive act
   and it belongs to exactly one file. */
const REMOVE = /removeItem\s*\(\s*['"`]novo_live_t['"`]\s*\)/g;

function scan(text) {
  // Comments are prose ABOUT the key, and this file's own header quotes the banned call three
  // times. Strip them first or the guard fails on its own documentation -- the exact trap that
  // bit three sessions on 09-12.
  const src = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');
  return (src.match(REMOVE) || []).length;
}

function files() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (/node_modules|\.git/.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (/\.(html|js)$/i.test(e.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, 'public'));
  return out;
}

if (process.argv.includes('--self-test')) {
  const cases = [
    ["localStorage.removeItem('novo_live_t')", 1, 'a bare delete'],
    ['localStorage.removeItem("novo_live_t")', 1, 'double quotes'],
    ["try{ localStorage.removeItem( 'novo_live_t' ); }catch(_){}", 1, 'spaced + wrapped'],
    ["/* we used to call removeItem('novo_live_t') here */", 0, 'IN A COMMENT -- must not fire'],
    ["// removeItem('novo_live_t')", 0, 'line comment -- must not fire'],
    ["localStorage.getItem('novo_live_t')", 0, 'reading is allowed'],
    ['NovoToken.clearIfExpired()', 0, 'the sanctioned path'],
  ];
  let bad = 0;
  for (const [src, want, why] of cases) {
    const got = scan(src);
    const ok = got === want;
    if (!ok) bad++;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + why.padEnd(34) + 'expected ' + want + ', got ' + got);
  }
  if (bad) { console.error('  self-test FAILED -- the guard does not discriminate'); process.exit(1); }
  console.log('  self-test ok -- fires on real deletes, silent on comments and reads');
  process.exit(0);
}

const offenders = [];
for (const f of files()) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (rel === OWNER) continue;
  const n = scan(fs.readFileSync(f, 'utf8'));
  if (n) offenders.push(rel + '  (' + n + ')');
}

if (offenders.length) {
  console.error('!! ' + offenders.length + ' file(s) delete ' + KEY + ' directly:');
  offenders.forEach((o) => console.error('   ' + o));
  console.error('   That key is shared by all three dashboards. A spurious 401 -- a rotated');
  console.error('   ANALYST_LIVE_SECRET -- hits every endpoint at once, so one tab wipes the');
  console.error('   credential for the rest and the member cannot retry.');
  console.error('   Use NovoToken.clearIfExpired(), which clears only when the token itself says so.');
  process.exit(1);
}
console.log('OK  ' + KEY + ' is deleted only by ' + OWNER);
