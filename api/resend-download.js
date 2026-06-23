const Stripe = require('stripe');
const crypto = require('crypto');
const { Resend } = require('resend');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';

// Same derivation as webhook-sub.js — must stay in sync
function deterministicKey(subscriptionId) {
  const token = crypto.createHmac('sha256', process.env.NOVO_LICENSE_SECRET)
    .update(`sub:${subscriptionId}`).digest('hex').substring(0, 16).toUpperCase();
  const sig = crypto.createHmac('sha256', process.env.NOVO_LICENSE_SECRET)
    .update(token).digest('hex').substring(0, 8).toUpperCase();
  return `NOVS-${token.substring(0, 8)}-${token.substring(8)}-${sig}`;
}

// Per-email cooldown: 1 resend per 10 minutes
const _cooldowns = new Map();
function _onCooldown(email) {
  const ts = _cooldowns.get(email) || 0;
  if (Date.now() - ts < 10 * 60 * 1000) return true;
  _cooldowns.set(email, Date.now());
  return false;
}

const _rl = new Map();
function _rateLimited(ip) {
  const now = Date.now();
  const rec = _rl.get(ip) || { n: 0, reset: now + 60000 };
  if (now > rec.reset) { _rl.set(ip, { n: 1, reset: now + 60000 }); return false; }
  rec.n++;
  _rl.set(ip, rec);
  return rec.n > 3;
}

function emailHtml(licenseKey, zipUrl) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body{margin:0;padding:0;background:#0b1527;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .wrap{max-width:600px;margin:0 auto;padding:40px 20px}
  .logo{font-size:36px;font-weight:900;color:#eaf3ff;letter-spacing:-1px}
  .logo span{color:#10b981}
  .tag{font-size:11px;color:#8aacc8;letter-spacing:3px;text-transform:uppercase;margin-top:4px}
  hr{border:none;border-top:1px solid #1b2e4e;margin:28px 0}
  h2{color:#eaf3ff;font-size:20px;margin:0 0 8px}
  p{color:#8aacc8;font-size:15px;line-height:1.6;margin:0 0 16px}
  .key-box{background:#0e1c35;border:1px solid #1b2e4e;border-left:3px solid #10b981;border-radius:6px;padding:20px 24px;margin:24px 0}
  .key-label{font-size:11px;color:#8aacc8;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px}
  .key{font-family:'Courier New',monospace;font-size:20px;font-weight:700;color:#f59e0b;letter-spacing:2px}
  .btn{display:inline-block;background:#10b981;color:#fff!important;text-decoration:none;padding:14px 32px;border-radius:6px;font-weight:700;font-size:15px;margin:8px 4px}
  .footer p{font-size:12px;color:#506e8f;margin:0}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">No<span>Vo</span></div>
  <div class="tag">Subscription — Re-download</div>
  <hr>
  <h2>Your download link and license key.</h2>
  <p>Requested via <a href="${SITE}/subscriber" style="color:#3b82f6;">${SITE}/subscriber</a>. Your subscription is active.</p>
  <div class="key-box">
    <div class="key-label">Your License Key</div>
    <div class="key">${licenseKey}</div>
  </div>
  <a href="${zipUrl}" class="btn">Download NoVo Pulse</a>
  <p style="margin-top:20px;">Unzip to <strong style="color:#eaf3ff;">C:\\NoVo</strong>, double-click <strong style="color:#eaf3ff;">Install NoVo.bat</strong> and click Yes on the Windows prompt. Full walkthrough in <strong style="color:#eaf3ff;">2. Start &amp; Troubleshoot.pdf</strong>.</p>
  <hr>
  <div class="footer"><p>Manage or cancel your subscription at <a href="${SITE}/subscriber" style="color:#3b82f6;">${SITE}/subscriber</a>. Questions? Reply to this email or contact novotrades26@gmail.com.</p></div>
</div>
</body>
</html>`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', SITE);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (_rateLimited(ip)) return res.status(429).json({ error: 'Too many requests — please wait a moment' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const email = (body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  if (_onCooldown(email)) {
    return res.status(429).json({ error: 'Download email already sent — check your inbox (including spam). Wait 10 minutes before requesting again.' });
  }

  try {
    // Find Stripe customer
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) {
      return res.status(404).json({ error: 'No subscription found for that email. Check for typos, or contact novotrades26@gmail.com.' });
    }
    const customerId = customers.data[0].id;

    // Confirm active subscription
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
    if (!subs.data.length) {
      return res.status(403).json({ error: 'No active subscription found for that email. If you believe this is an error, contact novotrades26@gmail.com.' });
    }

    const subId = subs.data[0].id;
    const licenseKey = deterministicKey(subId);
    const zipUrl = process.env.NOVO_SUB_ZIP_URL;

    if (!zipUrl) {
      console.error('[resend-download] NOVO_SUB_ZIP_URL not configured');
      return res.status(500).json({ error: 'Download URL not configured — contact novotrades26@gmail.com.' });
    }

    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'NoVo <orders@novo-aitrading.app>',
      replyTo: 'novotrades26@gmail.com',
      to: [email],
      subject: 'NoVo — Your Download Link',
      html: emailHtml(licenseKey, zipUrl),
    });

    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('[resend-download] Error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again or contact novotrades26@gmail.com.' });
  }
};
