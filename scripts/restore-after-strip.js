/* Undo strip-for-deploy.js. Runs from deploy.sh's trap, so it fires on EVERY exit path —
 * success, a failed deploy, or a Ctrl-C.
 *
 * ⚠ THE WHOLE POINT: this restores from SAVED BYTES, not from git, and it refuses to touch a file
 * that changed after the strip. `git checkout -- public/` would be one line and would silently
 * destroy anything another session saved during the 60-90s the deploy was running — five agents
 * write into public/ during a fleet run. Here, a file whose current hash does not match what the
 * stripper wrote is somebody else's edit: it is skipped and reported, never overwritten.
 *
 * Exits 0 even when it skips. It runs inside a trap, and an EXIT handler that fails would mask the
 * deploy's own status — the skipped files are printed loudly instead, which is the thing a human
 * needs to see. A missing manifest is also exit 0: it means no strip ran, which is normal.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const STASH = path.join(os.tmpdir(), 'novo-strip-stash');
const MANIFEST = path.join(STASH, 'manifest.json');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

if (!fs.existsSync(MANIFEST)) process.exit(0);   // nothing was stripped

let man;
try { man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
catch (e) {
  console.error('!! strip manifest unreadable (' + e.message + ') -- public/ may still be stripped');
  console.error('   originals are in ' + STASH + ' -- do NOT commit public/ until this is resolved');
  process.exit(0);
}

let restored = 0, already = 0;
const skipped = [], missing = [];

for (const e of man.entries) {
  const live = path.join(man.root, e.rel);
  const backup = path.join(STASH, e.rel);
  if (!fs.existsSync(backup)) { missing.push(e.rel); continue; }

  let cur = null;
  try { cur = fs.readFileSync(live); } catch (_) { /* deleted mid-deploy; treat as not ours */ }

  if (cur && sha(cur) === e.originalSha) { already++; continue; }   // someone already put it back
  if (cur && sha(cur) !== e.strippedSha) { skipped.push(e.rel); continue; }  // edited since strip

  fs.copyFileSync(backup, live);
  restored++;
}

if (skipped.length) {
  console.error('!! ' + skipped.length + ' file(s) CHANGED during the deploy and were NOT restored:');
  skipped.slice(0, 20).forEach((f) => console.error('   ' + f));
  console.error('   another session edited these mid-deploy. Their edit is intact, but it sits on');
  console.error('   top of STRIPPED content -- the comments are gone from the working copy.');
  console.error('   originals: ' + STASH + '  (kept, not deleted)');
}
if (missing.length) {
  console.error('!! ' + missing.length + ' backup(s) missing from the stash -- ' + missing.slice(0, 5).join(', '));
}

const clean = !skipped.length && !missing.length;
if (clean) fs.rmSync(STASH, { recursive: true, force: true });

console.log('.. comments restored to ' + restored + ' file(s)'
  + (already ? ', ' + already + ' already original' : '')
  + (clean ? '' : '  [STASH KEPT -- see above]'));
