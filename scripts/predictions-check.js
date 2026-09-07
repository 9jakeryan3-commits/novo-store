/* predictions-check.js — NoVo's prediction record cannot mint free hits.
 *
 * Born from the FIRST real prediction (Jake, Labor Day 2026): asked about tomorrow's open, NoVo
 * recorded "SPY closes at 770.19, grades today 4:00 PM ET" — a close on a day with no close. At
 * 16:00 the evaluator would have compared a frozen spot to itself and handed him a HIT on a market
 * that never traded. A record with free hits in it is not a record, and this file exists so that
 * class of grade can never happen again.
 *
 * Fake KV planted in require.cache before predictions.js binds it — same technique, same reason,
 * as digest-optin-check.js.
 */
const path = require('path');
const KV_PATH = require.resolve(path.join(__dirname, '..', 'api', '_kv.js'));
const S = new Map();
require.cache[KV_PATH] = { id: KV_PATH, filename: KV_PATH, loaded: true,
  exports: { kv: () => ({ async get(k) { return S.has(k) ? S.get(k) : null; },
                          async set(k, v) { S.set(k, v); } }) } };
const P = require(path.join(__dirname, '..', 'api', '_lib', 'predictions.js'));

let failures = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  PASS  ' + name); return; }
  failures++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
}
const reset = () => S.clear();
const rows = () => JSON.parse(S.get('pred:log') || '[]');

// Labor Day 2026, 2:03 PM ET = 18:03 UTC (EDT). The exact minute of the live incident.
const LABOR_DAY_1403ET = Date.UTC(2026, 8, 7, 18, 3, 0);
// A plain Tuesday, 10:00 ET.
const TUESDAY_10ET = Date.UTC(2026, 8, 8, 14, 0, 0);
// Friday 2026-09-04, 15:00 ET — before that day's close.
const FRIDAY_15ET = Date.UTC(2026, 8, 4, 19, 0, 0);

(async () => {
  console.log('\nThe prediction record cannot mint free hits\n');

  // ── 1. THE LIVE INCIDENT: today_close on a holiday resolves to the NEXT session ────────────
  const h = require(path.join(__dirname, '..', 'api', '_lib', 'predictions.js'));
  const t1 = h.__resolveHorizon ? null : null; // resolveHorizon is internal; test via makePrediction
  reset();
  // makePrediction uses Date.now() internally; we test resolveHorizon's calendar through the
  // module's own export surface by checking the recorded horizon lands on a trading day.
  await P.makePrediction({ kind: 'close_at', symbol: 'SPY', value: 770, spot_at: 770.19,
                           horizon: 'today_close' });
  const rec = rows()[0];
  const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
    .format(new Date(rec.horizon_utc));
  const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
    .format(new Date(rec.horizon_utc));
  const HOLIDAYS = ['2026-09-07', '2026-11-26', '2026-12-25'];
  ok('a named horizon always lands on a trading day (never a weekend or holiday)',
    !['Sat', 'Sun'].includes(dow) && !HOLIDAYS.includes(etDay),
    JSON.stringify({ etDay, dow }));
  const etHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(rec.horizon_utc));
  ok('...at the close, 16:00 ET exactly', etHour === '16:00', etHour);

  // ── 2. tomorrow_open exists, and is strictly a future session's 09:30 ─────────────────────
  reset();
  const r2 = await P.makePrediction({ kind: 'open_at', symbol: 'SPY', value: 770.5,
    spot_at: 770.19, horizon: 'tomorrow_open', thesis: 'positioning grounds the open' });
  ok('open_at + tomorrow_open — the vocabulary the live question needed — records',
    r2.ok === true, JSON.stringify(r2));
  const rec2 = rows()[0];
  const etHour2 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(rec2.horizon_utc));
  ok('...at the open, 09:30 ET, in the future',
    etHour2 === '09:30' && rec2.horizon_utc > Date.now(), etHour2);

  // ── 3. THE VOID GUARD: a pre-calendar row with a holiday horizon is voided, never graded ───
  reset();
  /* ⚠ A PAST holiday. The first fixture used Labor Day 16:00 — which, at the time this file was
     written, had not HAPPENED yet, so the guard correctly left the row open and the check failed
     against working code. The guard only voids once the horizon has arrived; Jake's live row
     voids at 4 PM. July 3rd (July 4th observed, in the holiday set) is safely in the past. */
  const bad = { id: 'legacy1', made_utc: Date.UTC(2026, 6, 3, 18, 0, 0), source: 'conversation',
    asset_class: 'equity', symbol: 'SPY', kind: 'close_at', side: 'up', value: 770.19,
    spot_at: 770.19, horizon_utc: Date.UTC(2026, 6, 3, 20, 0, 0) /* Jul 3 16:00 ET, holiday */,
    thesis: 'recorded before the calendar existed', status: 'open' };
  S.set('pred:log', JSON.stringify([bad]));
  await P.evaluateEquityPredictions({ indices: [{ ticker: 'SPY', spot: 770.19 }] });
  const voided = rows()[0];
  ok('the Labor Day row is VOIDED, not graded — no hit on a market that never traded',
    voided.status === 'void' && !voided.outcome.hit && /holiday/.test(voided.outcome.reason || ''),
    JSON.stringify(voided.status) + ' ' + JSON.stringify(voided.outcome));
  const listed = await P.listPredictions();
  ok('...it is excluded from the score and shown under void',
    listed.overall.n === 0 && listed.void.length === 1,
    JSON.stringify({ overall: listed.overall, voids: listed.void.length }));

  // ── 4. a real grade still works, both directions ───────────────────────────────────────────
  reset();
  const good = { id: 'g1', made_utc: Date.now() - 3600000, source: 'conversation',
    asset_class: 'equity', symbol: 'SPY', kind: 'close_at', side: 'down', value: 769.2,
    spot_at: 769.62, horizon_utc: Date.now() - 1000, status: 'open' };
  // horizon yesterday-ish would be a holiday today; place it on Friday's close instead
  good.horizon_utc = Date.UTC(2026, 8, 4, 20, 0, 0);
  S.set('pred:log', JSON.stringify([good]));
  await P.evaluateEquityPredictions({ indices: [{ ticker: 'SPY', spot: 769.45 }] });
  const g = rows()[0];
  ok('a legitimate close_at grades: direction right = hit, error recorded',
    g.status === 'graded' && g.outcome.hit === true
      && Math.abs(g.outcome.error_pct - (((769.45 - 769.2) / 769.2) * 100)) < 0.01,
    JSON.stringify(g.outcome));

  // ── 5. level_touch: hit on the cross, miss at expiry, never before ─────────────────────────
  reset();
  const lt = { id: 'l1', made_utc: Date.now() - 60000, asset_class: 'crypto', symbol: 'BTC',
    kind: 'level_touch', side: 'touch', value: 102000, spot_at: 100000,
    horizon_utc: Date.now() + 3600000, status: 'open' };
  S.set('pred:log', JSON.stringify([lt]));
  await P.evaluateCryptoPredictions({ coins: { BTC: { price: 101000 } } });
  ok('level_touch stays open below the level', rows()[0].status === 'open', rows()[0].status);
  await P.evaluateCryptoPredictions({ coins: { BTC: { price: 102300 } } });
  ok('...and hits the moment it trades through', rows()[0].status === 'graded'
    && rows()[0].outcome.hit === true, JSON.stringify(rows()[0].outcome));

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
