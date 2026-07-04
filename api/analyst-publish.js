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

  // Institutional, NoVo-branded HTML email. Absolute image URL (email clients require it); dark header bar
  // with the light wordmark logo, light content area, bolded desk-note section labels, Pulse upsell, unsub.
  const bodyText = esc(text).replace(/(^|\n)(THE READ|KEY LEVELS|STRUCTURAL POSTURE|WHAT TO WATCH)/g,
    '$1<b style="color:#0b2942">$2</b>');
  const bodyHtml = html || (
    '<div style="margin:0;padding:0;background:#eef2f7;">' +
      '<div style="max-width:600px;margin:0 auto;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">' +
        '<div style="background:#0a1120;border-radius:12px 12px 0 0;padding:22px 24px;text-align:center;">' +
          '<img src="https://novo-aitrading.app/novo-logo-light.png?v=1" alt="NoVo AI Trading" height="30" style="height:30px;width:auto;display:inline-block;border:0;">' +
          '<div style="margin-top:9px;font-size:10.5px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22d3ee;">NoVo Analyst</div>' +
        '</div>' +
        '<div style="background:#ffffff;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 12px 12px;padding:28px 28px 24px;">' +
          `<h1 style="font-size:20px;font-weight:800;color:#0b2942;letter-spacing:-.3px;margin:0 0 16px;line-height:1.25;">${esc(title)}</h1>` +
          `<div style="font-size:15px;line-height:1.7;color:#1f2937;white-space:pre-wrap;">${bodyText}</div>` +
          '<div style="margin-top:26px;border:1px solid #d7e0ea;border-left:3px solid #10b981;border-radius:8px;padding:16px 18px;background:#f6fbf8;">' +
            '<div style="font-size:14px;color:#0b2942;font-weight:700;margin-bottom:4px;">Want it raw &amp; live?</div>' +
            '<div style="font-size:13.5px;color:#475569;line-height:1.55;">This is the read. <b>NoVo Pulse</b> is the machine — the same read, live, executing in your own broker account within your rules. <a href="https://novo-aitrading.app" style="color:#0b9d6f;font-weight:700;text-decoration:none;">See NoVo Pulse &rarr;</a></div>' +
          '</div>' +
          '<p style="font-size:11.5px;color:#94a3b8;line-height:1.6;margin:20px 0 0;">Market analysis &amp; education only — not financial advice, and not trade signals. Trading involves substantial risk of loss.</p>' +
        '</div>' +
        '<div style="text-align:center;font-size:11px;color:#9aa6b2;padding:14px 8px;">You receive this as a NoVo Analyst subscriber. <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#9aa6b2;text-decoration:underline;">Unsubscribe</a></div>' +
      '</div>' +
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
