// api/_lib/novo-calls.js — Dr. NoVo watches ALL the data and makes his OWN call.
//
// Jake, 2026-09-09: "Eye/crypto version reads and gives live reads in all dashboards, good or
// high value reads get alerts from the Eye/crypto collector, meanwhile Dr. NoVo is watching all
// the data to make predictions not just those ALL data points, then at the same time real alerts
// that find an edge get brought to the service by Dr. NoVo out of the alerts for comp seats...
// if this is not the code wired in then it is wrong and needs fixing now."
//
// THREE OF THE FOUR EXISTED. The Eye and the collector read and publish (signals.py,
// equity_signals.py); high-value readings become alerts; the edge gate in predictions.js promotes
// an alert to the comp-seat feed — Jake confirmed that gate is correct as it stands.
//
// THIS IS THE ONE THAT DID NOT EXIST. Measured 2026-09-09: `predictions.js` contains ZERO model
// calls. Every row stamped `source:"novo"` was minted by two constants — `n >= 30 resolutions`
// and `edge >= 5pp` — reading the engine's own base-rate table. Dr. NoVo never saw them. It shows
// in the record exactly as you would expect a constant to look: 94 graded calls, 94 of them "up",
// every one from a single rule (cost_anomaly), hitting 34%. A threshold cannot have a bad day and
// it cannot have a good one; it has a number.
//
// So a prediction attributed to him now has to come from him.
//
// ⚠ HE SEES EVERYTHING, NOT JUST THE FIRES. That is the point of Jake's sentence — "not just
// those ALL data points". A selector that only ever sees what already tripped a rule can only
// ever re-rank the rules. He gets the whole picture: the map, the readings that did NOT fire,
// the base rates with their denominators, and his own open calls so he does not stack the same
// bet twice.
//
// ⚠ DECLINING IS THE DEFAULT AND IT IS NOT A FAILURE. Same discipline as read-predictions.js:
// strict JSON, temperature 0, an explicit refusal path, and a hard requirement for a side, a
// symbol and a horizon. Most passes should produce nothing. A selector that leans permissive
// mints calls out of noise, on a schedule, where nobody is watching — and every one of them
// lands on his permanent record.
//
// ⚠ IT MUST NOT SEE ITS OWN SCORE. Feeding him "you are at 48%" invites him to chase the number
// rather than read the tape. He gets the data and the base rates; the record grades him after.

const { vertex, answerText } = require('../_vertex.js');
const { SYSTEM } = require('./analyst-brain.js');
const { makePrediction, listPredictions } = require('./predictions.js');
const { kv } = require('../_kv.js');
const { bump } = require('./funnel.js');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

/* ⚠ NO OUTPUT CAP, DELIBERATELY. Jake, 2026-09-09: "its not that we want to limit anything with
   a max number, we want the code dialed in to work and find the best of everything we dont want
   to restrict it with a max output."

   He is right and a cap would have been a lie. Capping at N/day means the FIRST setup of the day
   wins rather than the best one, and it hides how often he would actually have fired — the number
   you most need in order to tune the bar. The volume has to EMERGE from the bar, not be clipped.

   So the two things that shape volume here are both about whether there is anything new to judge:

   1. HE IS ASKED WHEN THE BOOK CHANGES, NOT ON A TIMER. The collector pushes every ~5 minutes;
      288 near-identical snapshots a day is not 288 decisions, it is one decision asked 288 times.
      A material-change fingerprint (below) skips the pass when nothing moved. That is not a
      restriction on him — it is refusing to ask the same question again.
   2. THE BAR IS EVIDENTIAL. He must name the measurements, and the direction must be supported by
      a base rate with a real denominator. A setup that clears that is worth a call however many
      times it happens. */

const RULES =
  'You are looking at the complete current data picture for your own desk. Decide whether there ' +
  'is a call worth putting on your permanent record right now.\n\n' +
  'Answer with STRICT JSON and nothing else.\n' +
  'No call: {"calls":[]}\n' +
  'A call: {"calls":[{"symbol":"BTC","side":"up"|"down","horizon_min":<15..1440>,' +
  '"thesis":"<the claim, one sentence, in your own voice>",' +
  '"basis":"<the specific measurements that support it, with their numbers>"}]}\n\n' +
  'List every call that clears the bar - there is no quota, in either direction. Most passes '  +
  'clear nothing, and an empty list is the right answer then. Do not reach for one because the '  +
  'list looks empty, and do not stop at one if a second genuinely clears. '  +
  // This sentence shipped DECAPITATED in 9c96589ac -- the model received "of the time and costs
  // you nothing." for all 280 asks (found by Jerni 2d3effb9, repaired on Jake's go, 09-11).
  'Declining is right most of the time and costs you nothing.\n\n' +
  'DECLINE unless ALL of these hold:\n' +
  '- you can name the specific measurements that support it, with their numbers, from the data below\n' +
  '- the data actually carries directional information. A spread, a cost, a liquidity reading or a ' +
  'volume anomaly describes CONDITIONS, not direction. Do not turn one into an up/down call.\n' +
  '- a base rate or sample supports the direction, and you can say what it is\n' +
  '- you do not already have an open call on that symbol in the same direction\n' +
  '- the horizon is one you can defend, not a round number chosen for convenience\n\n' +
  'A wrong call is permanent and public. Declining is free. The bar is the point.';

/** Compact the picture so the whole thing fits: numbers survive, prose does not. */
function crypto_picture(snap) {
  const coins = (snap && snap.coins) || {};
  const rows = [];
  for (const sym of Object.keys(coins).slice(0, 120)) {
    const c = coins[sym] || {};
    const px = Number(c.price || (c.true_cost && c.true_cost.price));
    if (!isFinite(px) || px <= 0) continue;
    rows.push({
      s: sym, px: +px.toPrecision(6),
      ch24: c.change_24h != null ? +Number(c.change_24h).toFixed(2) : null,
      fund: c.funding_avg != null ? +Number(c.funding_avg).toFixed(4) : null,
      oi: c.open_interest != null ? Math.round(Number(c.open_interest)) : null,
      liqL: c.liq_long_24h != null ? Math.round(Number(c.liq_long_24h)) : null,
      liqS: c.liq_short_24h != null ? Math.round(Number(c.liq_short_24h)) : null,
      gflip: c.gamma_flip != null ? +Number(c.gamma_flip).toPrecision(6) : null,
    });
  }
  return rows;
}

/**
 * @param {object} snap  the full snapshot the collector already pushes (crypto) — every coin,
 *                       not just the ones that fired.
 * @returns {{made:number, declined:boolean, why?:string, ids?:string[]}}
 */
/* The fingerprint of a DECISION, not of a snapshot. Prices tick every pass; that is not new
   information. What changes the answer is which coins sit at an extreme and which readings fired
   — so the print is built from those, with prices bucketed coarsely enough that noise does not
   register as change. Same picture, same answer: do not spend a model call re-deriving it. */
function decisionPrint(rows, feed) {
  const parts = [];
  for (const x of rows) {
    const ch = x.ch24 == null ? '-' : Math.round(Number(x.ch24) / 2);      // 2% buckets
    const fd = x.fund == null ? '-' : Math.round(Number(x.fund) * 2000);   // ~5bp buckets
    if (ch === 0 && fd === 0) continue;                                    // quiet coin, no signal
    parts.push(x.s + ':' + ch + ':' + fd);
  }
  for (const f of (Array.isArray(feed) ? feed : [])) {
    if (f && f.kind && (f.asset_code || f.asset)) parts.push('f:' + f.kind + ':' + (f.asset_code || f.asset));
  }
  return require('crypto').createHash('sha256').update(parts.sort().join('|')).digest('hex').slice(0, 24);
}

async function novoCryptoCalls(snap) {
  const r = kv();
  if (!r || !snap) return { made: 0, declined: true, why: 'no snapshot' };

  const rows = crypto_picture(snap);
  if (!rows.length) return { made: 0, declined: true, why: 'no priced coins in the snapshot' };

  /* Nothing material moved since the last pass, so there is no new question to put to him.
     Soft-fails OPEN: if KV cannot answer, he gets asked. Failing closed here would silence him
     invisibly on a Redis blip, which is the worse of the two errors. */
  const print = decisionPrint(rows, snap.feed);
  try {
    const last = await r.get('novo:print');
    if (last && String(last) === print) { await bump('skipped', 1); return { made: 0, declined: true, why: 'book unchanged since last pass' }; }
  } catch (_) {}
  try { await r.set('novo:print', print, { ex: 6 * 3600 }); } catch (_) {}

  const rates = ((snap.health || {}).base_rates) || [];
  // His own open calls, so he does not stack the same bet twice. Reads only.
  let open = [];
  try {
    // listPredictions returns { open, graded, void, score, overall } -- an OBJECT, and `open` is
    // already filtered and sorted by horizon. Reading it as an array (or as {rows}) yields an
    // empty list silently, and an empty open-list means the duplicate guard below never fires.
    const l = await listPredictions(60, 'crypto', false);
    open = ((l && Array.isArray(l.open)) ? l.open : [])
      .map((p) => ({ s: p.symbol, side: p.side, due: p.horizon_utc }));
  } catch (_) { open = []; }

  const payload =
    'THE BOOK (every mapped coin, not just the ones that fired):\n' + JSON.stringify(rows) +
    '\n\nBASE RATES, with their denominators — this is what each signal kind has actually done:\n' +
    JSON.stringify(rates).slice(0, 4000) +
    '\n\nYOUR OPEN CALLS (do not duplicate a side already open on a symbol):\n' + JSON.stringify(open) +
    '\n\nREADINGS THAT FIRED THIS PASS (context only — a fire is not a reason on its own):\n' +
    JSON.stringify((Array.isArray(snap.feed) ? snap.feed : []).slice(0, 40)).slice(0, 3000);

  await bump('asked', 1);   // he was actually put the question — the denominator for 'declined'
  let out = '';
  try {
    const resp = await vertex(`${MODEL}:generateContent`, {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: RULES + '\n\n' + payload }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 700, responseMimeType: 'application/json',
                          thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
    });
    out = resp ? String(answerText(resp) || '').trim() : '';
  /* ERRORED, NOT DECLINED. Both of these are after bump('asked'), so without their own counter the
     ask is spent and nothing records where it went — the funnel reads as if he considered it and
     said no. He never saw the question. */
  } catch (e) { await bump('errored', 1); return { made: 0, declined: true, why: 'model error: ' + e.message }; }

  let j = null;
  // Unparseable is a DECLINE. Salvaging JSON out of prose is how a strict selector quietly
  // becomes a permissive one — the same note read-predictions.js carries, for the same reason.
  try { j = JSON.parse(out); } catch (_) { await bump('errored', 1); return { made: 0, declined: true, why: 'unparseable' }; }
  const calls = j && Array.isArray(j.calls) ? j.calls : [];
  if (!calls.length) { await bump('declined', 1); return { made: 0, declined: true, why: 'he declined' }; }

  const ids = [];
  for (const c of calls) {
    const sym = String((c && c.symbol) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const row = rows.find((x) => x.s === sym);
    // NO SPOT, NO CALL. A prediction with no starting price cannot be graded, and taking a price
    // from anywhere but the snapshot he was shown would grade him against a number he never saw.
    if (!row) continue;
    const side = c.side === 'down' ? 'down' : c.side === 'up' ? 'up' : null;
    if (!side) continue;
    const hm = Number(c.horizon_min);
    if (!isFinite(hm) || hm < 15 || hm > 1440) continue;
    const made = await makePrediction({
      source: 'novo', asset_class: 'crypto', symbol: sym, kind: 'direction', side,
      spot_at: row.px, horizon_min: Math.round(hm),
      thesis: String(c.thesis || '').slice(0, 280) || (sym + ' ' + side),
      basis: String(c.basis || '').slice(0, 200) || 'his own read of the book',
    });
    if (made && made.ok) { ids.push(made.id); await bump('calls', 1); }
  }
  return { made: ids.length, declined: ids.length === 0, ids };
}

module.exports = { novoCryptoCalls };
