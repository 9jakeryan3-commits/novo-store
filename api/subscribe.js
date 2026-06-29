import { Resend } from 'resend';

// Newsletter signup for The NoVo Journal. Adds the email to a Resend audience when RESEND_AUDIENCE_ID is set
// (the proper list you can broadcast to); until then it emails the owner so no signup is ever lost.
// FROM is hardcoded to the verified domain — a gmail FROM 403s and silently kills all Resend sends.
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'NoVo <orders@novo-aitrading.app>';
const OWNER = 'novotrades26@gmail.com';
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
      try {
        await resend.contacts.create({ audienceId, email, unsubscribed: false });
      } catch (_) { /* already on the list — treat as success */ }
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
