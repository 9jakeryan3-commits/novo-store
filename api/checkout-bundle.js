const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// NoVo bundles (Gap Ledger #9, approved 2026-09-01). TWO line items per checkout, on purpose:
// the bundle is the EXISTING base price plus a discounted crypto COMPANION price on the
// existing Crypto Market Map product — so every entitlement gate in the stack (they all
// iterate sub.items.data price ids) sees a price id it already understands, and the control
// plane's Trader-by-product classification works unchanged because the Complete bundle's
// first item IS the Trader price.
//
//   ac  — Analyst + Crypto:  $129 + $40 = $169/mo,  $1,290 + $400 = $1,690/yr. 7-day trial
//         (both components carry one today).
//   all — Complete (Trader + Crypto; Trader includes Analyst): $209 + $30 = $239/mo,
//         $2,000 + $300 = $2,300/yr. NO trial — the Trader trial was removed for good
//         (2026-07-22) and a bundle must not reintroduce it by the back door.
//
// metadata.tier is 'bundle_ac' | 'bundle_all' at BOTH the session and subscription level:
// the session copy drives webhook-sub's checkout branch + discord.js redirects, the
// subscription copy drives cancel-time classification. Entitlement itself never reads
// metadata — it reads the price ids (same reasoning as every other product).

const _rl = new Map();
function _rateLimited(ip) {
  const now = Date.now();
  const rec = _rl.get(ip) || { n: 0, reset: now + 60000 };
  if (now > rec.reset) { _rl.set(ip, { n: 1, reset: now + 60000 }); return false; }
  rec.n++; _rl.set(ip, rec);
  return rec.n > 5;
}

// Base prices — the LIVE LLC-account ids (acct_1U8720B1Bq29OALa), verified against the API
// 2026-09-01. Env wins; the literal keeps a dropped variable from breaking the bundle.
const ANALYST_MO = process.env.STRIPE_PRICE_ANALYST || 'price_1U8R0NB1Bq29OALa7evMqazz';         // $129/mo
const ANALYST_YR = process.env.STRIPE_PRICE_ANALYST_YEARLY || 'price_1U8R2PB1Bq29OALaUv2W6VAm';  // $1,290/yr
const TRADER_MO = process.env.STRIPE_PRICE_SUB_ID || 'price_1U8R0zB1Bq29OALaAdZzFw8S';           // $209/mo
const TRADER_YR = process.env.STRIPE_PRICE_SUB_YEARLY_ID || 'price_1U8R1cB1Bq29OALaUL53wxgD';    // $2,000/yr
// Crypto companions — created 2026-09-01 on prod_V9XZrb8qBEdzoI for exactly this file.
const COMP_AC_MO = process.env.STRIPE_PRICE_CRYPTO_BUNDLE_AC || 'price_1UB0ZhB1Bq29OALa8iLZSSL5';          // $40/mo
const COMP_AC_YR = process.env.STRIPE_PRICE_CRYPTO_BUNDLE_AC_YEARLY || 'price_1UB0ZhB1Bq29OALamNjyA6Y9';   // $400/yr
const COMP_ALL_MO = process.env.STRIPE_PRICE_CRYPTO_BUNDLE_ALL || 'price_1UB0ZhB1Bq29OALaOw2hUHWS';        // $30/mo
const COMP_ALL_YR = process.env.STRIPE_PRICE_CRYPTO_BUNDLE_ALL_YEARLY || 'price_1UB0ZhB1Bq29OALaWQPTPOs7'; // $300/yr

module.exports = async (req, res) => {
  const SITE = process.env.SITE_URL || 'https://novo-options.trade';
  res.setHeader('Access-Control-Allow-Origin', SITE);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop() || req.socket?.remoteAddress || '').trim() || 'unknown';
  if (_rateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });
  if (!(await require('./_kv').rateOk('ckt_bn:' + ip, 8, 60))) return res.status(429).json({ error: 'Too many requests' });

  let bundle = 'ac', plan = 'monthly';
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b && b.bundle === 'all') bundle = 'all';
    if (b && b.plan === 'yearly') plan = 'yearly';
  } catch (_) {}

  const yearly = plan === 'yearly';
  const items = bundle === 'all'
    ? [{ price: yearly ? TRADER_YR : TRADER_MO, quantity: 1 },
       { price: yearly ? COMP_ALL_YR : COMP_ALL_MO, quantity: 1 }]
    : [{ price: yearly ? ANALYST_YR : ANALYST_MO, quantity: 1 },
       { price: yearly ? COMP_AC_YR : COMP_AC_MO, quantity: 1 }];
  const tier = bundle === 'all' ? 'bundle_all' : 'bundle_ac';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: items,
      mode: 'subscription',
      metadata: { tier, plan },
      subscription_data: {
        metadata: { tier, plan },
        // 7-day card-upfront trial on the AC bundle only — see the header note on 'all'.
        ...(bundle === 'ac' ? { trial_period_days: 7 } : {}),
      },
      success_url: 'https://app.novo-aitrading.app/portal',
      cancel_url: `${SITE}/plans`,
      billing_address_collection: 'auto',
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[checkout-bundle] Failed:', err.message);
    res.status(500).json({ error: 'Bundle checkout creation failed' });
  }
};
