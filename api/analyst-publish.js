import { Resend } from 'resend';

// NoVo Analyst — receives a SCRUBBED market report from the engine and broadcasts it to the paid
// "Analyst" Resend audience (email). Dormant (503) until RESEND_ANALYST_AUDIENCE_ID +
// ANALYST_PUBLISH_SECRET are set. The engine decides cadence (send=true for the morning/EOD/alert
// reports; send=false = archive-only for the future /analyst web feed). Auth = shared secret header.
//
// IMPORTANT: this only ever receives reports the engine already scrubbed (no apex/GEX/floor/tuning) —
// it is market ANALYSIS/education, never tradeable "buy X" signals.

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.ANALYST_FROM_EMAIL || 'The NoVo Journal <analyst@novo-aitrading.app>';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.ANALYST_PUBLISH_SECRET;
  if (!secret || req.headers['x-analyst-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const audienceId = process.env.RESEND_ANALYST_AUDIENCE_ID;
  if (!process.env.RESEND_API_KEY || !audienceId) {
    return res.status(503).json({ error: 'Analyst delivery not configured (RESEND_API_KEY / RESEND_ANALYST_AUDIENCE_ID)' });
  }

  const body = req.body || {};
  const title = (body.title || '').trim();
  const text = (body.text || '').trim();
  const html = (body.html || '').trim();
  const send = body.send !== false; // default true
  if (!title || (!text && !html)) return res.status(400).json({ error: 'title + text/html required' });

  // send=false → archive-only (reserved for the /analyst web feed, phase 2). No-op email for now.
  if (!send) return res.status(200).json({ ok: true, archived: true, emailed: false });

  // Render the scrubbed report as a clean email (preserve line breaks; the report is plain text).
  const bodyHtml = html || (
    '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:600px;margin:0 auto;color:#14181d">' +
    `<div style="font-size:11px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#b7132a">The NoVo Journal · Analyst</div>` +
    `<h2 style="font-size:20px;color:#0b2942;margin:6px 0 14px">${esc(title)}</h2>` +
    `<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13.5px;line-height:1.6;color:#3d4652;margin:0">${esc(text)}</pre>` +
    '<hr style="border:none;border-top:1px solid #e4ded4;margin:22px 0">' +
    '<p style="font-size:12px;color:#6b7480;line-height:1.6">Market analysis & education only — not financial advice, not trade signals. Trading involves substantial risk of loss. ' +
    'Want this raw and live, executed in your own account? <a href="https://novo-aitrading.app" style="color:#0b2942">NoVo Pulse →</a></p>' +
    '<p style="font-size:11px;color:#9aa6b2">You get this because you subscribe to NoVo Analyst. {{{RESEND_UNSUBSCRIBE_URL}}}</p>' +
    '</div>'
  );

  try {
    const bc = await resend.broadcasts.create({
      audienceId,
      from: FROM,
      subject: title,
      html: bodyHtml,
    });
    const bcId = bc?.data?.id || bc?.id;
    if (!bcId) return res.status(500).json({ error: 'broadcast create returned no id', raw: JSON.stringify(bc).slice(0, 200) });
    await resend.broadcasts.send(bcId);
    return res.status(200).json({ ok: true, emailed: true, broadcastId: bcId });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
