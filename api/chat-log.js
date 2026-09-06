// api/chat-log.js — the conversation follows the MEMBER, not the browser.
//
// THE FLAW THIS FIXES (Jake, 2026-09-06): the transcript lived in localStorage, so it was scoped to
// one browser on one device. A member who asked something on their desktop opened the same chat on
// their phone and found it empty. The product reads as "one analyst, one desk" — right up until you
// pick up your phone, and then it is two strangers who have never met.
//
// ── WHAT SHARES A TRANSCRIPT, AND WHAT DELIBERATELY DOES NOT ──────────────────────────────────
// SCOPE is the unit, not the page. Analyst and Trader share `equity`, because a subscriber does not
// experience them as two products — a Trader subscriber always had this chat, they simply had to
// open the Analyst dashboard to reach it, and now they do not. Crypto keeps its own scope, which is
// what its author chose when they gave it a separate storage key, and it is the right call: the
// crypto map is a different desk with a different asset class.
//
// ── STORAGE, following api/_lib/member-memory.js rather than inventing a second convention ────
// One small KV value per member per scope, keyed by an EMAIL HASH — the email itself never becomes
// a key. Same helper (`eh`), same shape, same reasoning.
//
// ── WHAT IS NOT SYNCED, AND WHY IT IS NOT AN OVERSIGHT ────────────────────────────────────────
// IMAGE THUMBNAILS. A turn can carry a data-URI thumbnail of a chart the member uploaded. Those run
// to tens of kilobytes each and 40 of them would be megabytes in a value that is read and written
// on every turn. They stay on the device that produced them, so a question asked with a screenshot
// on desktop reads as the question alone on the phone. That is a real, visible limit and it is
// stated rather than discovered.
//
// ── MERGE, NOT LAST-WRITE-WINS ────────────────────────────────────────────────────────────────
// Two devices open at once is normal, not an edge case. Last-write-wins silently deletes whichever
// side was slower, and the member has no way to know a turn is gone. Turns carry their own
// timestamp, so the server keeps the UNION, ordered, deduped. A merge cannot lose a turn; it can
// only ever show one you already had.

const crypto = require('crypto');
const { kv } = require('./_kv.js');
const { eh } = require('./_lib/member-memory.js');

const TTL_S = 30 * 24 * 3600;      // a month of silence and the transcript ages out
const MAX_TURNS = 60;              // above the client's own 40, so a merge of two devices has room
const MAX_TEXT = 8000;             // one turn; long deep-reads are real, runaway ones are not
const MAX_BYTES = 200 * 1024;      // the whole stored value

const SCOPES = new Set(['equity', 'crypto']);

// Same verifier the chat endpoint uses. Reads only the email and the expiry — see the note in
// api/analyst-ask.js; the `p` (plan) claim the trader ticket stamps is deliberately not consulted,
// because a Trader subscription has always included this chat.
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

const keyFor = (email, scope) => 'chat:u:' + eh(email) + ':' + scope;

/* One turn, sanitised. `r` is 'you' or 'novo', `x` the text, `t` the timestamp it was created at.
   Anything else a client sends is dropped rather than stored — including `img`, deliberately. */
function clean(turn) {
  if (!turn || typeof turn !== 'object') return null;
  const r = turn.r === 'you' ? 'you' : 'novo';
  const x = String(turn.x == null ? '' : turn.x).slice(0, MAX_TEXT);
  const t = Number(turn.t);
  if (!x || !Number.isFinite(t) || t <= 0) return null;
  return { r, x, t };
}

/* THE MERGE. Union by (timestamp, role, text) so a replayed turn cannot duplicate itself, ordered
   oldest-first, then the newest MAX_TURNS kept. Dropping from the FRONT rather than the back is
   what makes the cap safe: the most recent conversation is the one worth having on the other
   device. */
function merge(a, b) {
  const out = new Map();
  for (const list of [a || [], b || []]) {
    for (const raw of list) {
      const c = clean(raw);
      if (!c) continue;
      out.set(c.t + '|' + c.r + '|' + c.x.slice(0, 120), c);
    }
  }
  return [...out.values()].sort((x, y) => x.t - y.t).slice(-MAX_TURNS);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const body = (req.method === 'POST' && req.body) ? req.body : {};
  const email = verifyToken(body.t || (req.query && req.query.t));
  if (!email) return res.status(401).json({ error: 'sign in on the dashboard' });

  const scope = String((body.scope || (req.query && req.query.scope) || 'equity')).toLowerCase();
  if (!SCOPES.has(scope)) return res.status(400).json({ error: 'unknown scope' });

  const r = kv();
  // Degrade to "no server copy", never to an error: the chat still works entirely from
  // localStorage, exactly as it did before this endpoint existed. An outage here must cost
  // continuity across devices, never the conversation in front of the member.
  if (!r) return res.status(200).json({ ok: true, turns: [], synced: false, note: 'store unavailable' });

  const key = keyFor(email, scope);

  if (req.method === 'GET') {
    let stored = null;
    try {
      const raw = await r.get(key);
      stored = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) { stored = null; }
    return res.status(200).json({ ok: true, synced: true,
      turns: (stored && Array.isArray(stored.turns)) ? stored.turns : [],
      at: (stored && stored.at) || null });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

  const incoming = Array.isArray(body.turns) ? body.turns.slice(0, MAX_TURNS * 2) : [];
  let stored = null;
  try {
    const raw = await r.get(key);
    stored = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) { stored = null; }

  const turns = merge(stored && stored.turns, incoming);
  const value = JSON.stringify({ turns, at: Date.now() });

  // A transcript that outgrew the cap is trimmed from the front and SAID SO, rather than failing
  // the write and silently losing the whole sync.
  let trimmed = turns;
  if (Buffer.byteLength(value) > MAX_BYTES) {
    trimmed = turns.slice(-Math.floor(MAX_TURNS / 2));
  }
  const finalValue = JSON.stringify({ turns: trimmed, at: Date.now() });
  try { await r.set(key, finalValue, { ex: TTL_S }); } catch (_) {
    return res.status(200).json({ ok: true, synced: false, turns: turns, note: 'write failed' });
  }

  return res.status(200).json({ ok: true, synced: true, turns: trimmed,
    dropped_for_size: trimmed.length !== turns.length ? turns.length - trimmed.length : 0 });
};
