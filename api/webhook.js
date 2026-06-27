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
  // Send key/note in a JSON body (not query params) so the buyer's email never lands in access logs.
  const resp = await fetch(`${process.env.NOVO_LICENSE_SERVER_URL}/admin/keys`, {
    method: 'POST',
    headers: { 'X-Admin-Key': process.env.LICENSE_ADMIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, note: email }),
  });
  if (!resp.ok) {
    throw new Error(`License server returned ${resp.status}`);
  }
  const data = await resp.json();
  // created !== false: a brand-new key returns created:true; a replay (key already exists) returns
  // created:false. Default to true if an older server omits the field, so we never suppress a real email.
  return { key: data.key, created: data.created !== false };
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
  <div class="tag">Algorithmic Execution System</div>
  <hr>
  <h2>You're in. Here's everything you need.</h2>
  <p>Payment confirmed. Your license key and download are below — read this once and you'll be running in under 20 minutes.</p>
  <div class="key-box">
    <div class="key-label">Your License Key</div>
    <div class="key">${licenseKey}</div>
  </div>
  <a href="${zipUrl}" class="btn">Download NoVo</a>
  <hr>
  <h2>Read these first</h2>
  <p>Open the zip and read the included guides before running anything:</p>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><div class="step-text"><strong>Risk Disclaimer</strong> — required reading before using the system</div></div>
    <div class="step"><div class="step-num">2</div><div class="step-text"><strong>Start &amp; Troubleshoot</strong> — full setup walkthrough, account requirements, and troubleshooting</div></div>
    <div class="step"><div class="step-num">3</div><div class="step-text"><strong>Presentation Guide</strong> — how NoVo thinks, trades, and every dashboard panel explained</div></div>
  </div>
  <hr>
  <h2>Setup</h2>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><div class="step-text">Unzip to exactly <strong>C:\\NoVo</strong></div></div>
    <div class="step"><div class="step-num">2</div><div class="step-text">Double-click <strong>Install NoVo</strong> → click Yes on the Windows prompt — it handles everything and will ask for your license key</div></div>
    <div class="step"><div class="step-num">3</div><div class="step-text">Open Chrome → <strong>http://localhost:8000</strong> and log in, or use your permanent remote URL printed at the end of setup</div></div>
    <div class="step"><div class="step-num">4</div><div class="step-text">Go to <strong>Settings</strong> and enter your broker and AI API keys</div></div>
    <div class="step"><div class="step-num">5</div><div class="step-text">Click <strong>Auth (Start)</strong> — NoVo is live</div></div>
  </div>
  <p>Start in paper mode (default). Watch it run before switching to live.</p>
  <p>Any issues — email <a href="mailto:support@novo-aitrading.app">support@novo-aitrading.app</a> and I'll sort it out.</p>
  <div class="footer">
    <p>Not financial advice. For informational and educational use only. Your license key is machine-bound — email <a href="mailto:support@novo-aitrading.app">support@novo-aitrading.app</a> if you ever need to transfer to a new PC.</p>
  </div>
</div>
</body>
</html>`;
}

// Stripe signature verification needs the EXACT raw bytes. Depending on how Vercel
// delivers the body, req.body may be a Buffer, a string, or (if bodyParser:false is
// honored) absent with the stream still readable. Resolve all three; only a parsed
// object would be unrecoverable, in which case constructEvent fails loudly anyway.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function rawBodyOf(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  return await readRawBody(req);
}

const handler = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await rawBodyOf(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed' && event.data.object?.mode === 'payment') {
    const session = event.data.object;
    const email = session?.customer_details?.email;

    if (!email) {
      console.error(`[webhook] No email for session ${session.id}`);
      return res.status(200).json({ received: true });
    }

    let reg;
    try {
      reg = await registerKey(session.id, email);
    } catch (err) {
      console.error(`[webhook] License server registration failed — session:${session.id} error:${err.message}`);
      return res.status(500).json({ error: 'License registration failed' });
    }
    const licenseKey = reg.key;
    // Stripe delivers events at-least-once; on a replay the key already exists (created:false) and we
    // must NOT re-send the welcome email. The key registration above is idempotent regardless.
    if (!reg.created) {
      console.log(`[webhook] Duplicate checkout event for session ${session.id} — key already issued; skipping email.`);
      return res.status(200).json({ received: true, deduped: true });
    }

    const zipUrl = process.env.NOVO_ZIP_URL;
    if (!zipUrl) {
      console.error(`[webhook] NOVO_ZIP_URL not set — session:${session.id}`);
      return res.status(500).json({ error: 'Download URL not configured' });
    }

    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL || 'NoVo <orders@novo-aitrading.app>',
        replyTo: 'support@novo-aitrading.app',
        to: [email],
        subject: 'NoVo — Your Files + License Key',
        html: emailHtml(licenseKey, zipUrl),
      });
    } catch (err) {
      // Key and buyer email logged here so you can resend manually via Vercel logs
      console.error(`[webhook] Email failed — session:${session.id} error:${err.message}`);
      return res.status(500).json({ error: 'Email delivery failed' });
    }
  }

  res.status(200).json({ received: true });
};

handler.config = { api: { bodyParser: false } };
module.exports = handler;
