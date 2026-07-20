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

module.exports = async (req, res) => {
  const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';
  res.setHeader('Access-Control-Allow-Origin', SITE);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop() || req.socket?.remoteAddress || '').trim() || 'unknown';
  if (_rateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });
  // Cross-instance shared rate limit (the per-lambda _rl above can't aggregate on Vercel). Fails open if KV unset. (audit #13)
  if (!(await require('./_kv').rateOk('ckt_sub:' + ip, 8, 60))) return res.status(429).json({ error: 'Too many requests' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      // Trader $199/mo (2026-07-18). Hardcoded to the $199 price ID. The old $179 price stays live in Stripe
      // so existing subscribers keep $179 for life (price-for-life) — only new checkouts hit $199. Safe to
      // commit: a Stripe price ID is not a secret. Env override STRIPE_PRICE_SUB_ID_199 wins if set.
      line_items: [{ price: (process.env.STRIPE_PRICE_SUB_ID_199 || 'price_1Toa5jApyfMAkbeEs94CfAQC'), quantity: 1 }],
      mode: 'subscription',
      success_url: 'https://app.novo-aitrading.app/status',
      cancel_url: `${SITE}/#pricing`,
      billing_address_collection: 'auto',
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[checkout-sub] Failed:', err.message);
    res.status(500).json({ error: 'Subscription checkout creation failed' });
  }
};
