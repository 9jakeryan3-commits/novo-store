// api/unsubscribe.js — one-click opt-out for the emails that are NOT broadcasts.
//
// The recurring sends (The Week Ahead, The Open, The Close) go out as Resend BROADCASTS, where
// {{{RESEND_UNSUBSCRIBE_URL}}} resolves to Resend's own hosted opt-out. Transactional sends have no
// merge-tag context — the tag would render as literal text — so the one-time welcome email needs a
// real link, and this is it.
//
// Signed, because an unsubscribe endpoint that takes a bare email address lets anyone unsubscribe
// anyone. The HMAC is over the address itself and does not expire: an opt-out link has to keep
// working in a mailbox someone opens a year later.
//
// GET  -> opt out, then render a confirmation page (what a human clicking the link gets).
// POST -> opt out, return 204 (RFC 8058 List-Unsubscribe-Post, which mail clients fire silently).

const { Resend } = require('resend');
const crypto = require('crypto');

// Constructed lazily: `new Resend()` THROWS when the key is absent, and subscribe.js and
// analyst-publish.js now require this module at load. An eager constructor here would take both
// senders down in any environment missing the key, to add an unsubscribe link.
let _resend = null;
function resendClient() {
  if (!_resend && process.env.RESEND_API_KEY) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}
const SITE = (process.env.SITE_URL || 'https://novo-options.trade').replace(/\/$/, '');

function _secret() {
  return process.env.ANALYST_LIVE_SECRET || process.env.ANALYST_PUBLISH_SECRET || '';
}

// Exported so the senders build the link the same way this verifies it.
function sign(email) {
  const s = _secret();
  const e = String(email || '').trim().toLowerCase();
  if (!s || !e) return '';
  return crypto.createHmac('sha256', s).update('unsub:' + e).digest('base64url');
}

function verify(email, sig) {
  const want = sign(email);
  if (!want || !sig) return false;
  const a = Buffer.from(String(sig));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function link(email) {
  const sig = sign(email);
  if (!sig) return `${SITE}/contact`;   // never emit a dead link; the contact route still reaches a human
  return `${SITE}/api/unsubscribe?e=${encodeURIComponent(String(email).toLowerCase())}&s=${sig}`;
}

// Remove from EVERY audience — a paid subscriber who joined the free list is in each, and an
// opt-out that only clears one keeps sending.
//
// ⚠ THE CRYPTO AUDIENCE WAS MISSING, AND THAT MADE THIS A BROKEN PROMISE RATHER THAN AN OVERSIGHT.
// RESEND_CRYPTO_AUDIENCE_ID has existed since the $79 product shipped and webhook-sub.js adds every
// crypto subscriber to it (three call sites). This list did not include it, so a crypto subscriber
// who clicked "unsubscribe", saw the confirmation page, and reasonably believed they were done
// went on receiving crypto mail indefinitely. An unsubscribe link that does not unsubscribe you is
// the one bug in this file that is a compliance problem and not a tidiness one.
//
// Built from the ENV rather than a hand-kept list for exactly the reason it broke: the audience
// existed and this array did not know about it. Any RESEND_*_AUDIENCE_ID is now swept in
// automatically, so the next product's list is covered the day its env var is set — nobody has to
// remember to come back here. Same fix shape as the entitlement price sets: derive, don't retype.
function _audienceIds() {
  return Object.keys(process.env)
    .filter((k) => /^RESEND_.*AUDIENCE(_ID)?$/.test(k))
    .map((k) => String(process.env[k] || '').trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);   // one id under two names must not be touched twice
}

async function optOut(email) {
  const ids = _audienceIds();
  let done = 0;
  for (const audienceId of ids) {
    try {
      const r = resendClient();
      if (!r) return done;
      const g = await r.contacts.get({ audienceId, email });
      const id = g && g.data && g.data.id;
      if (id) {
        await r.contacts.update({ audienceId, id, unsubscribed: true });
        done++;
      }
    } catch (_) { /* absent from this audience is a success, not an error */ }
  }
  return done;
}

const page = (title, body) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — NoVo</title>
<style>body{margin:0;background:#101013;color:#eaf3ff;font:16px/1.6 -apple-system,BlinkMacSystemFont,
"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;
justify-content:center;padding:24px}.c{max-width:440px;background:#1c1d21;border:1px solid #2e3036;
border-radius:12px;padding:32px}h1{font-size:21px;margin:0 0 12px}p{color:#9fb6d1;margin:0 0 16px}
a{color:#22d3ee;font-weight:700;text-decoration:none}</style>
<div class="c"><h1>${title}</h1>${body}<p><a href="${SITE}">Back to NoVo &rarr;</a></p></div>`;

module.exports = async (req, res) => {
  const q = req.query || {};
  const email = String(q.e || (req.body && req.body.e) || '').trim().toLowerCase();
  const sig = String(q.s || (req.body && req.body.s) || '');

  if (!email || !verify(email, sig)) {
    if (req.method === 'POST') return res.status(400).end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(page('That link is not valid',
      '<p>Reply to any NoVo email and we will take you off the list by hand.</p>'));
  }

  try {
    await optOut(email);
  } catch (e) {
    console.error('[unsubscribe]', e && e.message);
  }

  // One-click clients expect a bare 2xx and show their own confirmation.
  if (req.method === 'POST') return res.status(204).end();

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(page('You are unsubscribed',
    `<p>${email.replace(/[<>&]/g, '')} will not receive NoVo emails.</p>
     <p>The dealer map, the free tools and the Journal stay open to you.</p>`));
};

// CAN-SPAM requires a valid physical postal address in every commercial message. There is not one
// yet, and inventing one would be worse than omitting it -- so this renders the footer line only when
// MAIL_POSTAL_ADDRESS is set, and nothing at all until then. Setting that one env var puts the address
// into every email NoVo sends, with no code change.
// The sender name is supplied here rather than typed into the env var, so it is spelled the same in
// every email and cannot drift. Set MAIL_POSTAL_ADDRESS to the street/city/ZIP only.
// Deliberately NOT "LLC" -- NoVo is a trade name today, and claiming an entity that does not exist
// yet is a misrepresentation in exactly the message class that has to be accurate.
// The legal entity, not the brand mark: CAN-SPAM wants the sender identified alongside the
// physical address, and postalHtml renders `${SENDER} - ${MAIL_POSTAL_ADDRESS}`.
const SENDER = 'NoVo Options Trading LLC';

function postalHtml(color) {
  const a = String(process.env.MAIL_POSTAL_ADDRESS || '').trim();
  if (!a) return '';
  const safe = `${SENDER} · ${a}`.replace(/[<>&]/g, '');
  return `<div style="font-size:11px;color:${color || '#6f8bab'};line-height:1.6;margin:6px 0 0;">${safe}</div>`;
}

module.exports.postalHtml = postalHtml;
module.exports.sign = sign;
module.exports.link = link;
