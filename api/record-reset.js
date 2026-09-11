// api/record-reset.js — zero the alert and prediction records.
//
// Jake, 2026-09-11: "delete the fucking predictions and alerts scored up until today that are
// wrong and not real ... so it starts at 0".
//
// The record began 2026-09-07 and held 13 graded predictions at 30.8% — all of it traffic from
// building the desk, none of it a real call. A track record that opens on a fake number is a false
// claim about how good the desk is, so it goes.
//
// Ops secret + POST. That is the whole gate: POST so no link or prefetch can trip it, the secret
// so only the owner can.

const crypto = require('node:crypto');
const { kv } = require('./_kv.js');

function authed(req) {
  const want = process.env.OPS_SECRET || process.env.ANALYST_PUBLISH_SECRET || '';
  const got = String(req.headers['x-ops-secret'] || req.headers['x-analyst-secret'] || '');
  if (!want || !got || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (_) { return false; }
}

/* Everything that holds a SCORE. Enumerated, not pattern-matched: a KEYS scan is at the mercy of
   whatever else shares a prefix, and this is the one place a wrong match cannot be undone.
   The archive months are the only ones that can exist — the record started 2026-09-07. */
const KEYS = [
  'pred:log',          // NoVo's working set
  'pred:tally',        // the all-time counters the score reads
  'pred:arch:2026-09',
  'pred:arch:2026-08',
  'novo:alerts:feed',  // the released-alert feed
  'alert:log',         // the alert book
  'alert:tally',
  'alert:arch:2026-09',
  'alert:arch:2026-08',
];

module.exports = async (req, res) => {
  if (!authed(req)) return res.status(403).json({ error: 'forbidden' });
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only', keys: KEYS });
  }
  const r = kv();
  if (!r) return res.status(503).json({ error: 'kv unavailable' });

  const deleted = [];
  const failed = [];
  for (const k of KEYS) {
    try { await r.del(k); deleted.push(k); } catch (_) { failed.push(k); }
  }

  /* Read back rather than trust the DELs — "I issued a delete" and "it is gone" are different
     claims, and only one of them is worth reporting. */
  const left = [];
  for (const k of KEYS) {
    try {
      const v = await r.get(k);
      if (v !== null && v !== undefined) { left.push(k); continue; }
      const h = await r.hgetall(k);
      if (h && Object.keys(h).length) { left.push(k); continue; }
      const l = await r.lrange(k, 0, -1);
      if (Array.isArray(l) && l.length) left.push(k);
    } catch (_) { /* a key that cannot be read as any type is a key that is gone */ }
  }

  return res.status(200).json({
    ok: left.length === 0,
    note: left.length === 0 ? 'Record is at zero.' : 'Some keys still hold data.',
    deleted, failed, still_holding_data: left,
  });
};
