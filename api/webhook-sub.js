const Stripe = require('stripe');
const crypto = require('crypto');
const { Resend } = require('resend');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const LICENSE_SERVER = (process.env.NOVO_LICENSE_SERVER_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY;
const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';

// NOVS- prefix distinguishes subscription keys from NOVO- one-time keys
function deterministicKey(subscriptionId) {
  const token = crypto.createHmac('sha256', process.env.NOVO_LICENSE_SECRET)
    .update(`sub:${subscriptionId}`).digest('hex').substring(0, 16).toUpperCase();
  const sig = crypto.createHmac('sha256', process.env.NOVO_LICENSE_SECRET)
    .update(token).digest('hex').substring(0, 8).toUpperCase();
  return `NOVS-${token.substring(0, 8)}-${token.substring(8)}-${sig}`;
}

// Stripe moved the invoice's subscription id to invoice.parent.subscription_details.subscription
// in its 2025 API versions; older versions use the top-level invoice.subscription. Read whichever
// is present so suspend-on-failure / reactivate-on-payment always fire regardless of API version.
function invoiceSubId(inv) {
  return inv?.subscription || inv?.parent?.subscription_details?.subscription || null;
}

async function licensePost(path, body) {
  const res = await fetch(`${LICENSE_SERVER}${path}`, {
    method: 'POST',
    headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`License server ${path} → ${res.status}`);
  return res.json();
}

async function createSubLicense(key, subscriptionId, email) {
  return licensePost('/admin/keys/sub', {
    key,
    stripe_subscription_id: subscriptionId,
    note: email,
  });
}

async function activateSub(subscriptionId) {
  return licensePost(`/admin/subscription/${subscriptionId}/activate`, {});
}

async function suspendSub(subscriptionId) {
  return licensePost(`/admin/subscription/${subscriptionId}/suspend`, {});
}

async function cancelSub(subscriptionId) {
  return licensePost(`/admin/subscription/${subscriptionId}/cancel`, {});
}

function welcomeEmailHtml(licenseKey, zipUrl) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
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
  .steps{background:#0e1c35;border:1px solid #1b2e4e;border-radius:6px;padding:20px 24px;margin:24px 0}
  .step{display:flex;align-items:flex-start;margin-bottom:14px}
  .step-num{background:#10b981;color:#fff;font-size:11px;font-weight:700;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-right:12px;margin-top:2px}
  .step-text{color:#8aacc8;font-size:14px;line-height:1.5}
  .step-text strong{color:#eaf3ff}
  .btn{display:inline-block;background:#10b981;color:#fff!important;text-decoration:none;padding:14px 32px;border-radius:6px;font-weight:700;font-size:15px;margin:8px 4px}
  .btn-outline{display:inline-block;background:transparent;color:#3b82f6!important;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;font-size:14px;border:1px solid #1b2e4e;margin:8px 4px}
  .notice{background:#0e1c35;border:1px solid #1b2e4e;border-left:3px solid #f59e0b;border-radius:6px;padding:14px 18px;margin:20px 0;font-size:13px;color:#8aacc8;line-height:1.6}
  .notice strong{color:#f59e0b}
  .footer{margin-top:40px;padding-top:20px;border-top:1px solid #1b2e4e}
  .footer p{font-size:12px;color:#506e8f;margin:0}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">No<span>Vo</span></div>
  <div class="tag">Subscription — Algorithmic Execution System</div>
  <hr>
  <h2>Subscription active. Here's everything you need.</h2>
  <p>Your NoVo Pulse is live. License key, download link, and setup steps are all below — you can be running in under 20 minutes.</p>
  <div class="key-box">
    <div class="key-label">Your License Key</div>
    <div class="key">${licenseKey}</div>
  </div>
  <a href="${zipUrl}" class="btn">Download NoVo Pulse</a>
  <a href="${SITE}/subscriber" class="btn-outline">Manage Subscription</a>
  <div class="notice">
    <strong>Auto-renewing:</strong> Your subscription renews automatically on your billing cycle (monthly or yearly, whichever you chose). To update your payment method, cancel, or re-download at any time, visit <a href="${SITE}/subscriber" style="color:#3b82f6;">${SITE}/subscriber</a> and enter this email address.
  </div>
  <hr>
  <h2>Read these first</h2>
  <p>Open the zip and read the three PDFs before running anything:</p>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><div class="step-text"><strong>1. Risk Disclaimer.pdf</strong> — required reading before using the system</div></div>
    <div class="step"><div class="step-num">2</div><div class="step-text"><strong>2. Start &amp; Troubleshoot.pdf</strong> — full setup walkthrough, account requirements, and troubleshooting</div></div>
    <div class="step"><div class="step-num">3</div><div class="step-text"><strong>3. Presentation Guide.pdf</strong> — how NoVo thinks, trades, and every dashboard panel explained</div></div>
  </div>
  <hr>
  <h2>Setup</h2>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><div class="step-text">Unzip to exactly <strong>C:\\NoVo</strong></div></div>
    <div class="step"><div class="step-num">2</div><div class="step-text">Double-click <strong>Install NoVo</strong> → click Yes on the Windows prompt — it handles everything and will ask for your license key</div></div>
    <div class="step"><div class="step-num">3</div><div class="step-text">Open Chrome → <strong>http://localhost:8000</strong> and log in, or use your permanent remote URL printed at the end of setup</div></div>
    <div class="step"><div class="step-num">4</div><div class="step-text">Go to <strong>Settings</strong> and enter your Tradier and Alpaca keys — AI is already configured, no AI provider key needed</div></div>
    <div class="step"><div class="step-num">5</div><div class="step-text">Click <strong>Auth (Start)</strong> — NoVo is live</div></div>
  </div>
  <p>Start in paper mode (default). Watch it run before switching to live.</p>
  <p>Any issues — email <a href="mailto:novotrades26@gmail.com">novotrades26@gmail.com</a> and I'll sort it out.</p>
  <div class="footer">
    <p>Not financial advice. For informational and educational use only. Your license key is machine-bound and active while your subscription is current. Manage or cancel at <a href="${SITE}/subscriber" style="color:#3b82f6;">${SITE}/subscriber</a>.</p>
  </div>
</div>
</body>
</html>`;
}

// Stripe signature verification needs the EXACT raw bytes. req.body may arrive as a
// Buffer, a string, or (with bodyParser:false honored) be absent with the stream still
// readable — resolve all three so verification works regardless of Vercel's delivery.
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
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_SUB_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const obj = event.data.object;

  // ── New subscription checkout completed ───────────────────────────────────
  if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
    const email = obj?.customer_details?.email;
    const subscriptionId = obj?.subscription;

    if (!email || !subscriptionId) {
      console.error(`[webhook-sub] Missing email or subscription ID — session:${obj.id}`);
      return res.status(200).json({ received: true });
    }

    const licenseKey = deterministicKey(subscriptionId);

    try {
      await createSubLicense(licenseKey, subscriptionId, email);
    } catch (err) {
      console.error(`[webhook-sub] License create failed — sub:${subscriptionId} error:${err.message}`);
      return res.status(500).json({ error: 'License creation failed' });
    }

    const zipUrl = process.env.NOVO_SUB_ZIP_URL;
    if (!zipUrl) {
      console.error(`[webhook-sub] NOVO_SUB_ZIP_URL not set — sub:${subscriptionId}`);
      return res.status(500).json({ error: 'Download URL not configured' });
    }

    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL || 'NoVo <orders@novo-aitrading.app>',
        replyTo: 'novotrades26@gmail.com',
        to: [email],
        subject: 'NoVo Pulse — Your Files + License Key',
        html: welcomeEmailHtml(licenseKey, zipUrl),
      });
    } catch (err) {
      console.error(`[webhook-sub] Email failed — sub:${subscriptionId} error:${err.message}`);
      return res.status(500).json({ error: 'Email delivery failed' });
    }
  }

  // ── Monthly renewal payment succeeded → re-activate if suspended ─────────
  else if (event.type === 'invoice.payment_succeeded') {
    const subscriptionId = invoiceSubId(obj);
    // Reactivate on ANY successful invoice payment (not just billing_reason ===
    // 'subscription_cycle') — a recovered past-due payment can carry a different
    // reason, and gating on it could leave a paying customer suspended forever.
    // activateSub is idempotent: a no-op on the initial create / already-active keys,
    // and the license row may not exist yet on the very first invoice (404, swallowed).
    if (subscriptionId) {
      try {
        await activateSub(subscriptionId);
      } catch (err) {
        console.error(`[webhook-sub] Activate failed — sub:${subscriptionId} error:${err.message}`);
      }
    }
  }

  // ── Payment failed → suspend access ──────────────────────────────────────
  else if (event.type === 'invoice.payment_failed') {
    const subscriptionId = invoiceSubId(obj);
    if (subscriptionId) {
      try {
        await suspendSub(subscriptionId);
      } catch (err) {
        console.error(`[webhook-sub] Suspend failed — sub:${subscriptionId} error:${err.message}`);
      }
    }
  }

  // ── Subscription cancelled → revoke access ────────────────────────────────
  else if (event.type === 'customer.subscription.deleted') {
    const subscriptionId = obj?.id;
    if (subscriptionId) {
      try {
        await cancelSub(subscriptionId);
      } catch (err) {
        console.error(`[webhook-sub] Cancel failed — sub:${subscriptionId} error:${err.message}`);
      }
    }
  }

  return res.status(200).json({ received: true });
};

handler.config = { api: { bodyParser: false } };
module.exports = handler;
