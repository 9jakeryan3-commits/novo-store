const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// NoVo Analyst — $49/mo market-analysis email tier. Tagged metadata.tier=analyst so webhook-sub routes it
// to the Analyst Resend audience (NOT the Trader license/provision path). 503 until STRIPE_PRICE_ANALYST set.

const _rl = new Map();
function _rateLimited(ip) {
  const now = Date.now();
  const rec = _rl.get(ip) || { n: 0, reset: now + 60000 };
  if (now > rec.reset) { _rl.set(ip, { n: 1, reset: now + 60000 }); return false; }
  rec.n++; _rl.set(ip, rec);
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

  if (!process.env.STRIPE_PRICE_ANALYST) {
    return res.status(503).json({ error: 'Analyst tier not configured yet' });
  }

  // plan: 'yearly' picks the annual price ($499/yr); anything else = monthly ($49/mo).
  let plan = 'monthly';
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b && b.plan === 'yearly') plan = 'yearly';
  } catch (_) {}
  const yearlyId = process.env.STRIPE_PRICE_ANALYST_YEARLY;
  const priceId = (plan === 'yearly' && yearlyId) ? yearlyId : process.env.STRIPE_PRICE_ANALYST;
  if (plan === 'yearly' && !yearlyId) plan = 'monthly';  // no annual price configured → fall back

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      metadata: { tier: 'analyst', plan },
      // 7-day free trial — card collected upfront so it auto-converts (highest-converting trial in this category).
      subscription_data: { metadata: { tier: 'analyst', plan }, trial_period_days: 7 },
      success_url: 'https://app.novo-aitrading.app/status',
      cancel_url: `${SITE}/analyst`,
      billing_address_collection: 'auto',
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[checkout-analyst] Failed:', err.message);
    res.status(500).json({ error: 'Analyst checkout creation failed' });
  }
};
