#!/usr/bin/env node
/* Keep the track-record figures on the marketing pages equal to what /api/track-record actually
 * publishes — split by PROVENANCE, which is the entire point.
 *
 * The old `data-live-sessions` marker rendered ONE pooled figure ("1,031 scored sessions") that was
 * ~97% reconstructed backtest and ~3% live-logged sessions, and one page called it "logged
 * sessions" outright. Live vs replay must never pool into one headline — a fire NoVo published is
 * a record, one replayed through the state machine is a backtest — so the pages now carry four
 * markers and this stamper keeps each one honest:
 *
 *   data-tr-scored     sessions_scored   (live + archive, the total graded)
 *   data-tr-live       sessions_logged   (published live, the only number allowed to say "logged")
 *   data-tr-arch       scored - live     (the reconstructed archive)
 *   data-tr-snapshots  snapshots         (this one sat hand-typed at 23,953 while the API said 31,203)
 *
 * Same contract as sync-crypto-counts.js: hand-typed numbers wearing an auto-updater's costume are
 * the trap; anchored markers plus a build-time stamp are the fix. Network failure is not fatal —
 * a deploy must not depend on the box being up — but a FAILED PARSE of a fetched body is, because
 * stamping garbage is worse than stamping nothing.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = process.env.NOVO_STORE_URL || 'https://novo-options.trade';
const PUB = path.join(__dirname, '..', 'public');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = require('https').get(url, { headers: { 'User-Agent': 'novo-build' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  let tr;
  try {
    tr = await get(SRC + '/api/track-record');
  } catch (e) {
    console.warn('!! track-record counts NOT synced (' + e.message + ') -- leaving the pages as they are');
    return;
  }
  const scored = Number(tr.sessions_scored) || 0;
  const live = Number(tr.sessions_logged) || 0;
  const snaps = Number(tr.snapshots) || 0;
  const arch = scored - live;
  if (!scored || !live || arch <= 0 || !snaps) {
    console.warn('!! track-record figures look wrong (scored=' + scored + ' live=' + live
      + ' snaps=' + snaps + ') -- not writing');
    return;
  }
  const nn = (v) => v.toLocaleString('en-US');

  // Attribute-anchored, never a bare number: one marker may carry extra attributes.
  const rules = [
    ['data-tr-scored', /(<span[^>]*data-tr-scored[^>]*>)[\d,]+(<\/span>)/g, '$1' + nn(scored) + '$2'],
    ['data-tr-live', /(<span[^>]*data-tr-live[^>]*>)[\d,]+(<\/span>)/g, '$1' + nn(live) + '$2'],
    ['data-tr-arch', /(<span[^>]*data-tr-arch[^>]*>)[\d,]+(<\/span>)/g, '$1' + nn(arch) + '$2'],
    ['data-tr-snapshots', /(<span[^>]*data-tr-snapshots[^>]*>)[\d,]+(<\/span>)/g, '$1' + nn(snaps) + '$2'],
  ];

  const files = fs.readdirSync(PUB)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(PUB, f))
    .filter((p) => /data-tr-(scored|live|arch|snapshots)/.test(fs.readFileSync(p, 'utf8')));

  let touched = 0;
  for (const p of files) {
    const before = fs.readFileSync(p, 'utf8');
    let after = before;
    for (const [, re, sub] of rules) after = after.replace(re, sub);
    if (after !== before) { fs.writeFileSync(p, after); touched++; }
  }
  console.log(touched
    ? '.. track-record counts synced across ' + touched + ' file(s) -> ' + nn(scored)
      + ' scored (' + nn(live) + ' live + ' + nn(arch) + ' archive), ' + nn(snaps) + ' snapshots'
    : '.. track-record counts already current across ' + files.length + ' file(s) ('
      + nn(scored) + ' scored, ' + nn(live) + ' live, ' + nn(snaps) + ' snapshots)');
})();
