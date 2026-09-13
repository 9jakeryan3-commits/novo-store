#!/usr/bin/env node
/**
 * Structural <div> balance across the store pages.
 *
 * ⚠ STRIP SCRIPTS, STYLES AND COMMENTS BEFORE COUNTING ANYTHING. A raw tag grep counts `<div`
 * inside a JS string or a CSS comment as structure, which is how an audit ends up reporting
 * "6 declarations across 4 values" for something that has one. The same rule applies to the
 * VERIFICATION, not just the measurement: the success criterion here is the structural count
 * reaching zero, and a verification that counts raw tags will find `<div` in a script and report
 * a fixed page as still broken.
 *
 * Run:  node scripts/div-balance.js            report every imbalanced page
 *       node scripts/div-balance.js --self-test prove the counter can fail before believing it
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');

/* Order matters: comments first (a comment can contain a whole script block), then scripts and
   styles, then attribute values (a `data-x="<div>"` is not structure either). */
function structural(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/="[^"]*"/g, '=""');
}

function balance(html) {
  const s = structural(html);
  const open = (s.match(/<div\b/gi) || []).length;
  const close = (s.match(/<\/div\s*>/gi) || []).length;
  return { open, close, delta: open - close };
}

function pages() {
  return fs.readdirSync(PUB)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(PUB, f));
}

if (process.argv.includes('--self-test')) {
  // A counter that has never been shown to fail is decoration.
  const cases = [
    ['balanced', '<div><div></div></div>', 0],
    ['one stray closer', '<div></div></div>', -1],
    ['two stray closers', '<div></div></div></div>', -2],
    ['unclosed opener', '<div><div></div>', 1],
    ['div inside a SCRIPT must not count', '<div></div><script>var a="<div><div>";</script>', 0],
    ['div inside a COMMENT must not count', '<div></div><!-- <div><div> -->', 0],
    ['div inside a STYLE must not count', '<div></div><style>/* <div> */</style>', 0],
    ['div inside an ATTRIBUTE must not count', '<div data-x="<div></div>"></div>', 0],
  ];
  let bad = 0;
  for (const [name, html, want] of cases) {
    const got = balance(html).delta;
    const ok = got === want;
    if (!ok) bad++;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(40) + 'delta ' + got + ' (want ' + want + ')');
  }
  console.log(bad ? '\n  self-test FAILED — the counter is not trustworthy' : '\n  self-test ok — counter distinguishes structure from text, and can report both signs');
  process.exit(bad ? 1 : 0);
}

const rows = [];
for (const p of pages()) {
  const html = fs.readFileSync(p, 'utf8');
  const b = balance(html);
  rows.push({ f: path.basename(p), ...b, chrome: /class="nav-inner"/.test(html) });
}

const bad = rows.filter((r) => r.delta !== 0);
const withChrome = rows.filter((r) => r.chrome);
const without = rows.filter((r) => !r.chrome);

console.log('pages scanned: ' + rows.length
  + '   with sitewide chrome: ' + withChrome.length
  + '   without: ' + without.length);
console.log('imbalanced: ' + bad.length
  + '   (with chrome ' + bad.filter((r) => r.chrome).length
  + ', without chrome ' + bad.filter((r) => !r.chrome).length + ')');

const byDelta = {};
for (const r of bad) byDelta[r.delta] = (byDelta[r.delta] || 0) + 1;
console.log('delta distribution: ' + JSON.stringify(byDelta));

if (bad.length) {
  console.log('\nimbalanced pages:');
  for (const r of bad.sort((a, b) => a.delta - b.delta)) {
    console.log('   ' + String(r.delta).padStart(3) + '   ' + r.f.padEnd(34)
      + r.open + ' open / ' + r.close + ' close' + (r.chrome ? '' : '   [no chrome]'));
  }
}
process.exit(bad.length ? 1 : 0);
