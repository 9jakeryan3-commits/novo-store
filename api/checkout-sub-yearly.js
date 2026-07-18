const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const _rl = new Map();
function _rateLimited(ip) {
  const now = Date.now();
  const rec = _rl.get(ip) || { n: 0, reset: now + 60000 };
  if (now > rec.reset) { _rl.set(ip, { n: 1, reset: now + 60000 }); return false; }
  rec.n++;
  _rl.set(ip, rec);
  return rec.n > 5;
}

// Trader YEARLY subscription ($2,499/yr, auto-renew). Identical to checkout-sub.js except the price.
module.exports = async (req, res) => {
  const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';
  res.setHeader('Access-Control-Allow-Origin', SITE);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (_rateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      // Trader $1,990/yr (2026-07-18). Hardcoded to the $1,990 price ID. The old $1,790 price stays live so
      // existing annual subs keep $1,790 for life — only new checkouts hit $1,990. Price ID is not a secret.
      // Env override STRIPE_PRICE_SUB_YEARLY_ID_1990 wins if set.
      line_items: [{ price: (process.env.STRIPE_PRICE_SUB_YEARLY_ID_1990 || 'price_1Toa5jApyfMAkbeEB0bgmDk8'), quantity: 1 }],
      mode: 'subscription',
      success_url: 'https://app.novo-aitrading.app/status',
      cancel_url: `${SITE}/#pricing`,
      billing_address_collection: 'auto',
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[checkout-sub-yearly] Failed:', err.message);
    res.status(500).json({ error: 'Yearly subscription checkout creation failed' });
  }
};
