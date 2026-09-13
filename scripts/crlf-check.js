/* Refuse to ship a file carrying DOUBLED carriage returns.
 *
 * WHY THIS EXISTS, and why a repair was not enough. public/trader-live.html has now been corrupted
 * TWICE in one day, and it compounds: an editor writing CRLF over lines that already end in CR
 * produces \r\r\n, .gitattributes `* text=auto` then strips exactly one \r per line on commit, and
 * the blob lands as \r\r\n rather than being rejected. So the guard HALVES the damage and hides it.
 * Next edit, another \r. The file grew 566,757 -> 594,956 bytes the first time, and was accumulating
 * again at ~9 KB per edit cycle when this was written.
 *
 * None of it is visible in review: git diff reports the whole file as changed, so the real 17-line
 * edit is buried under 8,700 lines of noise, and the bytes ship to members on every page load.
 *
 * The normal CRLF that core.autocrlf=true hands a Windows working copy is FINE and is not flagged —
 * only \r\r, which nothing legitimate produces.
 *
 * Run with --fix to normalise in place. Exit 1 on any finding, so deploy.sh can gate on it.
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIX = process.argv.includes('--fix');
const TEXT = /\.(html|js|css|json|md|sh|svg|txt|yml|yaml)$/i;

/* Ask git which files it TRACKS rather than walking the disk: node_modules, build output and
   anything ignored are not ours to police, and walking them is how a check becomes slow enough
   that someone removes it. */
const files = cp.execSync('git ls-files', { cwd: ROOT, maxBuffer: 1e9 })
  .toString().split('\n').filter((f) => f && TEXT.test(f));

const bad = [];
for (const rel of files) {
  const p = path.join(ROOT, rel);
  let b;
  try { b = fs.readFileSync(p); } catch (_) { continue; }

  let doubled = 0;
  for (let i = 0; i < b.length - 1; i++) if (b[i] === 13 && b[i + 1] === 13) doubled++;
  if (!doubled) continue;

  if (FIX) {
    const before = b.length;
    const out = b.toString('utf8').replace(/\r+\n/g, '\n').replace(/\r/g, '\n');
    /* Only CRs may differ. Stripping every CR from the original must equal stripping every CR
       from the result, or the normalise ate something real. */
    if (b.toString('utf8').replace(/\r/g, '') !== out.replace(/\r/g, '')) {
      console.error('!! ' + rel + ': normalise would change more than line endings -- skipped');
      bad.push(rel + ' (unsafe to fix)');
      continue;
    }
    fs.writeFileSync(p, out, 'utf8');
    console.log('  fixed  ' + rel + '  ' + before + ' -> ' + Buffer.byteLength(out)
      + ' bytes  (' + doubled + ' doubled CR removed)');
  } else {
    bad.push(rel + '  (' + doubled + ' doubled CR, ' + b.length + ' bytes)');
  }
}

if (!FIX && bad.length) {
  console.error('!! DOUBLED CARRIAGE RETURNS in ' + bad.length + ' file(s):');
  bad.forEach((f) => console.error('   ' + f));
  console.error('   an editor wrote CRLF over lines already ending in CR. This compounds on every');
  console.error('   edit, buries the real diff, and ships the bytes to members.');
  console.error('   fix:  node scripts/crlf-check.js --fix   then commit');
  process.exit(1);
}
if (FIX && bad.length) process.exit(1);
console.log('OK  no doubled carriage returns across ' + files.length + ' tracked text files');
