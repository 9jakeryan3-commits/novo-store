const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.SITE_URL || 'https://novo-aitrading.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'payment',
      success_url: (process.env.SITE_URL || 'https://novo-aitrading.app') + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (process.env.SITE_URL || 'https://novo-aitrading.app') + '/#pricing',
      billing_address_collection: 'auto',
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[CHECKOUT ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
};
