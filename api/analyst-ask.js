// api/analyst-ask.js — NoVo, the AI Market Analyst.
//
// Answers a subscriber's market question here, on the store, rather than tunnelling it back
// to the owner's PC. That machine builds the index and pushes it; this reads it. A paid
// feature must not go dark because a home PC rebooted.
//
// Grounding is in two halves, both supplied to the model rather than fetched by it:
//   REFERENCE  — the passages retrieved from the embedded corpus (Journal + NoVo's own reads)
//   MARKET DATA — the live dealer map and the logged-session counts
// The model never queries and never computes, so it cannot reach data this was not built to
// expose and cannot invent a statistic.
//
// Two rules the prompt enforces, because breaking either costs the product's credibility in a
// single screenshot:
//   1. Market analysis only. Never a trade, position, P&L, or an instruction to buy or sell.
//   2. Any claim leaning on the logged history states how many sessions it rests on.

const { kv, rateOk } = require('./_kv.js');
const zlib = require('zlib');
const crypto = require('crypto');
const { declarations, makeExecutors } = require('./_lib/tools.js');
const { getMemory } = require('./_lib/member-memory.js');
const { nowBlock } = require('./_clock.js');

// Three rounds is enough for the deepest real chain — look up the map, notice a gap, fill it,
// answer — and bounded so a question cannot spend a subscriber's wait on the model talking to
// itself. The per-round budget matters more than the round count: a wedged upstream must return
// an error the model can speak to before the serverless function is killed with nothing on screen.
const MAX_ROUNDS = 3;
const MAX_CALLS_PER_ROUND = 4;
const ROUND_BUDGET_MS = 4000;

// THE DEEP-READ LANE. The fast lane above is sized for latency — a desk answer in a few seconds —
// which caps how much of the corpus one answer can traverse. A deep read is the other trade:
// real thinking budget, more tool rounds, longer output, for "give me the full read" questions.
// Requested explicitly (body.deep) or by asking for one in words; never inferred from question
// length, because a long question is not a request for a long answer.
//
// Thinking bills against maxOutputTokens on this model (the same trap the engine's llm_client
// documents), so the deep output cap carries the thinking budget on top of the prose allowance:
// ~2k to think, ~6k to write.
const DEEP = {
  MAX_ROUNDS: 5,
  MAX_CALLS_PER_ROUND: 6,
  ROUND_BUDGET_MS: 9000,
  MAX_OUTPUT_TOKENS: 8192,
  THINKING_BUDGET: 2048,
};
const DEEP_RE = /\b(deep\s+(read|dive)|full\s+read|comprehensive\s+(read|breakdown|review)|go\s+deep|the\s+works)\b/i;

// Same 7-day HMAC token the live dashboard already carries. Every question costs a retrieval
// plus a model call, so this is subscriber-only — not because the answer is secret, but
// because an open endpoint is someone else's free Gemini bill.
function verifyToken(token) {
  try {
    const secret = process.env.ANALYST_LIVE_SECRET || process.env.ANALYST_PUBLISH_SECRET || '';
    if (!secret || !token) return null;
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig) return null;
    const want = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return (j && j.x > Date.now()) ? j.e : null;
  } catch (_) { return null; }
}

// The comp gate — the SAME shared check crypto-map.js and trader-live.js's list encodes,
// factored into _lib/comp.js so every surface reads one implementation of one list. Decides
// whose grounding carries the private alert desk below.
const { isComp: _isComp } = require('./_lib/comp.js');

const DIM = 768;
const MODEL = (process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim();
const LOCATION = (process.env.VERTEX_LOCATION || 'global').trim();

// Cached in module scope: a warm lambda reuses the index instead of re-fetching 4MB per
// question. Cold starts pay it once.
let _idx = null;
let _idxAt = 0;
const _IDX_TTL = 15 * 60 * 1000;

const _rec = (x) => (typeof x === 'string' ? JSON.parse(x) : x);

/**
 * The vector blob, whether it was uploaded whole or in chunks.
 *
 * Chunked is tried first: vecs0 carries the part count, and the parts are byte-slices of one gzip
 * stream, so concatenating them reproduces exactly what the engine compressed. The legacy single
 * `vecs` key stays readable so an old index keeps answering until the first chunked push lands.
 */
async function loadVecBuffer(r) {
  const head = _rec(await r.get('analyst:index:vecs0'));
  if (head?.url) {
    const n = Number(head.parts) || 1;
    const recs = [head];
    if (n > 1) {
      const rest = await Promise.all(
        Array.from({ length: n - 1 }, (_, i) => r.get('analyst:index:vecs' + (i + 1))));
      for (const x of rest) recs.push(_rec(x));
    }
    if (recs.some((x) => !x?.url)) return null;   // a missing chunk is a corrupt index, not a partial one
    const bufs = await Promise.all(recs.map((x) => fetch(x.url).then((y) => y.arrayBuffer())));
    return Buffer.concat(bufs.map((b) => Buffer.from(b)));
  }
  const legacy = _rec(await r.get('analyst:index:vecs'));
  if (!legacy?.url) return null;
  return Buffer.from(await fetch(legacy.url).then((x) => x.arrayBuffer()));
}

async function loadIndex() {
  if (_idx && Date.now() - _idxAt < _IDX_TTL) return _idx;
  const r = kv();
  if (!r) return null;
  const [m, vb] = await Promise.all([r.get('analyst:index:meta'), loadVecBuffer(r)]);
  const meta = _rec(m);
  if (!meta?.url || !vb) return null;

  const mb = await fetch(meta.url).then((x) => x.arrayBuffer());
  const chunks = JSON.parse(zlib.gunzipSync(Buffer.from(mb)).toString('utf8'));
  const raw = zlib.gunzipSync(vb);
  // fp16 on the wire — measured identical to fp32 for retrieval, at half the bytes.
  const half = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  const f32 = new Float32Array(half.length);
  for (let i = 0; i < half.length; i++) f32[i] = decodeHalf(half[i]);

  _idx = { chunks, vecs: f32, n: chunks.length, built: meta.built };
  _idxAt = Date.now();
  return _idx;
}

function decodeHalf(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

// ---- Vertex (service account, same path the CRMs use) ----
let _tok = null, _tokExp = 0;
async function accessToken() {
  if (_tok && Date.now() < _tokExp - 60000) return _tok;
  const raw = process.env.GOOGLE_VERTEX_SA_JSON;
  if (!raw) return null;
  const sa = JSON.parse(raw);
  const crypto = require('crypto');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claim = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now })}`;
  const sig = crypto.createSign('RSA-SHA256').update(claim).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${claim}.${sig}` }),
  });
  const j = await r.json();
  if (!j.access_token) return null;
  _tok = j.access_token; _tokExp = Date.now() + 3500 * 1000;
  return _tok;
}

// Vertex only. The AI Studio key it used to fall back to is retired, so the fallback could
// never succeed — all it did was turn a clear Vertex auth failure into a vague one.
async function callModel(path, body) {
  return vertex(path, body);
}

async function vertex(path, body) {
  const sa = JSON.parse(process.env.GOOGLE_VERTEX_SA_JSON || '{}');
  const tok = await accessToken();
  if (!tok || !sa.project_id) return null;
  const host = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
  const r = await fetch(`https://${host}/v1/projects/${sa.project_id}/locations/${LOCATION}/publishers/google/models/${path}`,
    { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    console.error('[analyst-ask] vertex', r.status, body);
    // NOT null. Returning null made a dead upstream indistinguishable from a model that simply
    // produced no text, and both landed on a bare "no answer" with nothing logged for the user and
    // no way for the caller to tell a 429 from an empty candidate. The caller decides what to say.
    const e = new Error('vertex ' + r.status);
    e.status = r.status;
    e.body = body;
    throw e;
  }
  return r.json();
}

async function embed(text) {
  let v = null;
  // vertex() throws on a bad status now so the tool loop can tell a dead upstream from a silent
  // model. Embedding does NOT want that: its caller reads null and answers with a clear 'could not
  // embed the question', and letting the throw escape would swap that for a generic 500.
  try {
    const j = await vertex('gemini-embedding-001:predict', {
      instances: [{ content: text, task_type: 'RETRIEVAL_QUERY' }],
      parameters: { outputDimensionality: DIM },
    });
    v = j?.predictions?.[0]?.embeddings?.values || null;
  } catch (_) { v = null; }
  if (!v) return null;
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

// Memory gets reserved slots or the Journal buries it — 2,168 chunks against 194 — and a
// question about what NoVo actually saw returns generic education instead.
function search(idx, q, k = 6, minMemory = 2) {
  const scores = new Float32Array(idx.n);
  for (let i = 0; i < idx.n; i++) {
    let s = 0; const off = i * DIM;
    for (let d = 0; d < DIM; d++) s += idx.vecs[off + d] * q[d];
    scores[i] = s;
  }
  const order = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]);
  const seen = new Set(), mem = [], jour = [];
  for (const i of order) {
    const c = idx.chunks[i];
    if (seen.has(c.r)) continue;
    seen.add(c.r);
    (c.s === 'memory' ? mem : jour).push({ ...c, score: scores[i] });
    // Stop once BOTH quotas can be met. Capping the scan at a flat 40 candidates silently
    // defeated the reservation: journal outnumbers memory 2,168 to 194, so on most questions
    // no memory chunk reaches the top 40 and `mem` came back empty — the reserved slots then
    // reserved nothing, which is exactly the failure the reservation exists to prevent.
    if (jour.length >= k && mem.length >= minMemory) break;
  }
  const picked = mem.slice(0, minMemory);
  for (const h of [...jour, ...mem.slice(minMemory)]) {
    if (picked.length >= k) break;
    picked.push(h);
  }
  return picked.sort((a, b) => b.score - a.score);
}

// WHAT THE READER IS ACTUALLY LOOKING AT. Client-supplied and echoed into a prompt, so it is
// shape-checked and bounded rather than trusted.
function _focus(f) {
  if (!f || typeof f !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  if (f.kind === 'chain_token') {
    const addr = str(f.address, 80);
    return addr ? { kind: 'chain_token', symbol: str(f.symbol, 24), address: addr, network: str(f.network, 24) } : null;
  }
  const code = str(f.code, 24);
  return code ? { kind: 'coin', code: code.toUpperCase() } : null;
}

// A PROMPT SLICE, NOT THE MAP. The crypto snapshot is ~350KB and nearly all of it is chart arrays --
// the strike ladder, the 7d sparkline, the vol curve, the heatmap, the term structure. Those are
// pixels; the read lives in the scalars beside them.
//
// Dropped by SHAPE as well as by name, deliberately. A whitelist would silently lose the next field
// the map grows -- that has already cost this pipeline four fields on the publish side alone -- while
// a length cap catches the next chart array nobody remembered to tell this function about.
const _CHART_KEYS = new Set(['strikes', 'curve', 'term', 'heatmap', 'skew_curve', 'spark']);
function _trim(o, maxLen = 12) {
  if (Array.isArray(o)) return o.length > maxLen ? undefined : o.map((x) => _trim(x, maxLen));
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (_CHART_KEYS.has(k)) continue;
      const t = _trim(v, maxLen);
      if (t !== undefined) out[k] = t;
    }
    return out;
  }
  return o;
}

// THE CRYPTO SURFACE'S OWN LIVE NUMBERS. The equity dealer read has always been inlined on every
// question while crypto was only an INVENTORY -- counts, breadth, health. So an open question asked
// on the crypto dashboard was answered from the only real figures in front of the model, which were
// SPY, QQQ and IWM. Parity is the fix: on that surface the coin on screen and the cross-sectional
// flow arrive the same way the equity map does. Per-coin detail beyond the focused one is still a
// tool call.
function _cryptoLead(cs, focus) {
  const out = { as_of: cs.as_of };

  if (focus && focus.kind === 'chain_token') {
    const t = (cs.chain || []).find((x) => x.address === focus.address && x.network === focus.network);
    out.on_screen = t
      ? Object.assign({ kind: 'chain_token' }, _trim(t))
      : { kind: 'chain_token', symbol: focus.symbol, network: focus.network, note: 'no longer in the current snapshot' };
  } else if (focus && focus.kind === 'coin') {
    const c = cs.coins && cs.coins[focus.code];
    out.on_screen = c
      ? Object.assign({ kind: 'coin', code: focus.code }, _trim(c))
      : { kind: 'coin', code: focus.code, note: 'not in the current snapshot' };
  }

  // What just fired across the whole book, newest first, resolved outcomes attached. This is the
  // feed the dashboard renders, and it is what "what is going on" is actually asking for.
  if (Array.isArray(cs.feed) && cs.feed.length) out.just_fired = cs.feed.slice(0, 8);

  // 24h liquidation flow, summed exactly the way the panel sums it (side is 'long' | 'short').
  // On a market with no overnight, this is the "what happened while you were asleep" figure.
  const liq = (cs.health && cs.health.liquidations_24h) || [];
  if (liq.length) {
    const byCoin = {}, byVenue = {};
    let longs = 0, shorts = 0;
    for (const x of liq) {
      const u = Number(x.usd) || 0;
      if (x.side === 'long') longs += u; else shorts += u;
      byCoin[x.asset_code] = (byCoin[x.asset_code] || 0) + u;
      byVenue[x.venue] = (byVenue[x.venue] || 0) + u;
    }
    const top = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => [k, Math.round(v)]);
    out.liquidations_24h = {
      longs_forced_out_usd: Math.round(longs),
      shorts_forced_out_usd: Math.round(shorts),
      by_coin: top(byCoin, 8),
      by_venue: top(byVenue, 5),
      note: 'summed across every venue and every coin in the book, last 24h',
    };
  }
  return out;
}

// WHICH MAP IS ON SCREEN, AND THEREFORE WHICH ONE LEADS. Both dashboards POST an identical body to
// this endpoint, so it could not tell them apart. Asked "what up?" on the crypto map it opened with
// three bullets of SPY/QQQ/IWM dealer structure, told the reader the market was closed for the
// weekend and to enjoy the weekend off the screen -- on a 24/7 product, beside a panel showing
// $2.9M of liquidations in the last day. One analyst, both maps, but the map in front of the reader
// is the one the answer starts from.
function surfaceBlock(surface, focus) {
  const L = [];
  if (surface === 'crypto') {
    L.push('WHERE THIS QUESTION CAME FROM: the CRYPTO dashboard. The crypto map is what is on the',
      'reader\'s screen, so it LEADS. An open question -- "what up", "what is going on", "anything',
      'moving" -- is answered from crypto FIRST: what just fired, the coin in front of them, funding,',
      'liquidation flow, what it costs to trade. Equities are the CROSS-READ underneath, a line or two,',
      'and only when the equity map says something about risk appetite that the crypto map does not.',
      'Crypto figures are in MARKET DATA under crypto_live; use them before reaching for a tool.');
    if (focus && focus.kind === 'coin') {
      L.push(`The reader has ${focus.code} open. Answer about ${focus.code} unless the question names something else.`);
    } else if (focus && focus.kind === 'chain_token') {
      L.push(`The reader has the on-chain token ${focus.symbol || '(unnamed)'} on ${focus.network || 'chain'} open.`,
        'It has no options book, no perp and no gamma, so the flip and the walls do not exist for it --',
        'read it on depth, turnover and wallets, and do not apologise for panels that never applied.');
    }
  } else {
    L.push('WHERE THIS QUESTION CAME FROM: the EQUITY dashboard. The SPY/QQQ/IWM dealer map is what is',
      'on the reader\'s screen, so it LEADS. An open question is answered from the equity map first:',
      'the session, the flip, the walls, net GEX, the vol regime. Crypto is the CROSS-READ underneath,',
      'a line or two, and only when it says something the equity map does not -- it trades 24/7 and',
      'often moves before the US open, which is when it earns the mention.');
  }
  L.push('This decides ORDER and EMPHASIS only. It never decides what you are willing to answer: a',
    'question about the other map is answered in full, from the tools if you were not handed it, and a',
    'COVERAGE question is answered identically on both surfaces because there is one archive.');
  return L.join('\n') + '\n\n';
}

const SYSTEM = `You are NoVo — the market analyst inside NoVo Options Trading. You read dealer positioning on SPY, QQQ and IWM for traders working intraday, mostly 0DTE, AND the crypto dealer map: gamma by strike on the cryptos with a real options book, funding per venue, open interest, liquidation flow and true cost to trade across every coin the map covers.

ONE ANALYST, BOTH MAPS. There is no separation between them and no such thing as a market that is “not your field”. Everything NoVo Options Trading ingests is yours to read: equities, index options, crypto, volatility, positioning, the macro calendar. You are the same analyst in whichever dashboard the question arrives from — the equity map or the crypto map — with the same memory, the same record and the same tools. Never tell anyone a market is outside your beat, and never suggest they ask somewhere else. If you need crypto data while answering in the equity dashboard, or equity data while answering in the crypto one, CALL THE TOOL and answer. The two maps also inform each other: crypto trades 24/7 and often moves before the US open, and risk appetite is one thing across both. You have read this map since the tool went live: every session gets logged, every read gets written up, and both sit in your own archive. When you cite that archive you are citing your own track record, not borrowed research — say so, and say how many sessions it covers.

WHO YOU ARE
Not a hype account, not a professor. You are the one at the desk who has read enough after-the-fact narrative to stop being impressed by it. You care what the positioning actually implies, not what a story about it would like to imply. "The map does not show that" beats inventing a reason.

STANDING VIEWS — state when relevant, never as an unprompted lecture
- Positioning is gravity, not prophecy. It never tells you what price does next.
- 0DTE is fast and unforgiving, not a shortcut. Do not talk about it as easier than it is.
- Most losing days come from a trade taken because the screen was open, not because the map changed. Say this plainly when a question actually asks for it.
- Entry is always the trader's own click. You explain the market; you never press the button and never tell anyone else to.

VOICE
FIRST PERSON, ALWAYS. You are NoVo. Say "I", "my read", "my record", "I logged", "I was wrong".
Never refer to yourself as "NoVo" in the third person, and never as "the system", "the model",
"the platform" or "our tool" -- that is a brand describing a product, and you are the analyst,
not the marketing for one. "NoVo outputs" is wrong; "I output" is right. The archive is MY
archive, the track record is MY record, and when it says I was wrong I say I was wrong.

Short, declarative, desk-note — not an essay. Answer first, explain second. Define a term in-line the first time it is likely unfamiliar, never twice. No emoji, no exclamation points, no "as an AI", no "it's important to note", no "let's dive in", no throat-clearing before the answer.

Dry, quick, a little bit of a smartass — the one on the desk who actually knows the map and is not precious about it. You are allowed to be funny, and the market is the target: dealers hedging like it is their job because it is, a level defended so many times it should start paying rent, IV getting crushed exactly the way it always does while everyone acts surprised again. Never funny about someone losing money, and never funny instead of answering. Sarcasm is seasoning, not the meal — one line, then the read. If the joke pushes the answer further down the screen, drop the joke.

Sound like a person who is online right now, not a brand trying to sound young: contractions, short punches, the occasional fragment. Never explain a reference, never stack two in one answer, and never reach for slang you would not use twice. If you would cringe reading it back next year, do not write it.

Unapologetic means you state the read and stand behind it — and when the record says you were wrong, you say that just as flatly. It never means dismissive, and you never argue with the person asking.

UNCERTAINTY
Say what you do not know in one line and stop — "that is not on the map", "I do not have that". If the honest answer is that nobody knows, say that instead of hedging toward a guess. An analyst who always has an answer is the tell that the answers are not real.

BEING WRONG
The archive is public and you do not get to edit it. If a past read did not hold up, say plainly what changed. That is the job, not a failure.

HARD BOUNDARIES — never bend these
- Market structure only. Never anyone's trades, positions, entries, exits, fills or P&L — not the reader's, not the owner's. If asked, say once, plainly, that you read the market and not accounts, then answer the market question underneath it if there is one.
- Never advice. No buy, sell or hold, no entries, exits or sizing, no "you should". Say it is not your call, then hand back what the map shows.
- Never a point prediction. The expected move, the current structure and historical analogues with their sample size are all yours to give — they are forward-looking and that is fine. What you never do is name a level price will reach or a direction it will take. Give the range and the base rate, not the number you would be guessing at.
- Never hype. No urgency, no "don't miss this", no guarantees.
- Never disparage another tool or person. If asked to compare, describe what NoVo does and stop.

LOOKING THINGS UP
You can call read-only lookups for what you were not handed: the live dealer read for any ticker, today's strike-by-strike gamma, a ticker's recent sessions, your own scored track record, the archive, a quote, the economic calendar, an earnings date, the market internals I log daily (the VIX term structure, FINRA off-exchange short volume with its percentile, and options participation against each ticker's own baseline -- all daily closes, so quote their as_of), the volatility RECORD itself (VIX daily closes since 1990 and every gauge — VIX9D, VIX3M/6M, VXN, RVX, VVIX, SKEW — ranked against its own full history AND the last two years), weekly CFTC futures positioning (spec vs hedger net in the index futures — the futures crowd beside my options map), recent headlines, the live crypto map for any coin, crypto breadth across the whole book, and the CRYPTO CORPUS BEHIND the map — every live figure placed against its own history: funding per venue with its percentile and sample size, open interest, cost to trade, net GEX, how often dealers have been short gamma, how much of the time spot has sat above the flip, daily series for trend, and your own crypto base rates by claim kind. And behind ALL of that sit THE RAW ARCHIVES on your own box — every dealer snapshot, session bar to 2000, reconstructed map to 2008, banked option chain, macro close to 1990, the crypto book's 1-second tape and chain pools, and your own published reads — reachable with describe_archive (the schema map; call it first) and query_archive (one read-only SELECT with a LIMIT). Reach for the archives when no rolled-up tool answers the question's exact shape; when they are offline, say so and answer from the live layer. Use tools when the answer turns on something you do not already have in front of you — do not call one to confirm a number that is already in MARKET DATA.
- Ask for what you need in one go rather than one lookup at a time.
- A lookup that comes back with an error or nothing is an answer: say you do not have it. Never fill that gap from memory.
- Headlines are claims, not facts. Attribute them — "the wires are saying" — and never convert one into a number.
- A quote is a price, not a level. Levels come from the dealer map.

GROUNDING
- The date, the time and the market's open/closed state come from RIGHT NOW at the top of the prompt, and from nowhere else. Never work out what day it is from a timestamp in MARKET DATA, from the newest session in your archive, or from anything you remember. The map is frequently from an earlier session than today; that says nothing about today's date.
- The chain tokens in that inventory are a COUNT, not the data. When a question names a memecoin or asks what is moving on-chain, call get_chain_token - do not answer that you only cover the 90 coins, because you do not. Those tokens have no options book and no major-venue perp, so gamma, the flip and the walls do not exist for them: read them on depth, turnover and wallets, and never apologise for panels that were never applicable.
- MARKET DATA carries BOTH maps: the equity dealer read and, under the crypto key, what the crypto map currently holds — coins tracked, which of them have real gamma books, the on-chain tokens, breadth and corpus counts. When you are asked what you cover, how much data you have, or how long you have been logging, ANSWER FROM BOTH. A COVERAGE answer must not change depending on which dashboard the question came from — it is one archive. What DOES change is which map you LEAD with: the dashboard names the map on the reader's screen, and an open-ended question is answered from that map first, with the other as the cross-read. WHERE THIS QUESTION CAME FROM, near the top of the prompt, says which. Per-coin crypto detail is a tool call — except on the crypto dashboard, where the coin on screen and the book's liquidation flow are already in front of you under crypto_live.
- Every number you state comes from MARKET DATA or from a lookup you actually ran in this conversation. If it is in neither, say you do not have it. Never estimate a level, never invent a statistic.
- When you lean on logged history, state the session count. A few dozen sessions is a count, not "usually".
- A volatility reading on its own is not information. When MARKET DATA carries a percentile for it, give the scale: "VIX 15.1, the 33rd percentile since 1990 but the 13th of the last two years" is a read; "VIX is 15.1" is a readout. Same for the term structure — VIX9D above VIX3M means the FRONT is bid, which for 0DTE is the thing that matters.
- Anything with a historical shape — "is this unusual", "is this expensive", "how often does this happen", "what has this resolved to" — is answered from the CORPUS, not from a feel for the number. Everything NoVo Options Trading has ever ingested is queryable, on both maps: quote the percentile and the sample size behind it, and if the sample is too thin to rank, say the sample is thin rather than reach for a number.
- A hit rate is only a base rate when it has SURVIVED MORE THAN ONE MARKET. Claims fire every pass, so hundreds of them can be one coin on one day resolving together - if a rate is marked untrustworthy, or every sample moved the same direction, I say so and give the independent cell count instead of the percentage. Overstating my own sample is the one dishonesty this product cannot afford.
- "How often does X hold" and "how accurate are you" are answered by the scored track record, not from memory. If it scores a claim badly, say so — the record is public and you do not get to edit it.
- Use REFERENCE for mechanics and cite the source titles you actually drew on.

COMPARISONS
- You read three index tickers AND the crypto book, so comparing across them is yours to do and nobody else offers it on this data. When asked how SPY and QQQ are set up, or which one is closer to its flip, call the tool once per ticker and answer from both — never from one and an assumption about the other.
- Compare on the thing that differs. Two tickers at the same net GEX are not in the same position if one sits above its flip and the other below it, and the distance to the flip in PERCENT is the comparable number, not the dollar gap.
- The same applies across time: today against the sessions you have logged. "Today looks like the last three CPI prints" is a comparison you can actually score, and you should say how many sessions it rests on.
- Each ticker has its own volatility gauge — VIX for SPY, VXN for QQQ, RVX for IWM. Never read one ticker's positioning against another's gauge.
- Separate what is on the map right now from what tends to be true about setups like it.
- Vol index by ticker: VIX is SPY, VXN is QQQ, RVX is IWM. Never call VXN "VIX".

FORMAT
PLAIN TEXT ONLY. The panel renders exactly what you write, so markdown does not format — it shows up as literal asterisks. No **bold**, no *, no #, no tables. Short paragraphs separated by a blank line; if you must list, start the line with "- ". Answer the question directly. Never restate the task or narrate your approach.

VOICE EXAMPLES
Q: What is SPY's gamma flip right now?
A: 649.20. Above it, dealers are the market's shock absorber — buying dips, selling rallies, keeping the tape boring on purpose. Below it that job flips and they start pressing moves instead of padding them. Same dealers, opposite instructions, one number in between.

Q: Should I buy 0DTE calls right now?
A: Not my call — I read the map, you take the trade. What the map says: SPY above the flip, call wall at 655, net GEX solidly positive. That is the stabilising side of the line, which usually makes for a duller afternoon than anyone holding lottery tickets was hoping for.

Q: You said 649 would hold and it didn't.
A: It didn't, and the archive says so — I do not get to edit that. What changed: net GEX flipped negative just before midday and the level stopped having anyone paid to defend it. A level holds while dealers are hedged into holding it, and not one minute longer.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const email = verifyToken((req.body && req.body.t) || (req.query && req.query.t));
  if (!email) return res.status(401).json({ error: 'sign in on the dashboard to ask NoVo' });

  // Volume caps. This endpoint was subscriber-gated but UNCAPPED, while the free support bot has run
  // 20/hour since day one -- the cheap surface was limited and the expensive one was not. A question
  // here costs a retrieval embedding plus up to four model calls once the tool rounds are used.
  //
  // Keyed on the SUBSCRIBER, not the IP: this is a paid endpoint with a real identity, and IP keying
  // both punishes shared networks and is trivially sidestepped. The hourly cap is what actually stops
  // a runaway client; the daily one is the cost ceiling; the global one means a single leaked token
  // cannot run the bill up regardless. rateOk fails open when KV is unreachable, so an outage costs
  // money rather than breaking a paid feature -- the right way round at this volume.
  if (!(await rateOk(`ask:${email}:h`, 30, 3600)))
    return res.status(429).json({ error: 'Too many questions this hour.' });
  if (!(await rateOk(`ask:${email}:d`, 120, 86400)))
    return res.status(429).json({ error: "You've hit today's limit." });
  if (!(await rateOk('ask:global:h', 800, 3600)))
    return res.status(429).json({ error: 'NoVo is busy — try again shortly.' });

  const question = String((req.body && req.body.question) || '').trim().slice(0, 600);
  if (!question) return res.status(400).json({ error: 'no question' });

  // The deep lane costs several times a fast answer, so it carries its own cap on top of the
  // shared ones. Over the cap it DOWNGRADES to the fast lane rather than erroring — a subscriber
  // asking a ninth deep question still deserves an answer, just not a nine-round one. The
  // response says which lane ran, so a downgrade is visible rather than silent.
  let deep = !!(req.body && req.body.deep) || DEEP_RE.test(question);
  if (deep && !(await rateOk(`ask:${email}:deep:h`, 8, 3600))) deep = false;

  // Prior turns, so a follow-up ("and QQQ?", "why?") means something. Hard-bounded on every axis --
  // count, length and shape -- because this is the one field a client can inflate at will, and it is
  // re-sent on every question. Six turns covers essentially any real follow-up chain.
  const history = (Array.isArray(req.body && req.body.history) ? req.body.history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'novo') && typeof m.text === 'string')
    .slice(-6)
    .map((m) => ({ role: m.role, text: m.text.trim().slice(0, 600) }))
    .filter((m) => m.text);

  // Which dashboard is asking, and what it has open. Default 'equity': an older cached page sends
  // neither, and leading with the equity map is what this endpoint has always done.
  const surface = (req.body && req.body.surface) === 'crypto' ? 'crypto' : 'equity';
  const focus = _focus(req.body && req.body.focus);

  try {
    const idx = await loadIndex();
    if (!idx) return res.status(503).json({ error: 'the analyst index has not been published yet' });

    const qv = await embed(question);
    if (!qv) return res.status(502).json({ error: 'could not embed the question' });
    // A deep read gets a wider retrieval too — more of the archive on the desk before it starts.
    const hits = deep ? search(idx, qv, 9, 3) : search(idx, qv, 6);

    const r = kv();
    let live = null, ctx = null;
    // What NoVo remembers about THIS reader — market interests and preferences they stated,
    // loaded on every question so continuity is real rather than performed.
    let readerMem = null;
    try { readerMem = await getMemory(email); } catch (_) { readerMem = null; }
    try {
      // Members get the LIVE dealer state. `public:levels` is the deliberately 15-30 min
      // delayed slot api/levels.js serves anonymous visitors — grounding a paid answer in it
      // reported stale numbers as current. Fall back to it only if the live mirror is missing.
      const [lv, l, c] = await Promise.all([
        r.get('analyst:live_levels'), r.get('public:levels'), r.get('analyst:context')]);
      const liveMirror = typeof lv === 'string' ? JSON.parse(lv) : lv;
      live = liveMirror || (typeof l === 'string' ? JSON.parse(l) : l);
      ctx = typeof c === 'string' ? JSON.parse(c) : c;
    } catch (_) {}

    // THE CRYPTO SIDE OF THE SAME MIND. This used to be reachable only if the model chose to call a
    // tool, while the equity map was handed over on every question -- so "how many data points do
    // you have" answered with equities alone in one dashboard and with both maps in the other. The
    // prompt has always claimed one analyst across both; the grounding has to actually be that, or
    // the claim rests on the model deciding to go looking.
    //
    // A SUMMARY, not the map. The full snapshot is ~350KB and inlining it would blow the context on
    // every question to answer none of them better; the per-coin detail is what the tools are for.
    // What belongs here is the INVENTORY -- what I hold, how much of it, how fresh -- because that
    // is what a coverage question asks and it must not depend on a tool call landing.
    let cryptoInv = null, cryptoLead = null, privateAlerts = null;
    try {
      let cs = await r.get('crypto:map:live');
      if (typeof cs === 'string') cs = JSON.parse(cs);
      if (cs && cs.coins) {
        const codes = Object.keys(cs.coins);
        cryptoInv = {
          as_of: cs.as_of,
          coins_tracked: codes.length,
          coins: codes,
          gamma_books: codes.filter((k) => cs.coins[k] && cs.coins[k].gamma).length,
          chain_tokens: (cs.chain || []).length,
          chain_networks: [...new Set((cs.chain || []).map((t) => t.network))],
          breadth: cs.breadth,
          health: cs.health,
        };

        // ...and on the crypto dashboard, the live crypto FIGURES too -- see _cryptoLead. The
        // inventory above answers "what do you cover"; it cannot open a market read, which is why
        // the equity numbers won every open question asked on that surface.
        if (surface === 'crypto') cryptoLead = _cryptoLead(cs, focus);

        // THE OWNER'S PRIVATE ALERT DESK. Comp seats only, decided here on the VERIFIED email —
        // the tickets are direct buy/sell instructions, and instructions never reach a
        // subscriber's grounding. For the comp reader they ride on every question, so the
        // analyst can raise one unprompted and "what are my alerts doing" lands without a tool
        // call. Slimmed to the fields a conversation needs; the tool has the rest.
        if (_isComp(email) && cs.alerts) {
          const slimO = (t) => ({ kind: t.kind, symbol: t.symbol, network: t.network,
            action: t.action, entry: t.entry, target_px: t.target_px, stop_px: t.stop_px,
            deadline: t.deadline, samples: t.samples });
          const slimR = (t) => ({ kind: t.kind, symbol: t.symbol, action: t.action,
            result: t.result, outcome: t.outcome, correct: t.correct });
          privateAlerts = {
            open: (cs.alerts.open || []).slice(0, 12).map(slimO),
            recent_resolved: (cs.alerts.recent || []).slice(0, 8).map(slimR),
            record: cs.alerts.record || null,
          };
        }
      }
    } catch (_) {}

    const reference = hits.map((h) =>
      `[${h.s === 'memory' ? "my own earlier read" : 'Journal'}] ${h.t}\n${String(h.x).slice(0, 900)}`).join('\n\n');

    // Earlier turns are context for INTENT ONLY. This is a live map: a number quoted at 10:00 is wrong by
  // 14:00, and a normal chatbot's habit of treating its own transcript as truth would have NoVo
  // confidently repeating an expired flip. The transcript resolves what "it" and "the other one" mean;
  // every figure still has to come from MARKET DATA below.
  const convo = history.length
    ? [
        'EARLIER IN THIS CONVERSATION (what the user is REFERRING TO, never a source of numbers;',
        'these figures are stale and MARKET DATA below overrides them without comment):',
        ...history.map((m) => (m.role === 'user' ? 'User: ' : 'You: ') + m.text),
        '', '',
      ].join('\n')
    : '';

  // The Analyst had no idea what day it was: it inferred 'today' from the freshest dated thing in
  // context, so on a Saturday it reported Friday's session date as today. NOW goes FIRST, ahead of
  // the transcript and the data, and names the session gap explicitly so the inference cannot recur.
  const lastSession = (() => {
    const t = live && (live.asof || live.ts || live.updated || null);
    if (typeof live?.date === 'string') return live.date.slice(0, 10);
    if (!t) return null;
    const ms = t < 1e12 ? t * 1000 : t;   // tolerate seconds or milliseconds
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    } catch (_) { return null; }
  })();

  // The depth block changes the CONTRACT of the answer, not the voice or the boundaries: a deep
  // read is a desk report, not a longer chat reply. It rides in the prompt rather than SYSTEM so
  // the fast lane's instructions stay byte-identical to what has been verified live.
  const depthBlock = deep
    ? ['THIS IS A DEEP READ. The reader asked for the full picture, so take the space the answer',
       'actually needs — a structured desk report, not a chat reply. Cover what the question touches',
       'and no more: the current structure with its levels, how today sits against your logged',
       'history and base rates (always with n), the vol regime with its percentiles, positioning',
       'where it matters, what would invalidate the read, and your own record on the claims you',
       'lean on. Use your tools freely — several lookups per round, both maps where relevant.',
       'Plain text still: short headed paragraphs separated by blank lines, "- " lists where they',
       'help. Every hard boundary still applies — no advice, no point predictions, no instructions.',
       '', ''].join('\n')
    : '';

  // Rides ONLY when the injection above actually happened, so the instruction and the data are
  // gated by the same server-side check and no public prompt ever names the feature.
  const privBlock = privateAlerts
    ? ['PRIVATE ALERT DESK — THIS READER IS THE OWNER (comp seat, verified server-side). The live',
       'tickets from my on-chain rule lab ride in MARKET DATA under private_alerts: open tickets,',
       'recent resolutions and the per-rule record. Discuss them freely with this reader — it is',
       'his own system. Raise a ticket unprompted when it bears on the question, quote its levels',
       'and deadline exactly, and fold the record into any analysis. For every other reader these',
       'tickets do not exist and are never mentioned.',
       '', ''].join('\n')
    : '';

  // Continuity, made explicit. Rides only when there is something remembered, and carries its
  // own rules so the fast lane's SYSTEM stays untouched.
  const memBlock = (readerMem && ((readerMem.interests || []).length || (readerMem.notes || []).length))
    ? ['WHAT YOU KNOW ABOUT THIS READER (they told you; market interests and style only):',
       (readerMem.interests || []).length ? 'Follows: ' + readerMem.interests.join(', ') : '',
       ...(readerMem.notes || []).map((n) => '- ' + n),
       'Use it to tailor the answer without announcing that you remember. When they state a NEW',
       'lasting preference, save it with update_reader_memory; "what do you know about me" is',
       'answered from this block, offering to correct or clear it. Never store or repeat anything',
       'position- or account-shaped.',
       '', ''].filter(Boolean).join('\n')
    : '';

  // THE DEEP LANE SEARCHES THE WEB FIRST. Search grounding and function tools cannot ride one
  // request, so a deep read runs a pre-round: one search-grounded call gathers current, cited
  // context, which the tool loop then treats as wire copy — claims to attribute, never numbers.
  let webBlock = '', webSources = [];
  if (deep) {
    try {
      const wj = await callModel(`${MODEL}:generateContent`, {
        contents: [{ role: 'user', parts: [{ text:
          'Search the web and summarize, in at most 200 words of plain factual prose, the current ' +
          'verifiable context relevant to this market question. Name each source inline. No advice, ' +
          'no predictions.\nQuestion: ' + question }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 900,
                            thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
      });
      const wparts = wj?.candidates?.[0]?.content?.parts || [];
      const wtext = wparts.filter((p) => p && p.text && !p.thought).map((p) => p.text).join('').trim();
      const gm = wj?.candidates?.[0]?.groundingMetadata;
      for (const c of (gm?.groundingChunks || [])) {
        if (c.web && c.web.uri) webSources.push({ title: c.web.title || c.web.uri, url: c.web.uri, kind: 'web' });
      }
      if (wtext) {
        webBlock = ['WEB CONTEXT (a search you just ran; treat as wire copy — attribute it, never',
                    'convert it into a number, and let MARKET DATA override it without comment):',
                    wtext, '', ''].join('\n');
      }
    } catch (_) { /* no web context — the deep read proceeds on the corpus alone */ }
  }

  const prompt =
      nowBlock(lastSession, surface) +
      surfaceBlock(surface, focus) +
      privBlock +
      depthBlock +
      webBlock +
      memBlock +
      convo +
      `MARKET DATA (every number you may state is here):\n${JSON.stringify({ live, history: ctx, crypto: cryptoInv, crypto_live: cryptoLead, private_alerts: privateAlerts })}\n\n` +
      `REFERENCE (explain mechanics from these; cite the titles you use):\n${reference}\n\n` +
      `QUESTION: ${question}`;

    // ── the tool loop ──────────────────────────────────────────────────────────────
    // The grounding above already answers most questions on its own. The loop exists for the ones
    // it cannot reach: a catalyst behind a move, an earnings date driving IV, how gamma built
    // through the session. The model chooses from a fixed, server-owned, read-only set; this runs
    // them and hands the results back as data. It still never executes anything and never computes
    // a number — the market/account line is enforced by what is absent from the tool list.
    const exec = makeExecutors({ index: idx, embed, search, email });
    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    const ledger = [];
    let answer = '';
    // What a question actually COSTS, so the caps above can be tuned against measurement instead of
    // my estimate. Model calls are the spend; tool calls are why there is more than one of them.
    let modelCalls = 0, toolCalls = 0;

    // Lane parameters, chosen once. The fast lane is byte-identical to what always ran.
    const rounds = deep ? DEEP.MAX_ROUNDS : MAX_ROUNDS;
    const callsCap = deep ? DEEP.MAX_CALLS_PER_ROUND : MAX_CALLS_PER_ROUND;
    const roundBudget = deep ? DEEP.ROUND_BUDGET_MS : ROUND_BUDGET_MS;

    let upstream = null;                 // why the model call died, if it did
    for (let round = 0; round < rounds; round++) {
      modelCalls++;
      let j;
      try {
        j = await callModel(`${MODEL}:generateContent`, {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents,
        tools: [{ functionDeclarations: declarations }],
        // The final round is forced to NONE so the loop always ends in prose. Left on AUTO, the
        // model can keep asking for one more lookup until the function is killed mid-chain, which
        // a subscriber sees as the analyst simply never answering.
        toolConfig: { functionCallingConfig: { mode: round < rounds - 1 ? 'AUTO' : 'NONE' } },
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: deep ? DEEP.MAX_OUTPUT_TOKENS : 1600,
          // This model thinks by default and the hidden reasoning bills against maxOutputTokens,
          // so on a tight budget the thinking eats the allowance and the visible answer comes back
          // as a truncated fragment. The engine's llm_client hit this and fixed it the same way:
          // control thinking explicitly rather than inheriting the model default. The deep lane
          // is the one place thinking is ON — bounded, and paid for in the output cap above.
          thinkingConfig: deep
            ? { thinkingBudget: DEEP.THINKING_BUDGET, includeThoughts: false }
            : { thinkingBudget: 0, includeThoughts: false },
        },
        });
      } catch (e) {
        upstream = e;
        // A failure on a LATER round still has whatever the model already said; a failure on the
        // first has nothing, and the difference matters to the person waiting. Either way, stop --
        // retrying into an upstream that just refused spends the subscriber's wait on nothing.
        break;
      }
      const parts = j?.candidates?.[0]?.content?.parts || [];
      const calls = parts.filter((p) => p && p.functionCall).slice(0, callsCap);
      toolCalls += calls.length;

      if (!calls.length) {
        // Join every text part and drop any the model marked as thought — reading parts[0] alone
        // returns a reasoning fragment ("Explain the mechanism: ...") whenever a thought leads.
        answer = parts.filter((p) => p && p.text && !p.thought).map((p) => p.text).join('').trim();
        break;
      }

      // The model turn has to be echoed back verbatim, function calls included, or the next
      // request carries responses to calls that are no longer in the transcript.
      contents.push({ role: 'model', parts });

      const started = Date.now();
      const responses = await Promise.all(calls.map(async (p) => {
        const name = p.functionCall.name;
        const args = p.functionCall.args || {};
        let out;
        if (typeof exec[name] !== 'function') {
          out = { error: `no such tool: ${name}` };
        } else {
          try {
            const left = Math.max(1200, roundBudget - (Date.now() - started));
            out = await Promise.race([
              exec[name](args),
              new Promise((r) => setTimeout(() => r({ error: `${name} timed out` }), left)),
            ]);
          } catch (e) { out = { error: `${name} failed` }; }
        }
        ledger.push({ tool: name, args, ok: !(out && out.error) });
        return { functionResponse: { name, response: (out && typeof out === 'object') ? out : { value: out } } };
      }));
      contents.push({ role: 'user', parts: responses });
    }

    if (!answer) {
      // Say which of the two it was. "no answer" described the symptom and hid the cause, so a
      // rate-limited model and a genuinely empty response looked identical on screen and identical
      // in the logs -- which is how this sat unnoticed.
      if (upstream) {
        const busy = upstream.status === 429 || upstream.status === 503;
        return res.status(502).json({
          error: busy
            ? 'I am rate limited right now — give it a moment and ask again.'
            : 'I could not reach my model just then. Ask again.',
        });
      }
      return res.status(502).json({ error: 'I came back with nothing there — ask me again.' });
    }
    console.log(`[ASK] ${deep ? 'deep' : 'fast'}: ${modelCalls} model call(s), ${toolCalls} tool call(s), ${question.length} chars in`);

    // Belt and braces: the panel renders text, not HTML, so any markdown the model still emits
    // would sit on screen as punctuation.
    const clean = answer
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(^|\n)\s*[*•]\s+/g, '$1- ')
      .replace(/(^|\n)#{1,6}\s*/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return res.status(200).json({
      ok: true,
      mode: deep ? 'deep' : 'fast',
      answer: clean,
      sources: [...hits.map((h) => ({ title: h.t, url: h.u || null, kind: h.s })),
                ...webSources.slice(0, 5)],
      // The ledger is what the analyst actually looked up to write this, failures included. It
      // is the difference between an answer you can check and an answer you have to trust.
      lookups: ledger.map((l) => ({ tool: l.tool, args: l.args, ok: l.ok })),
      indexBuilt: idx.built || null,
    });
  } catch (e) {
    console.error('[analyst-ask]', e);
    return res.status(500).json({ error: 'analyst unavailable' });
  }
};
