const Stripe = require('stripe');
const crypto = require('crypto');
const { Resend } = require('resend');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

function deterministicKey(sessionId) {
  // Derived from the Stripe session id so retries always compute the same value —
  // the license server then makes the actual creation idempotent on this value.
  const token = crypto.createHmac('sha256', process.env.NOVO_LICENSE_SECRET)
    .update(`key:${sessionId}`).digest('hex').substring(0, 16).toUpperCase();
  const sig = crypto.createHmac('sha256', process.env.NOVO_LICENSE_SECRET)
    .update(token).digest('hex').substring(0, 8).toUpperCase();
  return `NOVO-${token.substring(0, 8)}-${token.substring(8)}-${sig}`;
}

async function registerKey(sessionId, email) {
  const key = deterministicKey(sessionId);
  const url = new URL(`${process.env.NOVO_LICENSE_SERVER_URL}/admin/keys`);
  url.searchParams.set('key', key);
  url.searchParams.set('note', email);
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'X-Admin-Key': process.env.LICENSE_ADMIN_KEY },
  });
  if (!resp.ok) {
    throw new Error(`License server returned ${resp.status}`);
  }
  const data = await resp.json();
  return data.key;
}

function emailHtml(licenseKey, zipUrl) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body{margin:0;padding:0;background:#0b1527;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .wrap{max-width:600px;margin:0 auto;padding:40px 20px}
  .logo{font-size:36px;font-weight:900;color:#eaf3ff;letter-spacing:-1px}
  .logo span{color:#3b82f6}
  .tag{font-size:11px;color:#8aacc8;letter-spacing:3px;text-transform:uppercase;margin-top:4px}
  hr{border:none;border-top:1px solid #1b2e4e;margin:28px 0}
  h2{color:#eaf3ff;font-size:20px;margin:0 0 8px}
  p{color:#8aacc8;font-size:15px;line-height:1.6;margin:0 0 16px}
  .key-box{background:#0e1c35;border:1px solid #1b2e4e;border-left:3px solid #3b82f6;border-radius:6px;padding:20px 24px;margin:24px 0}
  .key-label{font-size:11px;color:#8aacc8;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px}
  .key{font-family:'Courier New',monospace;font-size:20px;font-weight:700;color:#f59e0b;letter-spacing:2px}
  .steps{background:#0e1c35;border:1px solid #1b2e4e;border-radius:6px;padding:20px 24px;margin:24px 0}
  .step{display:flex;align-items:flex-start;margin-bottom:14px}
  .step-num{background:#3b82f6;color:#fff;font-size:11px;font-weight:700;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-right:12px;margin-top:2px}
  .step-text{color:#8aacc8;font-size:14px;line-height:1.5}
  .step-text strong{color:#eaf3ff}
  .btn{display:inline-block;background:#3b82f6;color:#fff!important;text-decoration:none;padding:14px 32px;border-radius:6px;font-weight:700;font-size:15px;margin:8px 0}
  .footer{margin-top:40px;padding-top:20px;border-top:1px solid #1b2e4e}
  .footer p{font-size:12px;color:#506e8f;margin:0}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">No<span>Vo</span></div>
  <div class="tag">v.fast &nbsp;·&nbsp; Algorithmic Execution System</div>
  <hr>
  <h2>You're in. Here's everything you need.</h2>
  <p>Payment confirmed. Your license key and download are below — read this once and you'll be running in under 20 minutes.</p>
  <div class="key-box">
    <div class="key-label">Your License Key</div>
    <div class="key">${licenseKey}</div>
  </div>
  <a href="${zipUrl}" class="btn">Download NoVo v.fast</a>
  <hr>
  <h2>Getting started</h2>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><div class="step-text">Unzip to exactly <strong>C:\\Trading Algo\\NoVo v.fast</strong></div></div>
    <div class="step"><div class="step-num">2</div><div class="step-text">Rename <strong>.env.template</strong> to <strong>.env</strong> — paste your license key as <strong>NOVO_LICENSE_KEY=</strong></div></div>
    <div class="step"><div class="step-num">3</div><div class="step-text">Right-click <strong>setup.ps1</strong> → Run as Administrator</div></div>
    <div class="step"><div class="step-num">4</div><div class="step-text">Open Chrome → <strong>https://&lt;your-tailscale-hostname&gt;:8000</strong> and log in</div></div>
    <div class="step"><div class="step-num">5</div><div class="step-text">Go to <strong>Settings</strong> and enter your broker and AI API keys</div></div>
    <div class="step"><div class="step-num">6</div><div class="step-text">Click <strong>Auth (Start)</strong> — NoVo is live</div></div>
  </div>
  <p>Full walkthrough in <strong>START&amp;TROUBLESHOOT.pdf</strong> inside the zip. The presentation guide explains how the system thinks and trades.</p>
  <p>Start in paper mode (default). Watch it run before switching to live.</p>
  <p>Any issues — email <a href="mailto:novotrades26@gmail.com">novotrades26@gmail.com</a> and I'll sort it out.</p>
  <div class="footer">
    <p>Not financial advice. For informational and educational use only. Your license key is machine-bound — email <a href="mailto:novotrades26@gmail.com">novotrades26@gmail.com</a> if you ever need to transfer to a new PC.</p>
  </div>
</div>
</body>
</html>`;
}

module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session?.customer_details?.email;

    if (!email) {
      console.error(`[webhook] No email for session ${session.id}`);
      return res.status(200).json({ received: true });
    }

    let licenseKey;
    try {
      licenseKey = await registerKey(session.id, email);
    } catch (err) {
      console.error(`[webhook] License server registration failed — session:${session.id} email:${email} error:${err.message}`);
      return res.status(500).json({ error: 'License registration failed' });
    }

    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL || 'NoVo <orders@novo-aitrading.app>',
        to: [email],
        subject: 'NoVo v.fast — Your Files + License Key',
        html: emailHtml(licenseKey, process.env.NOVO_ZIP_URL),
      });
    } catch (err) {
      // Key and buyer email logged here so you can resend manually via Vercel logs
      console.error(`[webhook] Email failed — session:${session.id} email:${email} key:${licenseKey} error:${err.message}`);
      return res.status(500).json({ error: 'Email delivery failed' });
    }
  }

  res.status(200).json({ received: true });
};
