// reconcile-subs.js — daily safety net for a MISSED Stripe webhook.
// Lists active subscription licenses, checks each against Stripe's REAL status, and suspends/cancels
// ONLY the ones Stripe confirms are dead. FAILS SAFE: any error fetching a subscription -> skip it
// (never wrongly suspends a paying customer). This closes the "non-paying sub stays active forever on a
// missed invoice.payment_failed webhook" leak WITHOUT the payer-lockout risk of an enforced expiry column.
// Auth: Vercel Cron (Authorization: Bearer ${CRON_SECRET}) or a manual admin trigger (X-Admin-Key).

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const ANALYST_AUD = process.env.RESEND_ANALYST_AUDIENCE_ID;
const FREE_AUD = process.env.RESEND_AUDIENCE_ID;
const LS = (process.env.NOVO_LICENSE_SERVER_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY;

// Analyst subs carry NO license/instance, so the license-key reconcile below never sees them — a MISSED
// customer.subscription.deleted webhook would leave a canceller on the paid Analyst audience forever (paid
// reads for free). This pass reconciles the Analyst Resend audience against Stripe. FAIL SAFE like the
// license pass: it only removes a contact when Stripe gives POSITIVE evidence of a dead sub AND no active
// paid sub — a contact with NO Stripe sub at all (a possible manual/comp add) is always left alone.
async function reconcileAnalyst() {
  if (!resend || !ANALYST_AUD) return { checked: 0, removed: 0, kept: 0, skipped: 0 };
  let contacts = [];
  try {
    const r = await resend.contacts.list({ audienceId: ANALYST_AUD });
    contacts = Array.isArray(r?.data?.data) ? r.data.data : (Array.isArray(r?.data) ? r.data : []);
  } catch (e) { console.error('[reconcile-subs] analyst list failed:', e.message); return { checked: 0, removed: 0, kept: 0, skipped: 0, error: e.message }; }
  let checked = 0, removed = 0, kept = 0, skipped = 0;
  for (const c of contacts) {
    const email = c && c.email; if (!email) continue;
    checked++;
    let subs = [];
    try {
      const custs = await stripe.customers.list({ email, limit: 100 });
      for (const cu of custs.data) {
        const s = await stripe.subscriptions.list({ customer: cu.id, status: 'all', limit: 20 });
        subs.push(...s.data);
      }
    } catch (e) { skipped++; continue; }              // can't confirm with Stripe → leave alone (fail safe)
    if (subs.length === 0) { skipped++; continue; }    // no Stripe sub at all → possible manual/comp contact; never auto-remove
    if (subs.some(s => ['active', 'trialing', 'past_due'].includes(s.status))) { kept++; continue; }  // still paying (incl. Trader)
    if (subs.some(s => ['canceled', 'unpaid', 'incomplete_expired'].includes(s.status))) {
      try { await resend.contacts.remove({ audienceId: ANALYST_AUD, email }); } catch (_) {}
      if (FREE_AUD) { try { await resend.contacts.create({ audienceId: FREE_AUD, email, unsubscribed: false }); } catch (_) {} }
      removed++;
    } else { skipped++; }
  }
  return { checked, removed, kept, skipped };
}

async function lsGet(path) {
  const r = await fetch(`${LS}${path}`, { headers: { 'X-Admin-Key': ADMIN_KEY } });
  if (!r.ok) throw new Error(`license server ${path} -> ${r.status}`);
  return r.json();
}
async function lsPost(path) {
  const r = await fetch(`${LS}${path}`, {
    method: 'POST',
    headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  });
  return r.ok;
}

module.exports = async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const okCron = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const okAdmin = ADMIN_KEY && (req.headers['x-admin-key'] || '') === ADMIN_KEY;
  if (!okCron && !okAdmin) return res.status(403).json({ error: 'Forbidden' });
  if (!LS || !ADMIN_KEY || !process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Not configured' });
  }

  try {
    const keys = await lsGet('/admin/keys');
    const subs = (Array.isArray(keys) ? keys : []).filter(k =>
      String(k.type || '').toLowerCase().startsWith('sub') &&
      k.status === 'active' && k.stripe_subscription_id &&
      // Only reconcile REAL Stripe subscriptions. Manually-issued/admin/comp keys carry a synthetic
      // `manual-…` (or other non-`sub_`) id that will always be resource_missing in Stripe — they are
      // NOT Stripe-billed and must never be reconciled against it. (This is the admin-key incident guard.)
      String(k.stripe_subscription_id).startsWith('sub_'));

    let checked = 0, suspended = 0, cancelled = 0, skipped = 0;
    for (const k of subs) {
      checked++;
      let sub;
      try {
        sub = await stripe.subscriptions.retrieve(k.stripe_subscription_id);
      } catch (e) {
        // Can't confirm with Stripe -> leave it alone (FAIL SAFE), including resource_missing on a
        // deleted/purged sub. A GENUINE customer cancellation comes back as status 'canceled' below
        // (handled) — not as a deleted subscription. Deleting a Stripe sub is a manual/test action, so
        // cancelling a license off resource_missing revoked the owner's own dev key (2026-07-08 incident).
        // Never cancel on an ambiguous retrieve error; the recurring Stripe-health noise is cosmetic.
        skipped++; continue;
      }
      const s = sub.status;  // active | trialing | past_due | unpaid | canceled | incomplete | incomplete_expired
      if (s === 'canceled' || s === 'incomplete_expired') {
        if (await lsPost(`/admin/subscription/${k.stripe_subscription_id}/cancel`)) cancelled++;
      } else if (s === 'unpaid' || s === 'past_due') {
        if (await lsPost(`/admin/subscription/${k.stripe_subscription_id}/suspend`)) suspended++;
      }
      // active / trialing / incomplete -> healthy or pending: leave alone
    }

    let analyst = { checked: 0, removed: 0, kept: 0, skipped: 0 };
    try { analyst = await reconcileAnalyst(); } catch (e) { console.error('[reconcile-subs] analyst pass error:', e.message); }

    console.log(`[reconcile-subs] licenses checked=${checked} suspended=${suspended} cancelled=${cancelled} skipped=${skipped} | analyst checked=${analyst.checked} removed=${analyst.removed} kept=${analyst.kept} skipped=${analyst.skipped}`);
    return res.status(200).json({ checked, suspended, cancelled, skipped, analyst });
  } catch (err) {
    console.error('[reconcile-subs] error:', err.message);
    return res.status(500).json({ error: 'Reconcile failed' });
  }
};
