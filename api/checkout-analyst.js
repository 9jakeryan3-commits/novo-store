const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// NoVo Analyst — $129/mo market-analysis email tier. Tagged metadata.tier=analyst so webhook-sub routes it
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
  const SITE = process.env.SITE_URL || 'https://novo-options.trade';
  res.setHeader('Access-Control-Allow-Origin', SITE);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop() || req.socket?.remoteAddress || '').trim() || 'unknown';
  if (_rateLimited(ip)) return res.status(429).json({ error: 'Too many requests' });
  // Cross-instance shared rate limit (the per-lambda _rl above can't aggregate on Vercel). Fails open if KV unset. (audit #13)
  if (!(await require('./_kv').rateOk('ckt_an:' + ip, 8, 60))) return res.status(429).json({ error: 'Too many requests' });

  // plan: 'yearly' picks the annual price ($1,290/yr); anything else = monthly ($129/mo).
  // Hardcoded to the $129/$1,290 price IDs (created 2026-08-16). The older $129/$1,290 and $69/$690 prices stay live in Stripe so
  // existing Analyst subscribers keep their rate for life — only new checkouts hit $129/$1,290. Env overrides win.
  if (require('./_lib/sales-gate.js').blockIfPaused(req, res, 'checkout-analyst')) return;

  // An ABSENT plan still means monthly — this endpoint sells one product and its pages have always
  // posted bare for the monthly case, so requiring it would break a working flow for no gain.
  // But a plan that is PRESENT and unrecognised is now a 400 rather than a silent monthly sale:
  // "yearly" misspelled, or a toggle that set the wrong value, used to sell the $129 instead of
  // the $1,290 and look like a successful checkout from both ends. Reject what we cannot read.
  let plan = 'monthly';
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b && b.plan != null && b.plan !== 'monthly' && b.plan !== 'yearly') {
      return res.status(400).json({ error: "plan must be 'monthly' or 'yearly'" });
    }
    if (b && b.plan === 'yearly') plan = 'yearly';
  } catch (_) {}
  // Fallbacks refreshed 2026-09-01 to the LLC-account ids (acct_1U8720B1Bq29OALa) the env
  // vars point at — the old ApyfMAkbeE fallbacks live on the ORIGINAL Stripe account, so if
  // the env var ever dropped, checkout would send an alien price id to the LLC secret key
  // and every Analyst checkout would 500. A fallback that cannot work is not a fallback.
  const MONTHLY_79 = process.env.STRIPE_PRICE_ANALYST || 'price_1U8R0NB1Bq29OALa7evMqazz';        // $129/mo
  const YEARLY_790 = process.env.STRIPE_PRICE_ANALYST_YEARLY || 'price_1U8R2PB1Bq29OALaUv2W6VAm'; // $1,290/yr
  const priceId = (plan === 'yearly') ? YEARLY_790 : MONTHLY_79;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      metadata: { tier: 'analyst', plan },
      // 7-day free trial — card collected upfront so it auto-converts (highest-converting trial in this category).
      subscription_data: { metadata: { tier: 'analyst', plan }, trial_period_days: 7 },
      success_url: 'https://app.novo-aitrading.app/portal',
      cancel_url: `${SITE}/analyst`,
      billing_address_collection: 'auto',
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[checkout-analyst] Failed:', err.message);
    res.status(500).json({ error: 'Analyst checkout creation failed' });
  }
};
