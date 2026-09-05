// Sabotage suite for provenanceAudit: catch the battery-3 mislabels, leave true labels alone.
const fs = require('fs');
const src = fs.readFileSync('api/analyst-ask.js', 'utf8');
const attrib = src.match(/const ATTRIB_RE = .*;/)[0];
const numsIn = src.match(/function _numsIn\(str\) \{[\s\S]*?\n\}/)[0];
const walk = src.match(/function _walkProvenance\([\s\S]*?\n\}/)[0];
const audit = src.match(/function provenanceAudit\(answer, trackRec, contents\) \{[\s\S]*?\n\}/)[0];
eval(attrib + '\n' + numsIn + '\n' + walk + '\n' + audit);

// A trackRec shaped like the real payload: backtest cell (session-counted, dated) + intraday
// gravity/flip (units:snapshot) + archive cell (session-counted, NO snapshot units).
const trackRec = {
  tickers: {
    SPY: {
      expected_move_backtest: { sessions: 1008, rate: 74.2, first: '2020-01-02', last: '2023-12-29' },
      expected_move: { sessions: 30, rate: 96.7 },
      gravity_pull: { units: 'near_n/far_n and sample are ~60-second snapshots, not sessions', sample: 2217, near_n: 4877, far_n: 381, z: 24.2 },
      flip_regime: { units: '~60-second snapshots, not sessions', sample: 4011, z: -2.43 },
      archive: { horizon: "the next session's range", flip_regime: { z: 23.9, sample: 2109 }, expected_move: { z: 16.6, sample: 4542 } },
    },
  },
};

let fails = 0;
const t = (label, answer, expectHits) => {
  const f = provenanceAudit(answer, trackRec, []);
  const got = f.length > 0;
  const ok = got === expectHits;
  if (!ok) fails++;
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label + ' -> ' + (f.length ? f.map((x) => x.value + x.wrong).join(',') : 'clean'));
};

console.log('MUST FLAG (the battery-3 mislabels):');
t('backtest 1008 called "live sessions"', 'My equities desk shows 74% across 1,008 live sessions.', true);
t('backtest 1008 called "logged"', 'My logged record holds 1,008 sessions of expected-move data.', true);
t('gravity 2217 snapshots called "sessions"', 'My gravity pull record scores z=24.2 across 2,217 sessions.', true);
t('gravity 4877 near_n called "trading days"', 'My archive logged 4,877 trading days near gravity.', true);

console.log('\nMUST NOT FLAG (true labels):');
t('backtest correctly labeled', 'My 2020-2023 backtest ran 1,008 sessions at 74%.', false);
t('live block correctly small', 'My live expected-move record holds 30 sessions at 96.7%.', false);
t('archive flip session-counted (real)', 'My archive flip regime holds z=23.9 across 2,109 sessions.', false);
t('archive EM session-counted (real)', 'My archive expected move scores z=16.6 over 4,542 sessions.', false);
t('gravity quoted AS snapshots', 'My gravity pull spans 2,217 snapshots, not sessions.', false);
t('no attribution -> ignored', 'The market ran 1,008 points live today.', false);
t('backtest number, no live/session word', 'My backtest edge is real.', false);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'provenance sabotage suite: ALL PASS'));
process.exit(fails ? 1 : 0);
