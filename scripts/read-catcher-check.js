/* read-catcher-check.js — the read prediction catcher must refuse almost everything.
 *
 * Jake, 2026-09-07: the bias stays graded as a bias; this catches a SEPARATE call stated inside a
 * read. The risk is entirely one-sided: a wrong YES puts a claim on NoVo's record he never made,
 * on a scheduled path nobody is watching, and it will be graded and scored as though he had. A
 * wrong NO costs nothing at all.
 *
 * So these checks are almost all NEGATIVE. The model is stubbed rather than called: what is under
 * test is the CONTRACT around it — that a conditional is refused, that an unparseable answer is a
 * no, that nothing is recorded without a spot, and that a yes still has to survive
 * makePrediction's own validation. Calling the live model would test the model's mood.
 */
const path = require('path');
const KV_PATH = require.resolve(path.join(__dirname, '..', 'api', '_kv.js'));
const S = new Map();
require.cache[KV_PATH] = { id: KV_PATH, filename: KV_PATH, loaded: true,
  exports: { kv: () => ({ async get(k) { return S.has(k) ? S.get(k) : null; },
                          async set(k, v) { S.set(k, v); } }) } };

/* The model is stubbed at the vertex boundary — the same seam the real code calls through. */
const V_PATH = require.resolve(path.join(__dirname, '..', 'api', '_vertex.js'));
let NEXT = '';
require.cache[V_PATH] = { id: V_PATH, filename: V_PATH, loaded: true,
  exports: { vertex: async () => ({ stub: true }), answerText: () => NEXT,
             MODEL: 'stub', LOCATION: 'stub' } };

const { catchReadPrediction } = require(path.join(__dirname, '..', 'api', '_lib', 'read-predictions.js'));
const P = require(path.join(__dirname, '..', 'api', '_lib', 'predictions.js'));

let failures = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  PASS  ' + name); return; }
  failures++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
}
const reset = () => S.clear();
const rows = () => JSON.parse(S.get('pred:log') || '[]');
const SPOTS = { spots: { SPY: 770.19, QQQ: 718.96 } };
const READ = (t) => ({ title: 'The Close', text: t });
const LONG = 'The session closed under the flip with dealers short gamma into the bell, and the '
  + 'put wall held on three separate tests through the afternoon. ';

(async () => {
  console.log('\nThe read catcher refuses almost everything\n');

  reset();
  NEXT = '{"has":false}';
  let r = await catchReadPrediction(READ(LONG + 'It was a quiet tape.'), SPOTS);
  ok('an ordinary read produces NO prediction — the common case, and the correct one',
    r.has === false && rows().length === 0, JSON.stringify(r));

  reset();
  NEXT = 'I think SPY probably closes around 772 tomorrow, but it depends.';
  r = await catchReadPrediction(READ(LONG + 'anything'), SPOTS);
  ok('an unparseable answer is a NO — no salvaging JSON out of prose',
    r.has === false && r.why === 'unparseable' && rows().length === 0, JSON.stringify(r));

  reset();
  NEXT = '{"has":true,"symbol":"SPY","kind":"close_at","value":772,"horizon":"today_close",'
       + '"quote":"SPY closes above 772 today"}';
  r = await catchReadPrediction(READ(LONG + 'SPY closes above 772 today.'), SPOTS);
  ok('a clear, specific call IS caught, recorded as source "read"',
    r.has === true && rows().length === 1 && rows()[0].source === 'read'
      && rows()[0].symbol === 'SPY' && rows()[0].kind === 'close_at',
    JSON.stringify({ r: r.has, rows: rows().map((x) => x.source + ':' + x.kind) }));

  reset();
  NEXT = '{"has":true,"symbol":"SPY","kind":"close_at","value":772,"horizon":"today_close","quote":"x"}';
  r = await catchReadPrediction(READ(LONG + 'x'), { spots: {} });
  ok('...but NOTHING is recorded without a spot to grade it from',
    r.has === false && /no spot/.test(r.why || '') && rows().length === 0, JSON.stringify(r));

  reset();
  NEXT = '{"has":true,"symbol":"SPY","kind":"close_at","horizon":"today_close","quote":"x"}';
  r = await catchReadPrediction(READ(LONG + 'x'), SPOTS);
  ok('...and a call missing its value is refused by makePrediction, not waved through',
    r.has === false && rows().length === 0, JSON.stringify(r));

  reset();
  NEXT = '{"has":true,"symbol":"SPY","kind":"direction","side":"up","horizon":3,"quote":"x"}';
  r = await catchReadPrediction(READ(LONG + 'x'), SPOTS);
  ok('...and a horizon too short to be falsifiable is refused',
    r.has === false && rows().length === 0, JSON.stringify(r));

  reset();
  NEXT = '{"has":false}';
  r = await catchReadPrediction(READ('too short'), SPOTS);
  ok('a stub of a read is not run through the model at all',
    r.has === false && r.why === 'no text', JSON.stringify(r));

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
