// api/_lib/read-predictions.js — catch a prediction stated INSIDE a published read.
//
// Jake, 2026-09-07: "for the bias they could stay graded as the bias like they are and the
// predictions catching engine finds the prediction made besides the bias (if any) inside the read
// and uses that. not combine not move, let them be what they are."
//
// TWO ARTIFACTS, TWO RECORDS, NEITHER TOUCHING THE OTHER:
//   the BIAS         stays exactly where it is - graded in published_reads, which is what the
//                    "Right N% of the time over M sessions" line on the bias panel counts. Nothing
//                    here reads it, writes it, or scores it.
//   a PREDICTION     if the prose contains a specific falsifiable call BESIDES the bias - "SPY
//                    closes above 772", "we tag the put wall before noon" - that becomes a NoVo
//                    prediction in its own right, source "read", graded by the prediction record.
//
// Merging them would have produced one call scored twice, and moving the bias would have thrown
// away a record with sessions already in it. Jake's instruction is the correct one and this file
// is deliberately narrow because of it.
//
// ⚠ THE EXTRACTOR DEFAULTS TO NOTHING, AND THAT IS THE WHOLE DESIGN.
// A read is written as prose, and prose about markets is full of sentences that LOOK like calls -
// "if it loses the flip, 769 is next" is a conditional, not a prediction. An extractor that leans
// permissive would mint predictions out of hedged commentary, score NoVo on claims he never made,
// and do it silently on a schedule where nobody is watching. So: strict JSON, an explicit refusal
// path, a hard requirement for a number and a horizon, and NO on anything conditional. Most reads
// should produce nothing, and that is the correct outcome, not a failure of the catcher.
const { vertex, answerText } = require('../_vertex.js');
const { SYSTEM } = require('./analyst-brain.js');
const { makePrediction } = require('./predictions.js');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

const RULES =
  'You are reading one of your own published reads. Find the ONE specific, falsifiable prediction ' +
  'it makes BESIDES its overall directional bias, if there is one.\n\n' +
  'Answer with STRICT JSON and nothing else.\n' +
  'If there is no such prediction: {"has":false}\n' +
  'If there is exactly one: {"has":true,"symbol":"SPY","kind":"close_at"|"direction"|"level_touch",' +
  '"value":<number, for close_at and level_touch>,"side":"up"|"down" (direction only),' +
  '"horizon":"today_close"|"tomorrow_open"|"tomorrow_close"|<minutes as a number>,' +
  '"quote":"<the sentence it came from, verbatim>"}\n\n' +
  'SAY NO unless it is unmistakable. In particular {"has":false} for:\n' +
  '- anything CONDITIONAL ("if it loses the flip, 769 is next") - a condition is not a call\n' +
  '- the overall bias itself, in any wording. That is already scored elsewhere.\n' +
  '- ranges, expected moves, or levels merely described as important\n' +
  '- anything without both a number and a time by which it resolves\n' +
  '- any deadline you cannot state EXACTLY with the four horizons above. A mid-session time on\n' +
  '  a FUTURE day ("by lunch tomorrow", "midday Thursday") has no horizon here. Do NOT round it\n' +
  '  to tomorrow_open or tomorrow_close - that grades the call against a deadline it never made.\n' +
  'A wrong yes puts a claim on your record that you never made. A wrong no costs nothing.';

async function catchReadPrediction(read, ctx) {
  const text = String((read && read.text) || '').trim();
  if (!text || text.length < 40) return { has: false, why: 'no text' };

  let out = '';
  try {
    const resp = await vertex(`${MODEL}:generateContent`, {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: RULES + '\n\nTHE READ:\n' + text.slice(0, 6000) }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 400, responseMimeType: 'application/json',
                          thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
    });
    out = resp ? String(answerText(resp) || '').trim() : '';
  } catch (e) { return { has: false, why: 'model error: ' + e.message }; }

  let j = null;
  try { j = JSON.parse(out); } catch (_) {
    // An unparseable answer is a NO. Salvaging JSON out of prose is how a strict extractor
    // quietly becomes a permissive one.
    return { has: false, why: 'unparseable' };
  }
  if (!j || j.has !== true) return { has: false, why: 'model said no' };

  const symbol = String(j.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const spot = ctx && ctx.spots && symbol ? Number(ctx.spots[symbol]) : NaN;
  /* NO SPOT, NO PREDICTION. A call with no starting price cannot be graded, and inventing one
     from the read's own text would be scoring him against a number he did not commit to. */
  if (!symbol || !isFinite(spot) || spot <= 0) return { has: false, why: 'no spot for ' + symbol };

  const args = { source: 'read', asset_class: 'equity', symbol: symbol, kind: j.kind,
                 spot_at: spot,
                 thesis: String(j.quote || '').slice(0, 200) || 'stated in the read',
                 basis: 'caught in ' + ((read && read.title) || 'a published read') };
  if (j.kind === 'direction') args.side = j.side === 'down' ? 'down' : 'up';
  else args.value = Number(j.value);
  if (typeof j.horizon === 'number') args.horizon_min = j.horizon;
  else args.horizon = j.horizon;

  // makePrediction is the gate on shape: a missing value, a horizon out of range or a kind it does
  // not know are all refused there. This file does not re-implement those rules.
  const made = await makePrediction(args);
  return made && made.ok
    ? { has: true, id: made.id, symbol: symbol, kind: j.kind, quote: j.quote }
    : { has: false, why: (made && made.error) || 'refused' };
}

module.exports = { catchReadPrediction };
