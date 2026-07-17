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

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (_rateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      // Trader $179/mo (2026-07-17). Hardcoded to the new price ID rather than STRIPE_PRICE_SUB_ID because
      // that Vercel env still points at the old $249 price and can't be updated from here — the env var takes
      // precedence only if it's actually the $179 one, so this forces the intended price. Safe to commit: a
      // Stripe price ID is not a secret. To go back to env-driven, set STRIPE_PRICE_SUB_ID to this ID in Vercel.
      line_items: [{ price: (process.env.STRIPE_PRICE_SUB_ID_179 || 'price_1TuKflApyfMAkbeETEX4qjhL'), quantity: 1 }],
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
