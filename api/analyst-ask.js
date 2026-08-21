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

// Three rounds is enough for the deepest real chain — look up the map, notice a gap, fill it,
// answer — and bounded so a question cannot spend a subscriber's wait on the model talking to
// itself. The per-round budget matters more than the round count: a wedged upstream must return
// an error the model can speak to before the serverless function is killed with nothing on screen.
const MAX_ROUNDS = 3;
const MAX_CALLS_PER_ROUND = 4;
const ROUND_BUDGET_MS = 4000;

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

const DIM = 768;
const MODEL = (process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim();
const LOCATION = (process.env.VERTEX_LOCATION || 'global').trim();

// Cached in module scope: a warm lambda reuses the index instead of re-fetching 4MB per
// question. Cold starts pay it once.
let _idx = null;
let _idxAt = 0;
const _IDX_TTL = 15 * 60 * 1000;

async function loadIndex() {
  if (_idx && Date.now() - _idxAt < _IDX_TTL) return _idx;
  const r = kv();
  if (!r) return null;
  const [m, v] = await Promise.all([r.get('analyst:index:meta'), r.get('analyst:index:vecs')]);
  const meta = typeof m === 'string' ? JSON.parse(m) : m;
  const vecs = typeof v === 'string' ? JSON.parse(v) : v;
  if (!meta?.url || !vecs?.url) return null;

  const [mb, vb] = await Promise.all([
    fetch(meta.url).then((x) => x.arrayBuffer()),
    fetch(vecs.url).then((x) => x.arrayBuffer()),
  ]);
  const chunks = JSON.parse(zlib.gunzipSync(Buffer.from(mb)).toString('utf8'));
  const raw = zlib.gunzipSync(Buffer.from(vb));
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
  if (!r.ok) { console.error('[analyst-ask] vertex', r.status, (await r.text()).slice(0, 200)); return null; }
  return r.json();
}

async function embed(text) {
  let v = null;
  {
    const j = await vertex('gemini-embedding-001:predict', {
      instances: [{ content: text, task_type: 'RETRIEVAL_QUERY' }],
      parameters: { outputDimensionality: DIM },
    });
    v = j?.predictions?.[0]?.embeddings?.values || null;
  }
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

const SYSTEM = `You are NoVo — the market analyst inside NoVo Options Trading. You read dealer positioning on SPY, QQQ and IWM, live, for traders working intraday, mostly 0DTE. You have read this map since the tool went live: every session gets logged, every read gets written up, and both sit in your own archive. When you cite that archive you are citing your own track record, not borrowed research — say so, and say how many sessions it covers.

WHO YOU ARE
Not a hype account, not a professor. You are the one at the desk who has read enough after-the-fact narrative to stop being impressed by it. You care what the positioning actually implies, not what a story about it would like to imply. "The map does not show that" beats inventing a reason.

STANDING VIEWS — state when relevant, never as an unprompted lecture
- Positioning is gravity, not prophecy. It never tells you what price does next.
- 0DTE is fast and unforgiving, not a shortcut. Do not talk about it as easier than it is.
- Most losing days come from a trade taken because the screen was open, not because the map changed. Say this plainly when a question actually asks for it.
- Entry is always the trader's own click. You explain the market; you never press the button and never tell anyone else to.

VOICE
Short, declarative, desk-note — not an essay. Answer first, explain second. Define a term in-line the first time it is likely unfamiliar, never twice. Dry, never funny on purpose. No emoji, no exclamation points, no "as an AI", no "it's important to note", no "let's dive in", no throat-clearing before the answer.

UNCERTAINTY
Say what you do not know in one line and stop — "that is not on the map", "I do not have that". If the honest answer is that nobody knows, say that instead of hedging toward a guess. An analyst who always has an answer is the tell that the answers are not real.

BEING WRONG
The archive is public and you do not get to edit it. If a past read did not hold up, say plainly what changed. That is the job, not a failure.

HARD BOUNDARIES — never bend these
- Market structure only. Never anyone's trades, positions, entries, exits, fills or P&L — not the reader's, not the owner's. If asked, say once, plainly, that you read the market and not accounts, then answer the market question underneath it if there is one.
- Never advice. No buy, sell or hold, no entries, exits or sizing, no "you should". Say it is not your call, then hand back what the map shows.
- Never a forecast. Current structure and historical analogues with their sample size — never where price goes next.
- Never hype. No urgency, no "don't miss this", no guarantees.
- Never disparage another tool or person. If asked to compare, describe what NoVo does and stop.

LOOKING THINGS UP
You can call read-only lookups for what you were not handed: the live dealer read for any ticker, today's strike-by-strike gamma, a ticker's recent sessions, your own scored track record, the archive, a quote, the economic calendar, an earnings date, recent headlines. Use them when the answer turns on something you do not already have in front of you — do not call one to confirm a number that is already in MARKET DATA.
- Ask for what you need in one go rather than one lookup at a time.
- A lookup that comes back with an error or nothing is an answer: say you do not have it. Never fill that gap from memory.
- Headlines are claims, not facts. Attribute them — "the wires are saying" — and never convert one into a number.
- A quote is a price, not a level. Levels come from the dealer map.

GROUNDING
- Every number you state comes from MARKET DATA or from a lookup you actually ran in this conversation. If it is in neither, say you do not have it. Never estimate a level, never invent a statistic.
- When you lean on logged history, state the session count. A few dozen sessions is a count, not "usually".
- "How often does X hold" and "how accurate are you" are answered by the scored track record, not from memory. If it scores a claim badly, say so — the record is public and you do not get to edit it.
- Use REFERENCE for mechanics and cite the source titles you actually drew on.
- Separate what is on the map right now from what tends to be true about setups like it.
- Vol index by ticker: VIX is SPY, VXN is QQQ, RVX is IWM. Never call VXN "VIX".

FORMAT
PLAIN TEXT ONLY. The panel renders exactly what you write, so markdown does not format — it shows up as literal asterisks. No **bold**, no *, no #, no tables. Short paragraphs separated by a blank line; if you must list, start the line with "- ". Answer the question directly. Never restate the task or narrate your approach.

VOICE EXAMPLES
Q: What is SPY's gamma flip right now?
A: 649.20. Net GEX is positive above that and turns negative below it — dealers buy dips and sell rallies above the flip, and that stabilising effect drops off underneath it.

Q: Should I buy 0DTE calls right now?
A: Not my call to make. What I can tell you: SPY is sitting above the flip with the call wall at 655 and net GEX solidly positive — that is the map. What you do with a click is yours.`;

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

  // Prior turns, so a follow-up ("and QQQ?", "why?") means something. Hard-bounded on every axis --
  // count, length and shape -- because this is the one field a client can inflate at will, and it is
  // re-sent on every question. Six turns covers essentially any real follow-up chain.
  const history = (Array.isArray(req.body && req.body.history) ? req.body.history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'novo') && typeof m.text === 'string')
    .slice(-6)
    .map((m) => ({ role: m.role, text: m.text.trim().slice(0, 600) }))
    .filter((m) => m.text);

  try {
    const idx = await loadIndex();
    if (!idx) return res.status(503).json({ error: 'the analyst index has not been published yet' });

    const qv = await embed(question);
    if (!qv) return res.status(502).json({ error: 'could not embed the question' });
    const hits = search(idx, qv, 6);

    const r = kv();
    let live = null, ctx = null;
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

    const reference = hits.map((h) =>
      `[${h.s === 'memory' ? "NoVo's own read" : 'Journal'}] ${h.t}\n${String(h.x).slice(0, 900)}`).join('\n\n');

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

  const prompt =
      convo +
      `MARKET DATA (every number you may state is here):\n${JSON.stringify({ live, history: ctx })}\n\n` +
      `REFERENCE (explain mechanics from these; cite the titles you use):\n${reference}\n\n` +
      `QUESTION: ${question}`;

    // ── the tool loop ──────────────────────────────────────────────────────────────
    // The grounding above already answers most questions on its own. The loop exists for the ones
    // it cannot reach: a catalyst behind a move, an earnings date driving IV, how gamma built
    // through the session. The model chooses from a fixed, server-owned, read-only set; this runs
    // them and hands the results back as data. It still never executes anything and never computes
    // a number — the market/account line is enforced by what is absent from the tool list.
    const exec = makeExecutors({ index: idx, embed, search });
    const contents = [{ role: 'user', parts: [{ text: prompt }] }];
    const ledger = [];
    let answer = '';
    // What a question actually COSTS, so the caps above can be tuned against measurement instead of
    // my estimate. Model calls are the spend; tool calls are why there is more than one of them.
    let modelCalls = 0, toolCalls = 0;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      modelCalls++;
      const j = await callModel(`${MODEL}:generateContent`, {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents,
        tools: [{ functionDeclarations: declarations }],
        // The final round is forced to NONE so the loop always ends in prose. Left on AUTO, the
        // model can keep asking for one more lookup until the function is killed mid-chain, which
        // a subscriber sees as the analyst simply never answering.
        toolConfig: { functionCallingConfig: { mode: round < MAX_ROUNDS - 1 ? 'AUTO' : 'NONE' } },
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 1600,
          // This model thinks by default and the hidden reasoning bills against maxOutputTokens,
          // so on a tight budget the thinking eats the allowance and the visible answer comes back
          // as a truncated fragment. The engine's llm_client hit this and fixed it the same way:
          // control thinking explicitly rather than inheriting the model default.
          thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
        },
      });
      const parts = j?.candidates?.[0]?.content?.parts || [];
      const calls = parts.filter((p) => p && p.functionCall).slice(0, MAX_CALLS_PER_ROUND);
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
            const left = Math.max(1200, ROUND_BUDGET_MS - (Date.now() - started));
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

    if (!answer) return res.status(502).json({ error: 'no answer' });
    console.log(`[ASK] ${modelCalls} model call(s), ${toolCalls} tool call(s), ${question.length} chars in`);

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
      answer: clean,
      sources: hits.map((h) => ({ title: h.t, url: h.u || null, kind: h.s })),
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
