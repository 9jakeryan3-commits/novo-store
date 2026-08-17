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

const { kv } = require('./_kv.js');
const zlib = require('zlib');
const crypto = require('crypto');

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

const SYSTEM = `You are NoVo, a market analyst. You read dealer positioning on SPY, QQQ and IWM for traders who work intraday, mostly 0DTE.

WHAT YOU ARE NOT
You are not a portfolio assistant. You never discuss anyone's trades, positions, entries, exits or P&L — not the reader's and not the owner's — and you never tell anyone to buy or sell anything. If asked, say plainly that you read the market, not accounts, and answer the market question underneath if there is one.

HOW YOU ANSWER
- Ground every figure in MARKET DATA. If a number is not there, say you do not have it. Never estimate a level, never invent a statistic.
- When you lean on the logged history, say how many sessions it covers. A few dozen sessions is a count, not "usually".
- Use REFERENCE to explain mechanics, and cite the source titles you actually used.
- Separate what is on the map right now from what tends to be written about setups like it.
- Plain English, a desk note not an essay. No "as an AI".
- PLAIN TEXT ONLY. The panel renders exactly what you write, so markdown does not format — it
  shows up as literal asterisks. No **bold**, no *, no #, no tables. Short paragraphs separated
  by a blank line; if you must list, start the line with "- ".
- Answer the question directly. Never restate the task or narrate your approach.
- Vol index by ticker: VIX is SPY, VXN is QQQ, RVX is IWM. Never call VXN "VIX".`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const email = verifyToken((req.body && req.body.t) || (req.query && req.query.t));
  if (!email) return res.status(401).json({ error: 'sign in on the dashboard to ask NoVo' });

  const question = String((req.body && req.body.question) || '').trim().slice(0, 600);
  if (!question) return res.status(400).json({ error: 'no question' });

  try {
    const idx = await loadIndex();
    if (!idx) return res.status(503).json({ error: 'the analyst index has not been published yet' });

    const qv = await embed(question);
    if (!qv) return res.status(502).json({ error: 'could not embed the question' });
    const hits = search(idx, qv, 6);

    const r = kv();
    let live = null, ctx = null;
    try {
      const [l, c] = await Promise.all([r.get('public:levels'), r.get('analyst:context')]);
      live = typeof l === 'string' ? JSON.parse(l) : l;
      ctx = typeof c === 'string' ? JSON.parse(c) : c;
    } catch (_) {}

    const reference = hits.map((h) =>
      `[${h.s === 'memory' ? "NoVo's own read" : 'Journal'}] ${h.t}\n${String(h.x).slice(0, 900)}`).join('\n\n');

    const prompt =
      `MARKET DATA (every number you may state is here):\n${JSON.stringify({ live, history: ctx })}\n\n` +
      `REFERENCE (explain mechanics from these; cite the titles you use):\n${reference}\n\n` +
      `QUESTION: ${question}`;

    const j = await callModel(`${MODEL}:generateContent`, {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
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
    // Join every text part and drop any the model marked as thought — reading parts[0] alone
    // returns a reasoning fragment ("Explain the mechanism: ...") whenever a thought leads.
    const answer = (j?.candidates?.[0]?.content?.parts || [])
      .filter((p) => p && p.text && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    if (!answer) return res.status(502).json({ error: 'no answer' });

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
      indexBuilt: idx.built || null,
    });
  } catch (e) {
    console.error('[analyst-ask]', e);
    return res.status(500).json({ error: 'analyst unavailable' });
  }
};
