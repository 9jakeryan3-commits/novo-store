// api/_lib/internal-tag.js — mark internally-created checkout sessions so the funnel can tell
// a builder from a buyer.
//
// Pete's 2026-09-05 Stripe pull found 54 checkout sessions — every product, every build day,
// zero emails, zero completions — and NOTHING distinguishing fleet verification traffic from
// real prospects. Jake's go, same day: internally-initiated sessions get a metadata tag, so
// the NEXT 54 are interpretable. The gate is a secret header, timing-safe, because a tag a
// real buyer could set on themselves would poison the telemetry in the other direction.
//
// Usage (every api/checkout-*.js): spread into the session's metadata —
//   metadata: { tier: 'analyst', plan, ...internalTag(req) }
// A fleet caller sends  x-internal-check: <ANALYST_PUBLISH_SECRET>  and its session carries
// metadata.internal='fleet'. Absent or wrong header adds NOTHING — the buyer path is untouched.

const crypto = require('crypto');

function internalTag(req) {
  try {
    const want = process.env.ANALYST_PUBLISH_SECRET || '';
    const got = String((req.headers && req.headers['x-internal-check']) || '');
    if (!want || !got || got.length !== want.length) return {};
    if (!crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return {};
    return { internal: 'fleet', internal_at: new Date().toISOString() };
  } catch (_) {
    return {};
  }
}

module.exports = { internalTag };
