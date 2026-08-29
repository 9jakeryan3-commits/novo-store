const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// NoVo Crypto Market Map — its OWN product, not a bundle and not an Analyst add-on.
// Tagged metadata.tier=crypto so the webhook routes it to its own audience rather than the
// Analyst or Trader paths. 503 until STRIPE_PRICE_CRYPTO is set, so this can ship before
// the Stripe product exists without ever taking a payment against the wrong price.
//
// Entitlement is read back from the PRICE ID in api/crypto-map.js, not from this metadata
// — metadata is mutable, price ids are not.

const _rl = new Map();
function _rateLimited(ip) {
  const now = Date.now();
  const rec = _rl.get(ip) || { n: 0, reset: now + 60000 };
  if (now > rec.reset) { _rl.set(ip, { n: 1, reset: now + 60000 }); return false; }
  rec.n++; _rl.set(ip, rec);
  return rec.n > 5;
}

module.exports = async (req, res) => {
  const SITE = process.env.SITE_URL || 'https://novo-options.trade';
  res.setHeader('Access-Control-Allow-Origin', SITE);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop() || req.socket?.remoteAddress || '').trim() || 'unknown';
  if (_rateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });
  if (!(await require('./_kv').rateOk('ckt_cx:' + ip, 8, 60))) return res.status(429).json({ error: 'Too many requests' });

  let plan = 'monthly';
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b && b.plan === 'yearly') plan = 'yearly';
  } catch (_) {}

  // Stripe product prod_V9XZrb8qBEdzoI — "NoVo Crypto Market Map - NoVo AI", $79/mo and $790/yr.
  // Literals kept alongside the env vars the way checkout-analyst.js does, so a dropped
  // env var degrades to the right price rather than to a 503.
  const MONTHLY = process.env.STRIPE_PRICE_CRYPTO || 'price_1U9EU0B1Bq29OALajbT8DWJS';
  const YEARLY = process.env.STRIPE_PRICE_CRYPTO_YEARLY || 'price_1U9EUsB1Bq29OALaYh2QODHA';
  const priceId = (plan === 'yearly') ? (YEARLY || MONTHLY) : MONTHLY;
  if (!priceId) {
    return res.status(503).json({ error: 'The Crypto Market Map is not open for signups yet.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      metadata: { tier: 'crypto', plan },
      // 7-day free trial, card collected up front — same as Analyst. Card-upfront converts
      // far better than the no-card trials the crypto tools run.
      subscription_data: { metadata: { tier: 'crypto', plan }, trial_period_days: 7 },
      success_url: 'https://app.novo-aitrading.app/portal',
      cancel_url: `${SITE}/crypto`,
      billing_address_collection: 'auto',
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[checkout-crypto]', err && err.message);
    res.status(500).json({ error: 'Could not start checkout' });
  }
};
