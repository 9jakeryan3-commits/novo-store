import { Resend } from 'resend';

// Newsletter signup for The NoVo Journal. Adds the email to a Resend audience when RESEND_AUDIENCE_ID is set
// (the proper list you can broadcast to); until then it emails the owner so no signup is ever lost.
// FROM is hardcoded to the verified domain — a gmail FROM 403s and silently kills all Resend sends.
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'NoVo <orders@novo-aitrading.app>';
const OWNER = 'novotrades26@gmail.com';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Per-IP rate limit — each signup fires a Resend contact-create + a welcome email, so an unthrottled endpoint
// is an email-bomb / quota-burn vector (a tripped Resend quota silently kills ALL broadcasts). 5/min/IP is
// ample for real humans (they sign up once).
const _rl = new Map();
function _rateLimited(ip, max = 5) {
  const now = Date.now();
  const rec = _rl.get(ip) || { n: 0, reset: now + 60000 };
  if (now > rec.reset) { _rl.set(ip, { n: 1, reset: now + 60000 }); return false; }
  rec.n++; _rl.set(ip, rec);
  return rec.n > max;
}

// Free Market Notes welcome — confirms the signup, invites them to the free Discord community, and upsells
// Analyst (private read channels). The Discord block only renders when DISCORD_INVITE_URL is set.
function freeWelcomeHtml(invite) {
  return `<div style="margin:0;padding:0;background:#070b12;">
  <div style="max-width:560px;margin:0 auto;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#0a1120;border:1px solid #1c2c47;border-bottom:0;border-radius:12px 12px 0 0;padding:22px 24px;text-align:center;">
      <img src="https://novo-aitrading.app/novo-logo-light.png?v=1" alt="NoVo AI Trading" height="30" style="height:30px;width:auto;display:inline-block;border:0;">
      <div style="margin-top:9px;font-size:10.5px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22d3ee;">Market Notes</div>
    </div>
    <div style="background:#0f1a2e;border:1px solid #1c2c47;border-top:0;border-radius:0 0 12px 12px;padding:30px 30px 26px;">
      <h1 style="color:#eaf3ff;font-size:22px;font-weight:800;margin:0 0 14px;letter-spacing:-.3px;">You're on the list.</h1>
      <p style="color:#c2d2e6;line-height:1.65;font-size:15px;margin:0 0 14px;">You'll get <b style="color:#eaf3ff">The Week Ahead</b> every Sunday &mdash; NoVo's structural read on the week's key levels, catalysts, and market regime &mdash; plus the occasional note. Free, always.</p>
      ${invite ? `<div style="margin:18px 0 6px;border:1px solid #2b2f57;border-left:3px solid #5865F2;border-radius:8px;padding:16px 18px;background:rgba(88,101,242,0.08);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Join the NoVo Discord &mdash; free</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;margin-bottom:12px;">Talk markets in the community channels and see what NoVo's tracking. Free to join &mdash; no card.</div>
        <a href="${invite}" style="display:inline-block;background:#5865F2;color:#ffffff;font-weight:800;font-size:13.5px;padding:11px 22px;border-radius:8px;text-decoration:none;">Join the Discord &rarr;</a>
      </div>` : ''}
      <div style="margin-top:16px;border:1px solid #1c2c47;border-left:3px solid #22d3ee;border-radius:8px;padding:16px 18px;background:rgba(34,211,238,0.06);">
        <div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Want the daily read?</div>
        <div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;"><b style="color:#eaf3ff">NoVo Analyst</b> ($49/mo) adds The Open + The Close every session, intraday regime alerts, and the <b style="color:#eaf3ff">private read channels</b> in the Discord. <a href="https://novo-aitrading.app/analyst" style="color:#22d3ee;font-weight:700;text-decoration:none;">See NoVo Analyst &rarr;</a></div>
      </div>
      <p style="font-size:11.5px;color:#6f8bab;line-height:1.6;margin:20px 0 0;">Market analysis &amp; education only &mdash; not financial advice, not trade signals. Unsubscribe anytime from any email.</p>
    </div>
  </div>
</div>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (_rateLimited(_ip)) return res.status(429).json({ error: 'Too many requests — try again in a minute.' });

  let email = '';
  try { email = (req.body && req.body.email ? String(req.body.email) : '').trim().toLowerCase(); } catch { email = ''; }
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ error: 'Signups are temporarily unavailable.' });
  }

  try {
    const audienceId = process.env.RESEND_AUDIENCE_ID;
    if (audienceId) {
      // Idempotent: a returning/duplicate subscriber must not surface an error to the visitor.
      let isNew = false;
      try {
        await resend.contacts.create({ audienceId, email, unsubscribed: false });
        isNew = true;
      } catch (_) { /* already on the list — treat as success, skip re-welcoming */ }
      // Welcome the new subscriber (Discord + Analyst upsell). Best-effort — never block the signup.
      if (isNew) {
        try {
          await resend.emails.send({
            from: FROM, to: [email], replyTo: 'support@novo-aitrading.app',
            subject: 'Welcome to NoVo Market Notes',
            html: freeWelcomeHtml(process.env.DISCORD_INVITE_URL || 'https://discord.gg/EfnPJ5gC5w'),
          });
        } catch (_) { /* welcome email is non-fatal */ }
      }
    } else {
      await resend.emails.send({
        from: FROM,
        to: [OWNER],
        subject: 'New NoVo Journal subscriber',
        text: `New subscriber: ${email}\n\nTip: create an Audience in Resend and set RESEND_AUDIENCE_ID in Vercel to collect these into a real list automatically.`,
      });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
}
