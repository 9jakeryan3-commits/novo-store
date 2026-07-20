const Stripe = require('stripe');
const { Resend } = require('resend');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const _rl = new Map();
function _rateLimited(ip) {
  const now = Date.now();
  const rec = _rl.get(ip) || { n: 0, reset: now + 60000 };
  if (now > rec.reset) { _rl.set(ip, { n: 1, reset: now + 60000 }); return false; }
  rec.n++;
  _rl.set(ip, rec);
  return rec.n > 3;
}

function portalEmailHtml(url) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#101013;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="font-size:32px;font-weight:900;color:#eaf3ff;letter-spacing:-1px">No<span style="color:#10b981">Vo</span></div>
    <h2 style="color:#eaf3ff;font-size:20px;margin:24px 0 8px">Manage your subscription</h2>
    <p style="color:#8aacc8;font-size:15px;line-height:1.6">Click below to open your secure Stripe billing portal &mdash; update your payment method, view invoices, or cancel.</p>
    <p style="margin:24px 0"><a href="${url}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-weight:700;font-size:15px">Open Billing Portal</a></p>
    <p style="color:#506e8f;font-size:12px;line-height:1.6">This link is personal to you and expires shortly. If you didn't request it, you can safely ignore this email. Questions? Reply here or contact support@novo-aitrading.app.</p>
  </div></body></html>`;
}

module.exports = async (req, res) => {
  const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';
  res.setHeader('Access-Control-Allow-Origin', SITE);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop() || req.socket?.remoteAddress || '').trim() || 'unknown';
  if (_rateLimited(ip)) return res.status(429).json({ error: 'Too many requests — please wait a moment' });
  // Cross-instance shared rate limit (the per-lambda _rl above can't aggregate on Vercel). Fails open if KV unset. (audit #13)
  if (!(await require('./_kv').rateOk('portal:' + ip, 8, 60))) return res.status(429).json({ error: 'Too many requests — please wait a moment' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const email = (body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  // Email the portal link to the VERIFIED address rather than returning it in the response. This
  // closes the IDOR (anyone who merely knew a customer's email could otherwise open that customer's
  // billing portal and cancel their sub) and prevents account enumeration — the HTTP response is
  // the same generic message whether or not the email maps to a real customer.
  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length) {
      const portal = await stripe.billingPortal.sessions.create({
        customer: customers.data[0].id,
        return_url: `${SITE}/subscriber`,
      });
      await resend.emails.send({
        from: process.env.FROM_EMAIL || 'NoVo <orders@novo-aitrading.app>',
        replyTo: 'support@novo-aitrading.app',
        to: [email],
        subject: 'NoVo — Manage your subscription',
        html: portalEmailHtml(portal.url),
      });
    }
  } catch (err) {
    console.error('[subscriber-portal] Error:', err.message);
    // Fall through to the same generic response — never reveal whether the email exists.
  }

  return res.status(200).json({
    ok: true,
    message: 'If a subscription exists for that email, we just emailed it a secure link to manage your billing. Check your inbox (and spam).',
  });
};
