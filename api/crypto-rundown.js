// api/crypto-rundown.js — the Daily Crypto Rundown. One read a day, authored by Dr. NoVo.
//
// Jake, 2026-09-07: "crypto needs a Read like Analyst and Trader get their week ahead and two
// daily reads but maybe crypto gets one a day every day a Daily Crypto Rundown with a
// bitcoin/crypto market bias for the day. thats another thing we can grade and score."
// And: "dr. novo authors it just like every other analysis thats output."
//
// SO IT GOES THROUGH THE SAME BRAIN, not a private prompt of its own. SYSTEM, recordClaimAudit
// and provenanceAudit are the ones the chat and /api/novo-broadcast use — imported, not copied.
// A second persona for one surface is how a product ends up with two voices that disagree about
// what it is allowed to claim.
//
// ── THE BIAS IS GRADED BY MACHINERY THAT ALREADY EXISTS ──────────────────────────────────────
// The bias is recorded through makePrediction() as an ordinary NoVo prediction: BTC, direction,
// 24h, with the spot at the moment it was written. That means it grades on the crypto ingest
// evaluator, scores in the prediction record, and shows on the Predict tab beside every other
// call he makes. Building a second scoring path for this one read would be a second definition
// of "was he right", and two definitions drift.
//
// ⚠ A NEUTRAL BIAS IS NOT RECORDED, AND THE PAGE SAYS SO. Grading a neutral needs a BAND — how
// flat is flat — and the equity side only has one because it was measured first. There is no
// measured band for BTC yet, so a neutral read publishes ungraded rather than inventing a
// threshold and scoring against it. The honest gap is visible; a made-up number would not be.
const crypto = require('crypto');
const { kv } = require('./_kv');
const { vertex, answerText } = require('./_vertex.js');
const { SYSTEM, recordClaimAudit, provenanceAudit } = require('./_lib/analyst-brain.js');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const KEY = 'crypto:read:daily';
const LOG = 'crypto:read:log';

// Vercel cron calls arrive with this header; a manual run needs the publish secret. Either way
// nothing unauthenticated can make NoVo speak.
function authed(req) {
  if (req.headers['x-vercel-cron']) return true;
  const want = process.env.ANALYST_PUBLISH_SECRET || '';
  const got = String(req.headers['x-analyst-secret'] || '');
  if (!want || !got || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (_) { return false; }
}

/* The facts NoVo is allowed to state. Closed-world on purpose: recordClaimAudit checks his answer
   against THIS object, so anything not in here reads as fabricated and gets flagged. Whatever is
   added to the prompt must be added here too — checked equals prompted. */
function factsFrom(snap) {
  if (!snap) return null;
  const coins = snap.coins || {};
  const pick = ['BTC', 'ETH', 'SOL'].filter((c) => coins[c]);
  const out = { as_of: snap.as_of, coins: {}, breadth: snap.breadth || null };
  pick.forEach((c) => {
    const v = coins[c] || {};
    out.coins[c] = {
      price: v.price, chg_24h: v.chg_24h != null ? v.chg_24h : v.chg24h,
      funding: v.funding_annual != null ? v.funding_annual : v.funding,
      oi_usd: v.oi_usd, band: v.band,
      gamma: v.gamma ? { net_gex: v.gamma.net_gex, flip: v.gamma.flip,
                         call_wall: v.gamma.call_wall, put_wall: v.gamma.put_wall,
                         max_pain: v.gamma.max_pain, spot: v.gamma.spot } : null,
      liquidations: v.liquidations || null,
    };
  });
  // The scored record travels WITH the facts. The audit is closed-world over this one object, so
  // leaving the record outside it made every TRUE cited hit rate read as invented — the exact bug
  // /api/novo-broadcast hit and fixed with one key.
  out.record = (snap.alerts && snap.alerts.record) || null;
  out.levels = (snap.alerts && snap.alerts.levels) || null;
  out.reads_24h = (snap.reads && snap.reads.last_24h) || null;
  return out;
}

async function generate(prompt) {
  const resp = await vertex(`${MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.55, maxOutputTokens: 1400,
                        thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
  });
  return resp ? String(answerText(resp) || '').trim() : '';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!authed(req)) return res.status(403).json({ error: 'forbidden' });
  const r = kv();
  if (!r) return res.status(503).json({ error: 'store unavailable' });

  // ONE A DAY. Keyed on the UTC date because crypto has no close to key on — and re-running the
  // cron must not produce a second read that silently replaces the graded one.
  const day = new Date().toISOString().slice(0, 10);
  let prev = null;
  try { prev = await r.get(KEY); } catch (_) {}
  if (typeof prev === 'string') { try { prev = JSON.parse(prev); } catch (_) { prev = null; } }
  if (prev && prev.day === day && !(req.query && 'force' in req.query)) {
    return res.status(200).json({ ok: true, skipped: 'already written today', day });
  }

  let snap = null;
  try { snap = await r.get('crypto:map:live'); } catch (_) {}
  if (typeof snap === 'string') { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
  const facts = factsFrom(snap);
  if (!facts || !facts.coins || !facts.coins.BTC) {
    return res.status(503).json({ error: 'no crypto snapshot to read' });
  }

  const marketJson = JSON.stringify(facts);
  const prompt =
    'Write today\'s DAILY CRYPTO RUNDOWN for the NoVo crypto members.\n\n' +
    'FACTS (the only numbers you may state):\n' + marketJson + '\n\n' +
    'Six to nine sentences, no headings, no bullet lists. Lead with what actually changed in the ' +
    'last 24 hours and why it matters for positioning — dealer gamma and the flip if there is an ' +
    'options book, funding and open interest if there is not. Name the levels that decide the day. ' +
    'Quote a rate only with its sample. If the book is thin or the read is genuinely uncertain, ' +
    'say that plainly instead of manufacturing conviction.\n\n' +
    'Then, on the FINAL line and nothing after it, state your bias for BTC over the next 24 hours ' +
    'in exactly this form:\nBIAS: BULLISH or BIAS: BEARISH or BIAS: NEUTRAL\n' +
    'This bias is recorded and scored the moment you write it, so give the one you actually hold.';

  let text = '';
  try { text = await generate(prompt); } catch (e) { return res.status(502).json({ error: e.message }); }
  if (!text) return res.status(502).json({ error: 'no answer' });

  /* THE SAME GUARDS THE CHAT RUNS. A number he did not get from the facts is a fabrication
     wherever it appears, and a scheduled read nobody watches being written is exactly where an
     unaudited claim would survive longest. */
  let flags = [];
  try {
    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    flags = flags.concat(recordClaimAudit(text, contents, marketJson) || []);
    flags = flags.concat(provenanceAudit(text, facts.record, contents) || []);
  } catch (_) {}

  const m = text.match(/BIAS:\s*(BULLISH|BEARISH|NEUTRAL)\s*$/i);
  const bias = m ? m[1].toUpperCase() : null;
  const body = m ? text.slice(0, m.index).trim() : text;

  const btc = facts.coins.BTC || {};
  const spot = Number(btc.price || (btc.gamma && btc.gamma.spot));

  // The bias becomes an ordinary NoVo prediction — same record, same evaluator, same Predict tab.
  let predicted = null;
  if (bias === 'BULLISH' || bias === 'BEARISH') {
    try {
      const out = await require('./_lib/predictions.js').makePrediction({
        source: 'novo', asset_class: 'crypto', symbol: 'BTC', kind: 'direction',
        side: bias === 'BULLISH' ? 'up' : 'down',
        spot_at: spot, horizon_min: 1440,
        thesis: 'Daily Crypto Rundown — BTC ' + (bias === 'BULLISH' ? 'up' : 'down') + ' over the next 24h',
        basis: 'the day\'s rundown, ' + (facts.as_of || 'today'),
      });
      predicted = out && out.ok ? out.id : (out && out.error) || null;
    } catch (e) { predicted = 'error: ' + e.message; }
  }

  const read = { day, as_of: new Date().toISOString(), text: body, bias: bias,
                 spot_at: isFinite(spot) ? spot : null, prediction_id: predicted,
                 flags: flags.length ? flags : null };
  try {
    await r.set(KEY, JSON.stringify(read), { ex: 60 * 24 * 3600 });
    let log = null;
    try { log = await r.get(LOG); } catch (_) {}
    if (typeof log === 'string') { try { log = JSON.parse(log); } catch (_) { log = null; } }
    log = Array.isArray(log) ? log : [];
    log = log.filter((x) => x && x.day !== day);
    log.push({ day: day, bias: bias, spot_at: read.spot_at, prediction_id: predicted });
    await r.set(LOG, JSON.stringify(log.slice(-60)), { ex: 365 * 24 * 3600 });
  } catch (e) { return res.status(500).json({ error: e.message }); }

  return res.status(200).json({ ok: true, day, bias, predicted, flags: flags.length });
};
