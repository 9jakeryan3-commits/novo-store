// Vertex AI on the NoVo service account — the store's only route to a model.
//
// The AI Studio key is gone: it leaked, and every product moved onto the service account
// instead. Nothing here should ever fall back to `generativelanguage.googleapis.com`, because
// there is no longer a key to fall back to — a "fallback" only turns a clear auth failure into
// a vague one.
//
// Signs its own JWT with node's crypto rather than pulling in google-auth-library, matching how
// the CRMs do it. The token caches in module scope for its hour, so a warm lambda skips the
// round trip entirely.
//
// LOCATION: only `global` publishes the current flash models. If a 404 shows up here, do NOT
// "fix" it by pinning a region — that is backwards.

const crypto = require('crypto');

const LOCATION = (process.env.VERTEX_LOCATION || 'global').trim();

let _tok = null;
let _tokExp = 0;

async function accessToken() {
  if (_tok && Date.now() < _tokExp - 60000) return _tok;
  const raw = process.env.GOOGLE_VERTEX_SA_JSON;
  if (!raw) return null;
  const sa = JSON.parse(raw);
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
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) {
    console.error('[vertex] token exchange failed', r.status, JSON.stringify(j).slice(0, 200));
    return null;
  }
  _tok = j.access_token;
  _tokExp = Date.now() + 3500 * 1000;
  return _tok;
}

/** POST to a Vertex model. `path` is e.g. `gemini-3.6-flash:generateContent`. */
async function vertex(path, body, tag = 'vertex') {
  const raw = process.env.GOOGLE_VERTEX_SA_JSON;
  if (!raw) { console.error(`[${tag}] GOOGLE_VERTEX_SA_JSON not set`); return null; }
  const sa = JSON.parse(raw);
  const tok = await accessToken();
  if (!tok || !sa.project_id) return null;
  const host = LOCATION === 'global' ? 'aiplatform.googleapis.com' : `${LOCATION}-aiplatform.googleapis.com`;
  const r = await fetch(
    `https://${host}/v1/projects/${sa.project_id}/locations/${LOCATION}/publishers/google/models/${path}`,
    { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { console.error(`[${tag}] vertex`, r.status, (await r.text()).slice(0, 300)); return null; }
  return r.json();
}

/** The visible answer. Joins every text part and drops any the model marked as a thought —
 *  reading parts[0] returns the model's own reasoning whenever a thought leads. */
function answerText(j) {
  return (j?.candidates?.[0]?.content?.parts || [])
    .filter((p) => p && p.text && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

/** Generation config with thinking OFF.
 *  These models think by default and bill the hidden reasoning against maxOutputTokens, so on a
 *  tight budget the thinking eats the allowance and the visible answer is truncated to a
 *  fragment. Every call site sets this explicitly rather than inheriting the model default. */
function genConfig(extra = {}) {
  return {
    thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
    ...extra,
  };
}

module.exports = { vertex, accessToken, answerText, genConfig, LOCATION };
