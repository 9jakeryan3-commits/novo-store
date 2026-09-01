#!/usr/bin/env node
// scripts/voice-eval.js — does NoVo still sound like a person?
//
// Voice drifted for weeks without anyone noticing, because nothing watched it: the system prompt
// demands first person, contractions and desk-note brevity, and a live answer to a five-word
// question came back at 279 words with one "I" and no contractions in it. Prose quality has no
// stack trace, so it needs a measurement or it regresses every time an instruction is added.
//
// This scores the things that ARE mechanical about voice — length against the question, whether
// the analyst is present in his own answer, contractions, jargon density, and how fast the answer
// arrives at the answer. It cannot score whether a joke landed. It does not try.
//
// BASELINE, so a future run has something to compare against. Before the voice contract shipped
// (2026-09-01) the live answer to "what's SPY doing right now?" was 279 words, 25.4 words per
// sentence, ZERO contractions and one "I". After the contract, and after repeating it at the END
// of the prompt (SYSTEM alone was thousands of tokens upstream by the time production finished
// appending data), the suite sits at **5/25 missed against production on the standard register**:
// every answer is inside its length budget and uses first person, and the remainder are soft —
// sentences running 25-29 words against a 24 threshold, and short factual answers with no natural
// contraction. TREAT A JUMP TO TEN AS A REGRESSION. Do not tune the prompt to score zero: the
// goal is an analyst who sounds like a person, not one who games five metrics.
//
// A number from an unpinned identity is not comparable to this one — see EVAL_EMAIL below.
//
// Usage:
//   node scripts/voice-eval.js                 # against production
//   node scripts/voice-eval.js --local         # against the SYSTEM prompt in this working tree
//
// --local drives the model directly with the local prompt, so a change can be measured BEFORE it
// ships. It needs GOOGLE_VERTEX_SA_JSON; production mode needs ANALYST_PUBLISH_SECRET.

const path = require('path');
const LOCAL = process.argv.includes('--local');

// Short questions must get short answers; the beginner one must not turn into a lecture; the
// casual one is where "answer the person before the tape" either happens or does not.
const CASES = [
  { id: 'quick',    q: "what's SPY doing right now?",                       maxWords: 120 },
  { id: 'oneword',  q: 'gamma flip?',                                       maxWords: 90 },
  { id: 'casual',   q: 'rough day out there?',                              maxWords: 160 },
  { id: 'beginner', q: "I'm brand new to options. What is gamma and why should I care?", maxWords: 320 },
  { id: 'compare',  q: 'SPY or QQQ closer to its flip?',                    maxWords: 140 },
];

const JARGON = /\b(net GEX|GEX|gamma flip|vanna|charm|theta|vega|delta-neutral|notional|contango|backwardation|skew|percentile|basis|expiry|monetiz\w+|dealer positioning|hedg\w+)\b/gi;

function score(text, c) {
  const t = (text || '').trim();
  const words = t ? t.split(/\s+/).length : 0;
  const sentences = (t.match(/[.!?](\s|$)/g) || []).length || 1;
  const first = (t.match(/(^|\s)I\b|\bmy\b/gi) || []).length;
  const contractions = (t.match(/\b\w+['’](s|t|re|ll|ve|d)\b/gi) || []).length;
  const jargon = (t.match(JARGON) || []).length;
  const firstSentence = (t.split(/(?<=[.!?])\s/)[0] || '');
  const openWords = firstSentence.split(/\s+/).length;
  return {
    words, avgSentence: words / sentences, first, contractions, jargon,
    jargonPer100: words ? (jargon / words) * 100 : 0, openWords,
    checks: {
      'length fits the question': words > 0 && words <= c.maxWords,
      'opens with the answer (<=25w)': openWords <= 25,
      'analyst is present (uses I/my)': first >= 1,
      'writes like a person (contractions)': contractions >= 1,
      'sentences readable (<=24w avg)': words / sentences <= 24,
    },
  };
}

// ⚠️ NEVER POINT THIS AT A REAL READER'S SEAT. It defaulted to the owner's comp address and
// silently measured whatever REGISTER that account was set to: with Plain English on, every
// answer carries an inline gloss, which lengthens sentences and reads as a voice regression that
// is really the reader's own preference working correctly. It also means the eval would WRITE a
// level onto a real member's memory if the pinning below were ever passed through. A dedicated
// identity, and the register pinned explicitly, so runs are comparable to each other and to the
// baseline. `standard` is the default register and therefore the thing worth regression-testing.
const EVAL_EMAIL = process.env.VOICE_EVAL_EMAIL || 'voice-eval@novo-options.trade';
const EVAL_LEVEL = process.env.VOICE_EVAL_LEVEL || 'standard';

async function askProd(q) {
  const crypto = require('crypto');
  const sec = process.env.ANALYST_PUBLISH_SECRET || process.env.ANALYST_LIVE_SECRET;
  if (!sec) throw new Error('set ANALYST_PUBLISH_SECRET to run against production');
  const p = Buffer.from(JSON.stringify({ e: EVAL_EMAIL, x: Date.now() + 900000 })).toString('base64url');
  const t = p + '.' + crypto.createHmac('sha256', sec).update(p).digest('base64url');
  const r = await fetch((process.env.SITE_URL || 'https://novo-options.trade') + '/api/analyst-ask', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ t, question: q, level: EVAL_LEVEL }),
  });
  const j = await r.json();
  return j.answer || j.error || '';
}

async function askLocal(q) {
  const Module = require('module');
  const fs = require('fs');
  const P = path.join(__dirname, '..', 'api', 'analyst-ask.js');
  const src = fs.readFileSync(P, 'utf8')
    .concat('\nmodule.exports.__SYSTEM = SYSTEM;\nmodule.exports.__callModel = callModel;\nmodule.exports.__MODEL = MODEL;\n');
  const m = new Module(P, null);
  m.filename = P; m.paths = Module._nodeModulePaths(path.dirname(P));
  m._compile(src, P);
  const { __SYSTEM: SYSTEM, __callModel: callModel, __MODEL: MODEL } = m.exports;
  // A fixed, plausible board so runs are comparable to each other.
  const DATA = JSON.stringify({ live: { tickers: [
      { ticker: 'SPY', spot: 767.54, flip: 766.93, callWall: 772, putWall: 765, netGex: 56020000, gravity: 768.17 },
      { ticker: 'QQQ', spot: 716.67, flip: 715.42, callWall: 722, putWall: 710, netGex: 107400000 },
      { ticker: 'IWM', spot: 293.98, flip: 297.53, callWall: 300, putWall: 293, netGex: -113060000 }],
      vix: 14.43, atmIv: 10.7, expectedMove: 5.16 },
    history: { sessions_logged: 29, expected_move_rate: 96.2, expected_move_baseline: 68 } });
  const j = await callModel(`${MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text:
      `RIGHT NOW: 2026-09-01, market closed.\n\nMARKET DATA (every number you may state is here):\n${DATA}\n\nQUESTION: ${q}` }] }],
    generationConfig: { temperature: 0.25, maxOutputTokens: 1600,
                        thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
  });
  return ((j?.candidates?.[0]?.content?.parts) || []).filter((p) => p.text && !p.thought)
    .map((p) => p.text).join('').trim();
}

(async () => {
  console.log(`voice eval — ${LOCAL ? 'LOCAL prompt (unshipped)' : 'PRODUCTION'}\n`);
  let failed = 0, total = 0;
  for (const c of CASES) {
    let text = '';
    try { text = LOCAL ? await askLocal(c.q) : await askProd(c.q); }
    catch (e) { console.log(`[${c.id}] ERROR ${e.message}`); failed++; continue; }
    const s = score(text, c);
    const bad = Object.entries(s.checks).filter(([, v]) => !v).map(([k]) => k);
    total += Object.keys(s.checks).length;
    failed += bad.length;
    console.log(`[${c.id}] ${s.words}w · ${s.avgSentence.toFixed(1)}w/sent · opens ${s.openWords}w · ` +
                `I×${s.first} · contractions×${s.contractions} · jargon ${s.jargonPer100.toFixed(1)}/100w`);
    if (bad.length) console.log(`   MISSED: ${bad.join(' | ')}`);
    console.log(`   "${text.replace(/\s+/g, ' ').slice(0, 150)}…"\n`);
  }
  console.log(failed ? `${failed}/${total} checks missed` : `all ${total} checks passed`);
  process.exitCode = failed ? 1 : 0;
})();
