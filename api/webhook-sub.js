const Stripe = require('stripe');
const { Resend } = require('resend');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const LICENSE_SERVER = (process.env.NOVO_LICENSE_SERVER_URL || '').replace(/\/$/, '');
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY;
const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';

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

async function activateSub(subscriptionId) {
  return licensePost(`/admin/subscription/${subscriptionId}/activate`, {});
}

async function suspendSub(subscriptionId) {
  return licensePost(`/admin/subscription/${subscriptionId}/suspend`, {});
}

async function cancelSub(subscriptionId) {
  return licensePost(`/admin/subscription/${subscriptionId}/cancel`, {});
}

function welcomeEmailHtml() {
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
  .steps{background:#0e1c35;border:1px solid #1b2e4e;border-radius:6px;padding:20px 24px;margin:24px 0}
  .step{display:flex;align-items:flex-start;margin-bottom:14px}
  .step-num{background:#10b981;color:#fff;font-size:11px;font-weight:700;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-right:12px;margin-top:2px}
  .step-text{color:#8aacc8;font-size:14px;line-height:1.5}
  .step-text strong{color:#eaf3ff}
  .btn{display:inline-block;background:#10b981;color:#fff!important;text-decoration:none;padding:14px 32px;border-radius:6px;font-weight:700;font-size:15px;margin:8px 4px}
  .notice{background:#0e1c35;border:1px solid #1b2e4e;border-left:3px solid #f59e0b;border-radius:6px;padding:14px 18px;margin:20px 0;font-size:13px;color:#8aacc8;line-height:1.6}
  .notice strong{color:#f59e0b}
  .footer{margin-top:40px;padding-top:20px;border-top:1px solid #1b2e4e}
  .footer p{font-size:12px;color:#506e8f;margin:0}
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">No<span>Vo</span></div>
  <div class="tag">NoVo Pulse — Autonomous Trading</div>
  <hr>
  <h2>Welcome to NoVo Pulse — you're all set.</h2>
  <p>Your subscription is active. Head to your portal to finish setup and open your dashboard — you'll be up and running in minutes.</p>
  <a href="https://app.novo-aitrading.app" class="btn">Open Your Portal</a>
  <hr>
  <h2>Getting started</h2>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><div class="step-text">Go to <strong>app.novo-aitrading.app</strong> and create your account using <strong>this email address</strong></div></div>
    <div class="step"><div class="step-num">2</div><div class="step-text">Connect your <strong>Tradier + Alpaca</strong> keys — validated against the brokers and encrypted</div></div>
    <div class="step"><div class="step-num">3</div><div class="step-text">Your private dashboard goes live automatically — AI pre-configured, <strong>paper trading immediately</strong></div></div>
    <div class="step"><div class="step-num">4</div><div class="step-text">Open it in any browser, or install it as an app on your desktop or phone</div></div>
  </div>
  <p>Start in paper mode (the default) and watch it run before switching to live.</p>
  <div class="notice">
    <strong>Auto-renewing:</strong> Your subscription renews automatically (monthly or yearly, whichever you chose). Manage your billing or cancel any time from your portal at <a href="https://app.novo-aitrading.app" style="color:#3b82f6;">app.novo-aitrading.app</a>.
  </div>
  <p>Questions? Just reply, or email <a href="mailto:support@novo-aitrading.app">support@novo-aitrading.app</a>.</p>
  <div class="footer">
    <p>Not financial advice. Trading involves substantial risk of loss. Your access is active while your subscription is current.</p>
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
    if (!email) {
      console.error(`[webhook-sub] Missing email — session:${obj.id}`);
      return res.status(200).json({ received: true });
    }

    // Hosted model: no license key, no download. The control plane recognizes the subscription by the
    // customer's email (Stripe is the source of truth); this email just welcomes them to the portal.
    try {
      await resend.emails.send({
        from: process.env.FROM_EMAIL || 'NoVo <orders@novo-aitrading.app>',
        replyTo: 'support@novo-aitrading.app',
        to: [email],
        subject: 'Welcome to NoVo Pulse — open your portal',
        html: welcomeEmailHtml(),
      });
    } catch (err) {
      console.error(`[webhook-sub] Welcome email failed — error:${err.message}`);
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
