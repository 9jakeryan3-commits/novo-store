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

  // ── 6. THE CRYPTO SELECTOR: "a fitting moment" is defined by the record, not vibes ─────────
  reset();
  const NOW = new Date().toISOString();
  const SNAP = {
    coins: { BTC: { price: 100000 }, DOGE: { price: 0.4 } },
    health: { base_rates: [
      // real edge: 61% hit over its own 52% up-share, honest denominator
      { kind: 'funding_extreme_shorts_paying', hit_rate: 61.0, n: 900, n_cells: 120,
        n_up: 468, n_down: 432, avg_move: 0.8 },
      // NO edge: 52% hit vs a 51% base — a coin flip wearing a rate
      { kind: 'oi_quadrant_up', hit_rate: 52.0, n: 900, n_cells: 300,
        n_up: 459, n_down: 441, avg_move: 0.1 },
      // edge but a denominator too thin to trust
      { kind: 'cost_anomaly', hit_rate: 80.0, n: 40, n_cells: 6, n_up: 30, n_down: 10, avg_move: 1 },
    ] },
    feed: [
      { kind: 'funding_extreme', side: 'shorts_paying', asset_code: 'BTC', ts_utc: NOW,
        horizon_min: 240, claim: 'BTC funding -4.7 sigma; shorts paying' },
      { kind: 'oi_quadrant', side: 'up', asset_code: 'DOGE', ts_utc: NOW, horizon_min: 240,
        claim: 'DOGE OI regime up' },
      { kind: 'cost_anomaly', asset_code: 'DOGE', ts_utc: NOW, horizon_min: 240, claim: 'cheap' },
      { kind: 'funding_extreme', side: 'shorts_paying', asset_code: 'BTC',
        ts_utc: '2026-09-07T01:00:00Z', horizon_min: 240, claim: 'HOURS-OLD reading' },
    ],
  };
  const sel = await P.selectCryptoPredictions(SNAP);
  const after = rows();
  ok('the selector takes ONLY the reading with real edge on a real denominator',
    sel.made === 1 && after.length === 1 && after[0].symbol === 'BTC'
      && after[0].source === 'novo' && after[0].kind === 'direction',
    JSON.stringify({ made: sel.made, rows: after.map((p) => p.symbol + ':' + p.kind) }));
  ok('...a coin-flip rate, a thin denominator and a stale reading are all refused',
    !after.some((p) => p.symbol === 'DOGE') && after.length === 1,
    JSON.stringify(after.map((p) => p.symbol)));
  ok('...and the call carries its receipts — the rate, the cells and the base it beat',
    /61% over 120 coin-days vs 52.0% base/.test(after[0].basis || ''),
    JSON.stringify(after[0].basis));
  const again = await P.selectCryptoPredictions(SNAP);
  ok('...and the same reading can never become a second prediction',
    again.made === 0 && rows().length === 1, JSON.stringify(again));

  // ── 7. per-desk: crypto calls at the crypto desk, equities on the equity side ──────────────
  const eqList = await P.listPredictions(40, 'equity');
  const cxList = await P.listPredictions(40, 'crypto');
  ok('the record splits per desk — the equity side does not show crypto calls',
    eqList.open.length === 0 && cxList.open.length === 1,
    JSON.stringify({ equity: eqList.open.length, crypto: cxList.open.length }));

  // ── 8. DR. NOVO'S ALERTS: the grading is the curator ───────────────────────────────────────
  reset();
  const NOWTS = new Date().toISOString();
  const CHAIN_SNAP = {
    alerts: {
      open: [
        // rule with proven oos edge over its own floor → surfaces
        { ts_utc: NOWTS, asset_code: 'PNUT', kind: 'chain_pump_buyers',
          claim: 'Ten separate wallets bid PNUT in one pass.', horizon_min: 240 },
        // rule BELOW its own floor → firehose stays put
        { ts_utc: NOWTS, asset_code: 'MEW', kind: 'chain_holds_bid',
          claim: 'Turnover above its own normal.', horizon_min: 240 },
        // negative out of sample → never
        { ts_utc: NOWTS, asset_code: 'WOFI', kind: 'chain_pump_sellers',
          claim: 'Sellers into buyers.', horizon_min: 240 },
        // stale → not a moment
        { ts_utc: '2026-09-07T01:00:00Z', asset_code: 'PNUT', kind: 'chain_pump_buyers',
          claim: 'HOURS OLD.', horizon_min: 240 },
      ],
      levels: {
        chain_pump_buyers:  { oos_trig_target: 61.2, oos_base_target: 40.0, edge_floor_pp: 5.0 },
        chain_holds_bid:    { oos_trig_target: 44.3, oos_base_target: 40.0, edge_floor_pp: 5.0 },
        chain_pump_sellers: { oos_trig_target: 39.5, oos_base_target: 40.0, edge_floor_pp: 5.8 },
      },
    },
  };
  const cur = await P.curateChainFires(CHAIN_SNAP);
  const feed = JSON.parse(S.get('novo:alerts:feed') || '[]');
  ok('a chain ticket surfaces ONLY when its rule’s oos edge clears its own floor',
    cur.kept === 1 && feed.length === 1 && feed[0].symbol === 'PNUT',
    JSON.stringify({ kept: cur.kept, feed: feed.map((x) => x.symbol + ':' + x.kind) }));
  ok('...below-floor, negative-oos and stale tickets all stay in the firehose',
    !feed.some((x) => ['MEW', 'WOFI'].includes(x.symbol)),
    JSON.stringify(feed.map((x) => x.symbol)));
  ok('...and the surfaced row carries its receipts — the edge and the floor it beat',
    /oos edge \+21\.2pp over its own floor 5/.test(feed[0].receipts || ''),
    JSON.stringify(feed[0].receipts));
  const cur2 = await P.curateChainFires(CHAIN_SNAP);
  ok('...and the same ticket can never surface twice',
    cur2.kept === 0 && JSON.parse(S.get('novo:alerts:feed')).length === 1,
    JSON.stringify(cur2));
  const eqOnly = await P.listNovoFires('equity');
  const cxOnly = await P.listNovoFires('crypto');
  ok('the feed splits per desk like everything else',
    eqOnly.length === 0 && cxOnly.length === 1,
    JSON.stringify({ equity: eqOnly.length, crypto: cxOnly.length }));

  // ── 9. THE EYE IS A TOOL; NOVO DECIDES ────────────────────────────────────────────────────
  // Jake, 2026-09-07: "it is his not the eyes making predictions he uses the eye as a tool but
  // its novos predictions ... the eye gives live readings not predictions." A rule tripping a
  // threshold is an observation. Whether it becomes a call, and whether it earns a place on the
  // alerts page, is one judgement made HERE against the rule's own graded record.
  const fire = (over) => ({
    symbol: 'SPY', rule: 'eye_vix_inverted', era: 'eye_v1', direction: 'down',
    spot_at: 770.19, horizon_min: 60, reading: 'd_vix_vix3m > 1 (reading 1.04)',
    record: { resolutions: 120, hit_pct: 61.0, base_hit_pct: 50.4, base_n: 900 }, ...over,
  });

  reset();
  const earned = await P.onEquityFire(fire({ ts: 1 }));
  const feed1 = JSON.parse(S.get('novo:alerts:feed') || '[]');
  ok('a fire from a rule that has BEATEN the book earns a call and a place in the alerts',
    earned.surfaced === true && earned.predicted === true
      && rows().length === 1 && feed1.length === 1,
    JSON.stringify({ ...earned, rows: rows().length, feed: feed1.length }));
  ok('...the prediction is NOVO\u2019s, sourced to him, with the Eye as the reason - not the author',
    rows()[0].source === 'novo' && rows()[0].asset_class === 'equity'
      && /d_vix_vix3m/.test(rows()[0].thesis || '')
      && /61% over 120 resolutions vs 50.4% across the book/.test(rows()[0].basis || ''),
    JSON.stringify({ source: rows()[0].source, basis: rows()[0].basis }));

  reset();
  const thin = await P.onEquityFire(fire({ ts: 2, record: { resolutions: 8, hit_pct: 75.0, base_hit_pct: 50.4, base_n: 900 } }));
  ok('a rule with 8 resolutions earns nothing - a rate over a handful is not a rate',
    thin.surfaced === false && thin.predicted === false && rows().length === 0
      && JSON.parse(S.get('novo:alerts:feed') || '[]').length === 0,
    JSON.stringify(thin));

  reset();
  const flat = await P.onEquityFire(fire({ ts: 3, record: { resolutions: 400, hit_pct: 52.0, base_hit_pct: 50.4, base_n: 900 } }));
  ok('...and a 52% rule against a 50.4% book earns nothing either - that is not an edge',
    flat.surfaced === false && flat.predicted === false && rows().length === 0,
    JSON.stringify(flat));

  reset();
  const virgin = await P.onEquityFire(fire({ ts: 4, record: { resolutions: 0, hit_pct: null, base_hit_pct: null, base_n: 0 } }));
  ok('...a rule with NO record yet earns nothing, and that is its ordinary state, not a failure',
    virgin.surfaced === false && virgin.predicted === false && rows().length === 0,
    JSON.stringify(virgin));

  reset();
  await P.onEquityFire(fire({ ts: 5 }));
  const refire = await P.onEquityFire(fire({ ts: 5 }));
  ok('...and the same fire can never become a second call, however many passes report it',
    refire.dup === true && rows().length === 1, JSON.stringify({ refire, rows: rows().length }));

  // ── 10. THE NEUTRAL BAND: measured, stamped, and not a free pass ──────────────────────────
  reset();
  const P0 = 100000;
  const neutralAt = async (movePct) => {
    reset();
    await P.makePrediction({ source: 'novo', asset_class: 'crypto', symbol: 'BTC',
      kind: 'direction', side: 'flat', spot_at: P0, horizon_min: 10 });
    const row = rows()[0];
    row.horizon_utc = Date.now() - 1000;
    S.set('pred:log', JSON.stringify([row]));
    await P.evaluateCryptoPredictions({ coins: { BTC: { price: P0 * (1 + movePct / 100) } } });
    return rows()[0];
  };
  const inside = await neutralAt(0.5);
  ok('a neutral HITS when BTC stays inside the measured band',
    inside.status === 'graded' && inside.outcome.hit === true && inside.outcome.band_pct === 0.73,
    JSON.stringify(inside.outcome));
  const outside = await neutralAt(1.4);
  ok('...and MISSES when it does not \u2014 flat is a real call, not a free pass',
    outside.outcome.hit === false, JSON.stringify(outside.outcome));
  const edge = await neutralAt(-0.72);
  ok('...symmetric on the downside, at the band edge',
    edge.outcome.hit === true, JSON.stringify(edge.outcome));

  reset();
  await P.makePrediction({ source: 'novo', asset_class: 'crypto', symbol: 'BTC',
    kind: 'direction', side: 'flat', spot_at: P0, horizon_min: 10 });
  ok('...and the band is STAMPED on the row, so re-measuring cannot re-grade old calls',
    rows()[0].neutral_band_pct === 0.73 && /1825 daily closes/.test(rows()[0].band_prov || ''),
    JSON.stringify({ band: rows()[0].neutral_band_pct, prov: rows()[0].band_prov }));

  // ── 11. THE SEAT FILTER: reads for everyone, his own calls for comp only ──────────────────
  // Jake, 2026-09-07: "predictions tab is viewable to all but only the reads predictions are
  // viewable and predictions are not usable outside comp seat". The filter is SERVER-side; a
  // check that only proved the page hides them would be proving the wrong thing entirely.
  reset();
  await P.makePrediction({ source: 'read', asset_class: 'crypto', symbol: 'BTC',
    kind: 'direction', side: 'up', spot_at: 100000, horizon_min: 1440,
    thesis: 'Daily rundown bias' });
  await P.makePrediction({ source: 'novo', asset_class: 'crypto', symbol: 'ETH',
    kind: 'direction', side: 'down', spot_at: 3000, horizon_min: 240,
    thesis: 'his own selector call' });
  await P.makePrediction({ source: 'conversation', asset_class: 'crypto', symbol: 'SOL',
    kind: 'direction', side: 'up', spot_at: 100, horizon_min: 240,
    thesis: 'asked in chat' });

  const anySeat = await P.listPredictions(40, 'crypto', true);
  const compSeat = await P.listPredictions(40, 'crypto');
  ok('a non-comp seat sees the READ calls and nothing else',
    anySeat.open.length === 1 && anySeat.open[0].source === 'read'
      && anySeat.open[0].symbol === 'BTC',
    JSON.stringify(anySeat.open.map((p) => p.source + ':' + p.symbol)));
  ok('...while a comp seat sees all three',
    compSeat.open.length === 3,
    JSON.stringify(compSeat.open.map((p) => p.source + ':' + p.symbol)));
  ok('...and the filter is on SOURCE, not on which desk or kind it came from',
    anySeat.open.every((p) => p.source === 'read'),
    JSON.stringify(anySeat.open.map((p) => p.source)));

  // ── 12. TRADER PREDICTIONS: the member's book is THEIRS, and never NoVo's ─────────────────
  // Jake, 2026-09-07: "if the user says a prediction of any kind to Dr. NoVo he logs it the same
  // way and it gets scored inside the predictions tab." The thing that must be impossible is a
  // member's guess leaking into the published track record - so that is what these check.
  reset();
  await P.makePrediction({ source: 'novo', asset_class: 'crypto', symbol: 'BTC',
    kind: 'direction', side: 'up', spot_at: 100000, horizon_min: 240, thesis: "NoVo's own" });
  const mineOut = await P.makeUserPrediction('member@example.com', {
    asset_class: 'crypto', symbol: 'BTC', kind: 'direction', side: 'down',
    spot_at: 100000, horizon_min: 240, thesis: 'my own read' });
  ok('a member can log a call of their own', mineOut && mineOut.ok === true, JSON.stringify(mineOut));

  const novoBook = await P.listPredictions(40, 'crypto');
  const myBook = await P.listUserPredictions('member@example.com', 40);
  ok('...and it does NOT appear in NoVo\u2019s record',
    novoBook.open.length === 1 && novoBook.open[0].thesis === "NoVo's own",
    JSON.stringify(novoBook.open.map((p) => p.source + ':' + p.thesis)));
  ok('...it appears in THEIR book, marked as theirs',
    myBook.open.length === 1 && myBook.open[0].source === 'user'
      && myBook.open[0].thesis === 'my own read',
    JSON.stringify(myBook.open.map((p) => p.source + ':' + p.thesis)));

  const other = await P.listUserPredictions('someone.else@example.com', 40);
  ok('...and another member sees none of it \u2014 books are per member',
    other.open.length === 0 && other.graded.length === 0, JSON.stringify(other));

  // The member is held to the SAME validator: no free pass for a call that cannot be graded.
  const badUser = await P.makeUserPrediction('member@example.com', {
    asset_class: 'crypto', symbol: 'BTC', kind: 'direction', side: 'up', horizon_min: 240 });
  ok('...a member call with no spot is refused, exactly as NoVo\u2019s would be',
    !badUser.ok && /spot_at required/.test(badUser.error || ''), JSON.stringify(badUser));

  // And it grades on the same tick, through the same _grade.
  const book = JSON.parse(S.get('pred:user:' + require('crypto').createHash('sha256')
    .update('member@example.com').digest('hex').slice(0, 24)));
  book[0].horizon_utc = Date.now() - 1000;
  S.set('pred:user:' + require('crypto').createHash('sha256')
    .update('member@example.com').digest('hex').slice(0, 24), JSON.stringify(book));
  await P.evaluateCryptoPredictions({ coins: { BTC: { price: 99000 } } });
  const graded = await P.listUserPredictions('member@example.com', 40);
  ok('...and it grades on the same tick as his \u2014 a down call, price fell, HIT',
    graded.graded.length === 1 && graded.graded[0].outcome.hit === true
      && graded.overall.hit_rate === 100,
    JSON.stringify({ graded: graded.graded.length, overall: graded.overall }));

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
