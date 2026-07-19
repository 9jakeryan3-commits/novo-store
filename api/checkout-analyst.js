const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// NoVo Analyst — $79/mo market-analysis email tier. Tagged metadata.tier=analyst so webhook-sub routes it
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
  // Cross-instance shared rate limit (the per-lambda _rl above can't aggregate on Vercel). Fails open if KV unset. (audit #13)
  if (!(await require('./_kv').rateOk('ckt_an:' + ip, 8, 60))) return res.status(429).json({ error: 'Too many requests' });

  // plan: 'yearly' picks the annual price ($790/yr); anything else = monthly ($79/mo).
  // Hardcoded to the $79/$790 price IDs (created 2026-07-18). The old $69/$690 prices stay live in Stripe so
  // existing Analyst subscribers keep their rate for life — only new checkouts hit $79/$790. Env overrides win.
  let plan = 'monthly';
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b && b.plan === 'yearly') plan = 'yearly';
  } catch (_) {}
  const MONTHLY_79 = process.env.STRIPE_PRICE_ANALYST_79 || 'price_1TugYAApyfMAkbeEarl2ULSv';        // $79/mo
  const YEARLY_790 = process.env.STRIPE_PRICE_ANALYST_YEARLY_790 || 'price_1TugYAApyfMAkbeE9c3Rdypj'; // $790/yr
  const priceId = (plan === 'yearly') ? YEARLY_790 : MONTHLY_79;

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
