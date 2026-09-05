// reconcile-subs.js — daily safety net for a MISSED Stripe webhook.
// Reconciles the paid Resend audiences (Analyst + Crypto) against Stripe's REAL subscription
// status. FAILS SAFE: any error fetching a subscription -> skip it (never wrongly removes a
// paying customer). The LICENSE pass that used to lead this file is GONE — the license layer
// was decommissioned 2026-09-05 (Jake: "delete"); the audience passes, which used to run as
// its afterthought inside the same try, are now the whole job.
// Auth: Vercel Cron (Authorization: Bearer ${CRON_SECRET}) or x-analyst-secret (the house
// server-to-server pattern, same as daily-digest) for a manual trigger.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const { isReservedEmail } = require('./_lib/reserved-email.js');
const ANALYST_AUD = process.env.RESEND_ANALYST_AUDIENCE_ID;
const FREE_AUD = process.env.RESEND_AUDIENCE_ID;

// Analyst subs carry NO license/instance, so the license-key reconcile below never sees them — a MISSED
// customer.subscription.deleted webhook would leave a canceller on the paid Analyst audience forever (paid
// reads for free). This pass reconciles the Analyst Resend audience against Stripe. FAIL SAFE like the
// license pass: it only removes a contact when Stripe gives POSITIVE evidence of a dead sub AND no active
// paid sub — a contact with NO Stripe sub at all (a possible manual/comp add) is always left alone.
// ── PARAMETERISED BY AUDIENCE (2026-09-02) ───────────────────────────────────────────────────
// This ran on the Analyst audience alone. The CRYPTO audience has existed since the $79 product
// shipped — webhook-sub.js adds every crypto subscriber to it — and nothing ever reconciled it, so
// a cancelled crypto subscriber stayed on a paid list forever. Same defect as api/unsubscribe.js
// omitting it, from the same cause: a hand-kept list of audiences that a new product outgrew.
//
// SEMANTIC SHARPENING, stated out loud rather than smuggled in: the "still paying" test WAS
// `subs.some(live)` — any live subscription at all kept you on the paid Analyst list. That is
// right for Analyst almost by accident (Trader includes Analyst) and would be WRONG for crypto,
// where a live Trader grants nothing. Both passes now ask the precise question via the shared
// grant helpers in _lib/entitlements.js — the same functions the paywall and the upsell use, so
// there is one definition of "this subscription includes X" instead of three.
//
// Everything else is unchanged, including the fail-safe direction: a contact is removed ONLY on
// positive Stripe evidence of a dead sub AND nothing live that grants this product. No Stripe
// customer at all (a manual/comp add) is always left alone.
const { subGrantsAnalyst, subGrantsCrypto } = require('./_lib/entitlements.js');

async function reconcileAudience(audId, label, grants) {
  // LOUD, not silent. This used to return all-zeros when unconfigured, which is byte-identical to
  // "ran and found nothing to do" — a number that cannot distinguish the two states it exists to
  // report. A cron that has never run once looks exactly like a clean estate.
  if (!resend || !audId) {
    console.warn(`[reconcile-subs] ${label}: NOT RUN — ${!resend ? 'RESEND_API_KEY missing' : 'audience id missing'}`);
    return { ran: false, reason: !resend ? 'no-resend-key' : 'no-audience-id',
             checked: 0, removed: 0, kept: 0, skipped: 0 };
  }
  let contacts = [];
  try {
    const r = await resend.contacts.list({ audienceId: audId });
    contacts = Array.isArray(r?.data?.data) ? r.data.data : (Array.isArray(r?.data) ? r.data : []);
  } catch (e) { console.error(`[reconcile-subs] ${label} list failed:`, e.message); return { ran: false, reason: 'list-failed', checked: 0, removed: 0, kept: 0, skipped: 0, error: e.message }; }
  let checked = 0, removed = 0, kept = 0, skipped = 0;
  for (const c of contacts) {
    const email = c && c.email; if (!email) continue;
    checked++;
    let subs = [];
    try {
      // customers.list({email}) is case-sensitive exact-match, so a Resend contact whose casing differs from the
      // Stripe customer email would match nothing and the cancelled sub would never be removed from the paid
      // audience. Stripe Search's email index IS case-insensitive — use it as primary + list() as a fallback for
      // a just-created customer (Search is eventually consistent). Mirrors analyst-publish.js.
      const _seen = new Set();
      const _norm = String(email).trim().toLowerCase();
      try {
        const sr = await stripe.customers.search({ query: `email:"${_norm.replace(/"/g, '')}"`, limit: 20 });
        for (const cu of sr.data) _seen.add(cu.id);
      } catch (_) { /* search index warming up / unavailable — fall through to list() */ }
      const custs = await stripe.customers.list({ email: _norm, limit: 100 });
      for (const cu of custs.data) _seen.add(cu.id);
      for (const cuId of _seen) {
        const s = await stripe.subscriptions.list({ customer: cuId, status: 'all', limit: 20 });
        subs.push(...s.data);
      }
    } catch (e) { skipped++; continue; }              // can't confirm with Stripe → leave alone (fail safe)
    if (subs.length === 0) { skipped++; continue; }    // no Stripe sub at all → possible manual/comp contact; never auto-remove
    // Still entitled to THIS audience's product — not merely "still paying for something". A live
    // Trader grants Analyst and grants no crypto, which is why this has to be per-audience.
    if (subs.some(s => ['active', 'trialing', 'past_due'].includes(s.status) && grants(s))) { kept++; continue; }
    if (subs.some(s => ['canceled', 'unpaid', 'incomplete_expired'].includes(s.status))) {
      try { await resend.contacts.remove({ audienceId: audId, email }); } catch (_) {}
      if (FREE_AUD && !isReservedEmail(email)) { try { await resend.contacts.create({ audienceId: FREE_AUD, email, unsubscribed: false }); } catch (_) {} }
      removed++;
    } else { skipped++; }
  }
  return { ran: true, checked, removed, kept, skipped };
}

// The two paid audiences. CRYPTO_AUD read here rather than at module top so an env var added
// without a redeploy is still picked up on the next cold start, same as the others.
const reconcileAnalyst = () => reconcileAudience(ANALYST_AUD, 'analyst', subGrantsAnalyst);
const reconcileCrypto = () =>
  reconcileAudience(process.env.RESEND_CRYPTO_AUDIENCE_ID, 'crypto', subGrantsCrypto);

module.exports = async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const okCron = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const okS2S = process.env.ANALYST_PUBLISH_SECRET &&
    (req.headers['x-analyst-secret'] || '') === process.env.ANALYST_PUBLISH_SECRET;
  if (!okCron && !okS2S) return res.status(403).json({ error: 'Forbidden' });
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Not configured' });
  }

  try {

    // `ran: false` is the default, so a pass that THREW is reported as not-run rather than as a
    // clean zero. Same reason the unconfigured branch says so out loud: every zero on this
    // endpoint has to be attributable to either "nothing to do" or "never happened".
    let analyst = { ran: false, reason: 'pass-threw', checked: 0, removed: 0, kept: 0, skipped: 0 };
    let cryptoAud = { ran: false, reason: 'pass-threw', checked: 0, removed: 0, kept: 0, skipped: 0 };
    try { analyst = await reconcileAnalyst(); } catch (e) { console.error('[reconcile-subs] analyst pass error:', e.message); }
    try { cryptoAud = await reconcileCrypto(); } catch (e) { console.error('[reconcile-subs] crypto pass error:', e.message); }

    const fmt = (n, a) => `${n} ${a.ran ? `checked=${a.checked} removed=${a.removed} kept=${a.kept} skipped=${a.skipped}` : `NOT RUN (${a.reason})`}`;
    console.log(`[reconcile-subs] ${fmt('analyst', analyst)} | ${fmt('crypto', cryptoAud)} (license pass retired 2026-09-05)`);
    return res.status(200).json({ analyst, crypto: cryptoAud, license_pass: 'retired 2026-09-05' });
  } catch (err) {
    console.error('[reconcile-subs] error:', err.message);
    return res.status(500).json({ error: 'Reconcile failed' });
  }
};
