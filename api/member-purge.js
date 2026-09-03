// api/member-purge.js — erase everything KV holds about one member.
//
// WHY IT EXISTS. control-plane's /account/delete tears down the Railway instance, the encrypted
// broker keys, the mailing-list memberships and every SQL row keyed to the user — and then stops,
// because the rest of that member lives in novo-store's Upstash and the control plane (Python, on
// Railway) has no route to it. So "permanent account deletion" left the reader's memory, their
// push devices, their alerts, their cached entitlements and their EMAIL ADDRESS behind.
//
// This is the missing hop: one endpoint, one secret, one caller.
//
// ⚠ THE HARD PART IS NOT THE DELETE, IT IS THE KEYS. There are THREE different derivations in
// this codebase and using the wrong one deletes nothing while reporting success — which is the
// exact failure shape that bit this project repeatedly today:
//
//     eh    = sha256(lower(trim(email)))[:16]   mem:u: mem:e: seen:u: push:u:
//                                               alerts:u: alerts:e: alerts:d: upsell:ac:
//                                               and the MEMBERS of mem:index / alerts:index
//     h24   = sha256(lower(trim(email)))[:24]   ent:analyst: ent:crypto: ent:trader: ent:both:
//     raw   = the email itself, UNNORMALISED    analyst_trialed:  ask:<email>:*
//
// The raw-email family is the nasty one: webhook-sub.js writes `analyst_trialed:` + email with
// whatever casing the Stripe event carried, so this deletes the as-given, the lowercased and the
// trimmed-lowercased forms rather than assuming one.
//
// ⚠ AND TWO KEYS HOLD THE PLAINTEXT EMAIL, not a hash: mem:e: and alerts:e: are the reverse
// lookups the digest and alert fan-outs need. A purge that cleared only the hashed keys would
// leave the actual identifying data sitting in KV, which is the one thing deletion is FOR.
//
// It reports what it actually removed, per key. "Purged" with a count of zero and "purged" with a
// count of nine must not print the same, or this becomes another green light over an empty room.

const crypto = require('crypto');
const { kv } = require('./_kv.js');

const eh = (email) =>
  crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 16);
const h24 = (email) =>
  crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 24);

function timingSafeEq(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || !x.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // FAIL CLOSED, and loudly. An unset secret returns 503 rather than 200-with-nothing-done: a
  // deletion endpoint that quietly does nothing is worse than one that is plainly switched off,
  // because the caller reports success to a user who asked to be forgotten.
  const secret = process.env.MEMBER_PURGE_SECRET;
  if (!secret) {
    console.error('[member-purge] refused: MEMBER_PURGE_SECRET is not set');
    return res.status(503).json({ error: 'purge endpoint not configured' });
  }
  if (!timingSafeEq(req.headers['x-purge-secret'], secret)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch (_) { return res.status(400).json({ error: 'malformed body' }); }

  const given = String(body.email || '');
  const norm = given.trim().toLowerCase();
  if (!norm || norm.indexOf('@') < 0) return res.status(400).json({ error: 'email required' });

  const r = kv();
  if (!r) {
    // Never a silent success. If KV is unreachable the member's records still exist.
    console.error('[member-purge] refused: KV unavailable');
    return res.status(503).json({ error: 'store unavailable' });
  }

  const H = eh(norm), H24 = h24(norm);
  const keys = [
    'mem:u:' + H,            // reader memory: interests, level preference, notes
    'mem:e:' + H,            // ⚠ PLAINTEXT EMAIL (digest reverse lookup)
    'seen:u:' + H,           // last-seen dealer levels, for "what changed since you were here"
    'push:u:' + H,           // registered push devices
    'alerts:u:' + H,         // the member's alerts
    'alerts:e:' + H,         // ⚠ PLAINTEXT EMAIL (alert fan-out reverse lookup)
    'alerts:d:' + H,         // alert dedup state
    'upsell:ac:' + H,        // bundle-pitch cooldown
    'ent:analyst:' + H24, 'ent:crypto:' + H24, 'ent:trader:' + H24, 'ent:both:' + H24,
  ];
  // Raw-email keys, in every casing they could have been written under. Cheap to over-delete;
  // expensive to guess wrong and leave one behind.
  for (const form of [...new Set([given, given.trim(), norm])].filter(Boolean)) {
    keys.push('analyst_trialed:' + form);
    keys.push('ask:' + form + ':h', 'ask:' + form + ':d', 'ask:' + form + ':deep:h');
  }

  const deleted = [];
  const failed = [];
  for (const k of keys) {
    try {
      const n = await r.del(k);
      if (n) deleted.push(k.replace(/:[0-9a-f]{16,24}$/, ':<hash>').replace(/:[^:]*@[^:]*/, ':<email>'));
    } catch (e) { failed.push(k.split(':')[0]); }
  }
  // The two index SETS hold the hash as a MEMBER — del would drop everyone's, srem drops one.
  for (const set of ['mem:index', 'alerts:index']) {
    try { const n = await r.srem(set, H); if (n) deleted.push(set + ' (member removed)'); }
    catch (e) { failed.push(set); }
  }

  // Deliberately logs the COUNT and the key shapes, never the address: this endpoint exists to
  // erase an identity, so writing it into a log would defeat the point of calling it.
  console.log('[member-purge] removed %d record(s)%s', deleted.length,
              failed.length ? ' (' + failed.length + ' failed)' : '');

  return res.status(200).json({
    ok: failed.length === 0,
    purged: deleted.length,
    keys: deleted,            // shapes only, hashes and addresses masked
    failed: failed.length ? failed : undefined,
    // Zero is a legitimate answer — a member who never set interests, registered a device or hit
    // a paid gate has nothing here. Returned explicitly so the caller can tell "nothing to do"
    // from "did nothing".
    note: deleted.length ? undefined : 'no records existed for this member',
  });
};
