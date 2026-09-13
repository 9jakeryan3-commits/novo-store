/* Does the strip/restore pair actually protect a concurrent edit?
 *
 * The claim being tested is the one that made me rewrite Yuri's patch: a blanket
 * `git checkout -- public/` would destroy any file another session saved during the deploy.
 * A comment saying "we restore safely" is worth nothing until the restore has been SHOWN to
 * decline. Three cases, run against a sandbox root, each asserted.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');

const SB = path.join(os.tmpdir(), 'novo-strip-test');
const STASH = path.join(os.tmpdir(), 'novo-strip-stash');
const S = 'C:/Trading Algo/novo-store/scripts';

fs.rmSync(SB, { recursive: true, force: true });
fs.rmSync(STASH, { recursive: true, force: true });
fs.mkdirSync(path.join(SB, 'sub'), { recursive: true });

const UNTOUCHED = '<!doctype html>\n<!-- keep me -->\n<p>a</p>\n';
const EDITED    = '<!doctype html>\n<!-- also me -->\n<p>b</p>\n';
fs.writeFileSync(path.join(SB, 'untouched.html'), UNTOUCHED);
fs.writeFileSync(path.join(SB, 'sub', 'edited.html'), EDITED);

const run = (script, ...args) =>
  cp.spawnSync('node', [path.join(S, script), ...args], { encoding: 'utf8' });

let fail = 0;
const check = (name, ok, detail) => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(52) + (detail || ''));
  if (!ok) fail++;
};

// ── strip ────────────────────────────────────────────────────────────────────────────────────
const s = run('strip-for-deploy.js', SB);
check('strip ran', s.status === 0, (s.stdout || s.stderr || '').trim().slice(0, 60));
const strippedU = fs.readFileSync(path.join(SB, 'untouched.html'), 'utf8');
check('comments actually removed (positive control)', !strippedU.includes('keep me'));
check('stash + manifest created', fs.existsSync(path.join(STASH, 'manifest.json')));

// ── a second session saves one of the files MID-DEPLOY ───────────────────────────────────────
const CONCURRENT = '<!doctype html>\n<p>another session wrote this</p>\n';
fs.writeFileSync(path.join(SB, 'sub', 'edited.html'), CONCURRENT);

// ── restore ──────────────────────────────────────────────────────────────────────────────────
const r = run('restore-after-strip.js');
check('restore exits 0 even when it skips', r.status === 0);

const backU = fs.readFileSync(path.join(SB, 'untouched.html'), 'utf8');
const backE = fs.readFileSync(path.join(SB, 'sub', 'edited.html'), 'utf8');

check('untouched file restored byte-exact', backU === UNTOUCHED);
check('CONCURRENT EDIT NOT CLOBBERED', backE === CONCURRENT,
      backE === CONCURRENT ? '' : '<-- git checkout would have destroyed this');
check('the skip was REPORTED, not silent', /CHANGED during the deploy/.test(r.stderr || ''));
check('stash KEPT when something was skipped', fs.existsSync(path.join(STASH, 'manifest.json')));

// ── re-stripping on top of an unrestored stash must REFUSE ───────────────────────────────────
const again = run('strip-for-deploy.js', SB);
check('refuses to strip over an unrestored stash', again.status !== 0
  && /never restored/.test(again.stderr || ''));

fs.rmSync(STASH, { recursive: true, force: true });
fs.rmSync(SB, { recursive: true, force: true });
console.log(fail ? '\n  ' + fail + ' FAILED' : '\n  all checks passed');
process.exit(fail ? 1 : 0);
