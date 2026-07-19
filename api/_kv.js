// api/_kv.js — shared Upstash Redis (KV) client for the serverless API.
//
// Used for two cross-instance concerns the per-instance in-memory Maps could never do correctly on Vercel
// (every lambda has its own memory): Stripe webhook idempotency (exactly-once side effects across retries)
// and distributed rate limiting (abuse control that actually aggregates across instances).
//
// Reads the Upstash REST creds from env. Accepts the standard integration names AND the `livedashboard_`
// prefixed ones (the prefix this project's Upstash connection uses), so it works whichever way the DB is
// connected to the Vercel project. If NO KV env is present it returns null and every helper DEGRADES GRACEFULLY
// to "allow / don't block", so a missing/misconfigured KV never errors a request — it just falls back to the
// caller's previous behavior.

let _redis = null;
let _init = false;

function kv() {
  if (_init) return _redis;
  _init = true;
  try {
    const url =
      process.env.KV_REST_API_URL ||
      process.env.livedashboard_KV_REST_API_URL ||
      process.env.UPSTASH_REDIS_REST_URL;
    const token =
      process.env.KV_REST_API_TOKEN ||
      process.env.livedashboard_KV_REST_API_TOKEN ||
      process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) { _redis = null; return _redis; }
    const { Redis } = require('@upstash/redis');
    _redis = new Redis({ url, token });
  } catch (_) {
    _redis = null;
  }
  return _redis;
}

// True if KV is actually configured (useful when a caller wants to know whether to trust the shared limiter).
function kvReady() { return !!kv(); }

// Exactly-once claim. Returns true the FIRST time `key` is seen (and claims it for ttlSec), false if already
// claimed. Fails OPEN (returns true) when KV is unavailable, so a caller never silently drops a real event.
async function claimOnce(key, ttlSec = 86400) {
  const r = kv();
  if (!r) return true;
  try {
    const ok = await r.set(key, '1', { nx: true, ex: ttlSec });
    return ok === 'OK' || ok === true;   // @upstash/redis returns 'OK' on a successful NX set, null if it existed
  } catch (_) {
    return true;   // KV error → don't block the side effect
  }
}

// Fixed-window rate limit. Returns true if ALLOWED, false if over `limit` within `windowSec`. Fails OPEN when
// KV is unavailable so the caller can fall back to its own per-instance limiter.
async function rateOk(key, limit, windowSec) {
  const r = kv();
  if (!r) return true;
  try {
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, windowSec);
    return n <= limit;
  } catch (_) {
    return true;
  }
}

module.exports = { kv, kvReady, claimOnce, rateOk };
