// api/_lib/vertex.js — the Vertex client, in exactly one place.
//
// WHY THIS FILE EXISTS. The MCP server needed to call the model for ask_novo, and the only
// existing client lived inside analyst-ask.js. Hand-copying it would have been the FOURTH
// instance of the mirrored-twin class on this codebase in one week (MIN_EFFECT_R across repos,
// _subGrantsAnalyst, the forecast validator) — and the twin that holds SERVICE-ACCOUNT AUTH is
// the worst candidate of all: a token-cache or scope fix applied to one copy and not the other
// fails in a way that looks like a credential problem rather than a duplication problem.
// One client, two callers, no copies.
//
// Scope note: the STREAMING lane stays in analyst-ask. It is coupled to that handler's SSE
// plumbing and has exactly one caller, so extracting it would move code without removing a twin.

let _tok = null, _tokExp = 0;

const LOCATION = (process.env.VERTEX_LOCATION || 'global').trim();
const MODEL = (process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim();

/** A cached Vertex access token minted from the service account JWT. Null if unconfigured. */
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

/** One non-streaming Vertex call. `path` is like `${MODEL}:generateContent`. Throws with .status. */
async function vertex(path, body) {
  const sa = JSON.parse(process.env.GOOGLE_VERTEX_SA_JSON || '{}');
  const tok = await accessToken();
  if (!tok || !sa.project_id) { const e = new Error('vertex auth'); e.status = 500; throw e; }
  const host = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
  const r = await fetch(
    `https://${host}/v1/projects/${sa.project_id}/locations/${LOCATION}/publishers/google/models/${path}`,
    { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(body) });
  if (!r.ok) {
    const e = new Error('vertex ' + r.status); e.status = r.status;
    e.body = (await r.text()).slice(0, 300); throw e;
  }
  return r.json();
}

/** The text of a non-streaming response, thoughts stripped. '' when the model returned nothing. */
function textOf(j) {
  const parts = j?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => p && p.text && !p.thought).map((p) => p.text).join('').trim();
}

module.exports = { accessToken, vertex, textOf, MODEL, LOCATION };
