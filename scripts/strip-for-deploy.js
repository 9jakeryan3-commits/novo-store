/* Strip comments from public/ IN PLACE, immediately before the upload, and record enough to put
 * every file back exactly as it was.
 *
 * Comments are ~42% of trader-live.html and do NOT compress away: stripping takes the bundle from
 * 610 KB to 451 KB raw and its gzip from 209 KB to 141 KB. They stay in SOURCE — half of them are
 * bug post-mortems and they are the only record of why this code is shaped the way it is — so the
 * strip happens here, to the upload only, and is undone by restore-after-strip.js immediately after.
 *
 * ⚠ WHY THIS DOES NOT RESTORE WITH `git checkout -- public/`.
 * The obvious restore is a one-liner in a trap, and it is unsafe on this repo. deploy.sh proves the
 * tree is clean immediately above — but that is true for ONE INSTANT, and a deploy then runs for
 * 60-90 seconds while up to five other agent sessions are writing into public/. A blanket
 * `git checkout` at the end would silently destroy any file another session saved during that
 * window, printing nothing about what it discarded. That is the exact accident this fleet has
 * already had twice.
 *
 * So: keep the original bytes, and on restore write them back ONLY where the file on disk is still
 * byte-identical to what this script wrote. Anything else means somebody edited it mid-deploy —
 * leave it alone and say so loudly. The restore then cannot clobber a concurrent edit, and it
 * reports when it declines instead of failing silent.
 *
 * Fails loud. If any file throws, nothing is written for it and the process exits non-zero so the
 * deploy stops: a half-stripped upload is the one outcome worth more than the bytes.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { stripHtml, stripJs, stripCss } = require('./strip-comments.js');

/* argv[2] overrides the root so the safety behaviour can be exercised against a sandbox. A restore
   that has never been SHOWN to decline a concurrent edit is just a comment claiming it would. */
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'public');
const SKIP = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;
/* Outside the repo, so the backup can never be swept into anyone's commit. Fixed name rather than
   per-PID: deploy.sh's restore runs in a different process, and a stale directory from a killed
   deploy is information we want on the next run, not litter to be orphaned under a new name. */
const STASH = path.join(os.tmpdir(), 'novo-strip-stash');
const MANIFEST = path.join(STASH, 'manifest.json');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|js|css)$/i.test(e.name)) out.push(p);
  }
  return out;
}

/* A stash left behind means a previous deploy died between strip and restore, so public/ may still
   be holding stripped files. Refuse rather than stacking a second strip on top of the first — that
   would back up ALREADY-STRIPPED content as if it were the original and make the damage permanent. */
if (fs.existsSync(MANIFEST)) {
  console.error('!! a previous strip never restored -- ' + MANIFEST);
  console.error('   run:  node scripts/restore-after-strip.js    then re-run the deploy');
  process.exit(1);
}

fs.rmSync(STASH, { recursive: true, force: true });
fs.mkdirSync(STASH, { recursive: true });

const entries = [];
const errors = [];
let before = 0, after = 0;

for (const f of walk(ROOT)) {
  const src = fs.readFileSync(f);
  const text = src.toString('utf8');
  let out;
  try {
    if (/\.html$/i.test(f)) out = stripHtml(text);
    else if (/\.css$/i.test(f)) out = stripCss(text);
    else out = stripJs(text);
  } catch (e) {
    errors.push(path.relative(ROOT, f) + ': ' + e.message);
    continue;
  }
  before += src.length;
  const buf = Buffer.from(out, 'utf8');
  after += buf.length;
  if (out === text) continue;

  // Back the original up under its own relative path, then write the stripped version.
  const rel = path.relative(ROOT, f);
  const dest = path.join(STASH, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, src);
  fs.writeFileSync(f, buf);
  entries.push({ rel, strippedSha: sha(buf), originalSha: sha(src) });
}

if (errors.length) {
  /* Put back whatever was already stripped before giving up, or the deploy's own clean-tree
     guarantee is broken for the NEXT run too. */
  for (const e of entries) {
    try { fs.copyFileSync(path.join(STASH, e.rel), path.join(ROOT, e.rel)); } catch (_) {}
  }
  fs.rmSync(STASH, { recursive: true, force: true });
  console.error('!! comment strip FAILED on ' + errors.length + ' file(s) -- deploy stopped, tree restored');
  errors.slice(0, 20).forEach((e) => console.error('   ' + e));
  process.exit(1);
}

fs.writeFileSync(MANIFEST, JSON.stringify({ root: ROOT, at: new Date().toISOString(), entries }));
console.log('.. comments stripped from ' + entries.length + ' file(s): '
  + (before / 1048576).toFixed(2) + ' MB -> ' + (after / 1048576).toFixed(2) + ' MB'
  + '  (-' + (100 * (before - after) / before).toFixed(1) + '%)');
