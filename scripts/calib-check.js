#!/usr/bin/env node
// scripts/calib-check.js — proves the calibration grader scores what happened, not what's convenient.
//
// The loop: log_forecast captures voiced level claims (resolvable by construction), this grader
// resolves them against public:levels:hist, cells aggregate per confidence bucket, calibBlock
// feeds the result back into the prompt, track-record publishes it, the chain records it.
// This suite sabotages the grader both directions: a hit must count, a miss must count, a claim
// with no gradable sample must be CENSORED (never a miss), and a claim another lambda already
// took must count NOTHING. Run after touching gradeDueForecasts or the cells shape.

const fs = require('fs');
const src = fs.readFileSync(require('path').resolve(__dirname, '../api/analyst-ask.js'), 'utf8');
const graderSrc = src.match(/async function gradeDueForecasts\(r\) \{[\s\S]*?\n\}/)[0];
const blockSrc = src.match(/function calibBlock\(cells\) \{[\s\S]*?\n\}/)[0];
eval(graderSrc.replace('async function gradeDueForecasts', 'var gradeDueForecasts = async function'));
eval(blockSrc.replace('function calibBlock', 'var calibBlock = function'));

// A fake KV with the ops the grader uses.
function fakeKv(pending, hist, opts = {}) {
  const cells = {};
  return {
    cells,
    async lrange(k, a, b) {
      if (k === 'calib:pending') return pending.slice(a, b + 1);
      if (k.startsWith('public:levels:hist:')) return hist[k.split(':').pop()] || [];
      return [];
    },
    async lrem(k, cnt, val) {
      if (opts.stolen) return 0;                    // another lambda owns it
      const i = pending.indexOf(val);
      if (i < 0) return 0;
      pending.splice(i, 1); return 1;
    },
    async hincrby(k, f, v) { cells[f] = (cells[f] || 0) + v; return cells[f]; },
  };
}

const NOW = Date.now();
const claim = (over = {}) => JSON.stringify({
  id: 'x', asked_at: NOW - 120 * 60000, claim: 'test', confidence: 65,
  ticker: 'SPY', metric: 'spot_above', level: 769, horizon_min: 60, ...over,
});
const hp = (minAgo, spot) => JSON.stringify({ t: NOW - minAgo * 60000, s: spot, f: 769.6, c: 770, p: 769, e: 0.4 });

let fails = 0;
const t = async (label, pending, hist, expect, opts) => {
  const kv = fakeKv(pending, hist, opts);
  await gradeDueForecasts(kv);
  const got = JSON.stringify(kv.cells);
  const ok = got === JSON.stringify(expect);
  if (!ok) fails++;
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label + ' -> ' + got + (ok ? '' : ' (want ' + JSON.stringify(expect) + ')'));
};

(async () => {
  // due 60 min after ask (2h ago) => horizon hit NOW-60min; sample at 58 min ago, spot 770 >= 769: HIT
  await t('hit counts', [claim()], { SPY: [hp(58, 770.2)] }, { '65:n': 1, '65:hit': 1 });
  // spot below the level at horizon: MISS (n counts, no hit)
  await t('miss counts', [claim()], { SPY: [hp(58, 768.1)] }, { '65:n': 1 });
  // spot_below metric, spot below level: HIT
  await t('spot_below hit', [claim({ metric: 'spot_below', level: 771 })], { SPY: [hp(61, 768.0)] }, { '65:n': 1, '65:hit': 1 });
  // nearest sample 45 min from horizon (> 20-min match window): CENSORED, never a miss
  await t('gap censors', [claim()], { SPY: [hp(15, 768.0)] }, { '65:cens': 1 });
  // no history at all: CENSORED
  await t('no hist censors', [claim()], {}, { '65:cens': 1 });
  // not yet due: untouched, nothing counted
  await t('not due yet', [claim({ asked_at: NOW - 10 * 60000 })], { SPY: [hp(5, 770)] }, {});
  // ownership race: LREM returns 0 => nothing counted (no double grading)
  await t('stolen claim counts nothing', [claim()], { SPY: [hp(58, 770.2)] }, {}, { stolen: true });
  // two claims, one due one not: only the due one graded
  await t('mixed due/undue', [claim(), claim({ asked_at: NOW - 5 * 60000, confidence: 85 })],
          { SPY: [hp(58, 770.2)] }, { '65:n': 1, '65:hit': 1 });

  // calibBlock: floor of 10, honest phrasing, silent when thin
  const b1 = calibBlock({ '65:n': 23, '65:hit': 13, '65:cens': 2 });
  const b2 = calibBlock({ '65:n': 4, '65:hit': 4 });
  const okB = /right 57% of the time \(n=23, \+2 unresolved\)/.test(b1) && b2 === '';
  if (!okB) fails++;
  console.log((okB ? 'ok  ' : 'FAIL') + ' calibBlock floors + phrasing');

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'calibration sabotage suite: ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
