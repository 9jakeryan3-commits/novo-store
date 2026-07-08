// reconcile-subs.js — daily safety net for a MISSED Stripe webhook.
// Lists active subscription licenses, checks each against Stripe's REAL status, and suspends/cancels
// ONLY the ones Stripe confirms are dead. FAILS SAFE: any error fetching a subscription -> skip it
// (never wrongly suspends a paying customer). This closes the "non-paying sub stays active forever on a
// missed invoice.payment_failed webhook" leak WITHOUT the payer-lockout risk of an enforced expiry column.
// Auth: Vercel Cron (Authorization: Bearer ${CRON_SECRET}) or a manual admin trigger (X-Admin-Key).

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const LS = (process.env.NOVO_LICENSE_SERVER_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY;

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
      k.status === 'active' && k.stripe_subscription_id);

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

    console.log(`[reconcile-subs] checked=${checked} suspended=${suspended} cancelled=${cancelled} skipped=${skipped}`);
    return res.status(200).json({ checked, suspended, cancelled, skipped });
  } catch (err) {
    console.error('[reconcile-subs] error:', err.message);
    return res.status(500).json({ error: 'Reconcile failed' });
  }
};
