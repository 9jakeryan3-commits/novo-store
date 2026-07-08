import { Resend } from 'resend';
import { put } from '@vercel/blob';

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

  const body = req.body || {};
  const title = (body.title || '').trim();
  const text = (body.text || '').trim();
  const html = (body.html || '').trim();
  const send = body.send !== false;                                    // default true
  const audience = (body.audience || 'analyst').toString().toLowerCase(); // 'analyst' | 'free' | 'both'
  const label = (body.label || 'NoVo Analyst').toString();             // dark-header sub-label
  const upsell = (body.upsell || 'pulse').toString().toLowerCase();    // 'pulse' | 'analyst'
  const chartB64 = (body.chart_b64 || '').toString().trim();           // optional session-chart PNG (base64)
  const bias = (body.bias || '').toString().trim();                    // BULLISH | BEARISH | NEUTRAL
  const levels = Array.isArray(body.levels) ? body.levels : [];        // [{label, price, kind}]
  const pill = (body.pill || '').toString().trim();                    // regime-alert pill text
  const pillKind = (body.pill_kind || '').toString().toLowerCase();    // amplify | absorb | warn | calm
  const kind = (body.kind || 'read').toString().toLowerCase();          // 'read' (full desk note) | 'alert' (intraday)
  if (!title || (!text && !html)) return res.status(400).json({ error: 'title + text/html required' });

  // Resolve target Resend audience(s): analyst = paid list, free = the newsletter list, both = each.
  const ANALYST_AUD = process.env.RESEND_ANALYST_AUDIENCE_ID;
  const FREE_AUD = process.env.RESEND_AUDIENCE_ID;
  const targets = [];
  if ((audience === 'analyst' || audience === 'both') && ANALYST_AUD) targets.push(ANALYST_AUD);
  if ((audience === 'free' || audience === 'both') && FREE_AUD) targets.push(FREE_AUD);
  if (!process.env.RESEND_API_KEY || targets.length === 0) {
    return res.status(503).json({ error: 'delivery not configured (RESEND_API_KEY / audience ids)' });
  }

  // send=false → archive-only (reserved for the /analyst web feed, phase 2). No-op email for now.
  if (!send) return res.status(200).json({ ok: true, archived: true, emailed: false });

  // Optional session chart → upload to Blob for a public URL (email clients need hosted images, not data URIs).
  let chartUrl = '';
  if (chartB64 && process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { url } = await put(`analyst/chart-${Date.now()}.png`, Buffer.from(chartB64, 'base64'),
        { access: 'public', contentType: 'image/png', token: process.env.BLOB_READ_WRITE_TOKEN });
      chartUrl = url;
    } catch (e) { console.error('[analyst-publish] chart upload failed:', e.message); }
  }

  // Structural-bias pill (dark) + a support/resistance levels table (replaces the old text KEY LEVELS).
  const _biasMap = { BULLISH:{bg:'rgba(16,185,129,0.12)',fg:'#34d399',bd:'rgba(16,185,129,0.45)'}, BEARISH:{bg:'rgba(239,68,68,0.12)',fg:'#f87171',bd:'rgba(239,68,68,0.45)'}, NEUTRAL:{bg:'rgba(148,163,184,0.12)',fg:'#b3c2d6',bd:'rgba(148,163,184,0.4)'} };
  const _bc = _biasMap[bias.toUpperCase()];
  const biasPill = _bc ? `<div style="margin:0 0 16px;"><span style="display:inline-block;background:${_bc.bg};color:${_bc.fg};border:1px solid ${_bc.bd};font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:5px 12px;border-radius:999px;">Structural Bias &middot; ${esc(bias.toUpperCase())}</span></div>` : '';
  const _pillMap = { amplify:{bg:'rgba(239,68,68,0.13)',fg:'#f87171',bd:'rgba(239,68,68,0.5)'}, warn:{bg:'rgba(245,158,11,0.13)',fg:'#fbbf24',bd:'rgba(245,158,11,0.5)'}, absorb:{bg:'rgba(41,98,255,0.16)',fg:'#6ea8fe',bd:'rgba(41,98,255,0.5)'}, calm:{bg:'rgba(16,185,129,0.12)',fg:'#34d399',bd:'rgba(16,185,129,0.45)'} };
  const _pc = _pillMap[pillKind] || _pillMap.warn;
  const alertPill = pill ? `<div style="margin:0 0 16px;"><span style="display:inline-block;background:${_pc.bg};color:${_pc.fg};border:1px solid ${_pc.bd};font-size:11.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;padding:6px 14px;border-radius:999px;">&#9889; Regime &middot; ${esc(pill)}</span></div>` : '';
  let levelsTable = '';
  if (levels.length) {
    const fmt = p => Number(p).toFixed(2);
    const res = levels.filter(l => l.kind === 'resistance').sort((a,b)=>a.price-b.price);
    const sup = levels.filter(l => l.kind === 'support').sort((a,b)=>b.price-a.price);
    const rowsHtml = (items, col) => (items.length ? items : [null]).map(l =>
      l ? `<tr><td style="padding:6px 12px;color:#9fb6d1;font-size:13px;border-top:1px solid #1c2c47;">${esc(l.label)}</td><td style="padding:6px 12px;text-align:right;font-weight:700;color:${col};font-size:13px;border-top:1px solid #1c2c47;">${fmt(l.price)}</td></tr>`
        : `<tr><td style="padding:6px 12px;color:#6f8bab;font-size:13px;">&mdash;</td><td></td></tr>`).join('');
    const colCell = (t, items, col) =>
      `<td style="vertical-align:top;width:50%;padding:0 5px;"><div style="border:1px solid #1c2c47;border-top:2px solid ${col};border-radius:8px;overflow:hidden;"><div style="background:#12203a;padding:7px 12px;font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:${col};">${t}</div><table style="width:100%;border-collapse:collapse;">${rowsHtml(items,col)}</table></div></td>`;
    levelsTable = `<div style="margin:24px 0 8px;font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#eaf3ff;">Key Levels</div><table style="width:100%;border-collapse:separate;border-spacing:0;"><tr>${colCell('Resistance',res,'#f87171')}${colCell('Support',sup,'#34d399')}</tr></table>`;
  }

  // ── Also fan out to Discord (best-effort) as a rich embed. Alerts -> #novo-alerts, full reads -> #novo-analysis.
  const discordWebhook = (kind === 'alert' && process.env.DISCORD_ALERTS_WEBHOOK)
    ? process.env.DISCORD_ALERTS_WEBHOOK
    : process.env.DISCORD_ANALYST_WEBHOOK;
  if (discordWebhook) {
    try {
      const biasColor = { BULLISH: 0x10b981, BEARISH: 0xf43f5e, NEUTRAL: 0x9fb6d1 };
      const pillColor = { amplify: 0xf43f5e, absorb: 0x2962ff, warn: 0xf59e0b, calm: 0x10b981 };
      let color = 0x22d3ee;
      if (bias && biasColor[bias.toUpperCase()] != null) color = biasColor[bias.toUpperCase()];
      else if (pill && pillColor[pillKind] != null) color = pillColor[pillKind];
      let desc = text.replace(/(^|\n)(THE READ|KEY LEVELS|STRUCTURAL POSTURE|WHAT TO WATCH|WHAT CHANGED|WHAT IT MEANS)/g, '$1**$2**');
      if (desc.length > 4000) desc = desc.slice(0, 3990) + '…';
      const fields = [];
      if (bias) fields.push({ name: 'Structural Bias', value: bias.toUpperCase(), inline: true });
      if (pill) fields.push({ name: 'Regime', value: pill, inline: true });
      if (Array.isArray(levels) && levels.length) {
        const line = arr => arr.map(l => `${l.label} — **${Number(l.price).toFixed(2)}**`).join('\n');
        const res = line(levels.filter(l => l.kind === 'resistance').sort((a, b) => a.price - b.price));
        const sup = line(levels.filter(l => l.kind === 'support').sort((a, b) => b.price - a.price));
        if (res) fields.push({ name: '🔴 Resistance', value: res, inline: true });
        if (sup) fields.push({ name: '🟢 Support', value: sup, inline: true });
      }
      const embed = {
        author: { name: label || 'NoVo Analyst', icon_url: 'https://novo-aitrading.app/novo-icon.png?v=4' },
        title, description: desc, color, fields,
        footer: { text: 'NoVo — market analysis & education, not trade signals.' },
        timestamp: new Date().toISOString(),
      };
      if (chartUrl) embed.image = { url: chartUrl };
      await fetch(discordWebhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'NoVo Analyst', avatar_url: 'https://novo-aitrading.app/novo-icon.png?v=4', embeds: [embed] }),
      });
    } catch (e) { console.error('[analyst-publish] discord post failed:', e.message); }
  }

  // Institutional, NoVo-branded DARK HTML email. Absolute image URL (email clients require it); the dark
  // session chart blends into the dark card. Bolded desk-note labels, audience-aware upsell, unsubscribe.
  const bodyText = esc(text).replace(/(^|\n)(THE READ|KEY LEVELS|STRUCTURAL POSTURE|WHAT TO WATCH|WHAT CHANGED|WHAT IT MEANS)/g,
    '$1<b style="color:#22d3ee">$2</b>');
  // Audience-aware upsell. The FREE list gets the requested upsell (Analyst for the Weekly); the PAID Analyst
  // list already HAS Analyst, so it's never pitched back to them — they get the Pulse upsell instead. Chosen
  // per-audience inside the send loop below (the Weekly goes to 'both'), so no one is sold what they own.
  const buildUpsell = (u) => u === 'analyst'
    ? '<div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Want the daily read?</div>' +
      '<div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;">This weekly outlook is the taste. <b style="color:#eaf3ff">NoVo Analyst</b> adds the daily <b style="color:#eaf3ff">Open</b> &amp; <b style="color:#eaf3ff">Close</b> desk notes plus intraday regime-shift alerts — $39/mo. <a href="https://novo-aitrading.app/analyst" style="color:#34d399;font-weight:700;text-decoration:none;">Get NoVo Analyst &rarr;</a></div>'
    : '<div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Want it raw &amp; live?</div>' +
      '<div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;">This is the read. <b style="color:#eaf3ff">NoVo Pulse</b> is the machine — the same read, live, executing in your own broker account within your rules. <a href="https://novo-aitrading.app" style="color:#34d399;font-weight:700;text-decoration:none;">See NoVo Pulse &rarr;</a></div>';
  const renderBody = (upsellHtml) => html || (
    '<div style="margin:0;padding:0;background:#070b12;">' +
      '<div style="max-width:600px;margin:0 auto;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">' +
        '<div style="background:#0a1120;border:1px solid #1c2c47;border-bottom:0;border-radius:12px 12px 0 0;padding:22px 24px;text-align:center;">' +
          '<img src="https://novo-aitrading.app/novo-logo-light.png?v=1" alt="NoVo AI Trading" height="30" style="height:30px;width:auto;display:inline-block;border:0;">' +
          `<div style="margin-top:9px;font-size:10.5px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22d3ee;">${esc(label)}</div>` +
        '</div>' +
        '<div style="background:#0f1a2e;border:1px solid #1c2c47;border-top:0;border-radius:0 0 12px 12px;padding:28px 28px 24px;">' +
          (chartUrl ? `<img src="${chartUrl}" width="552" style="width:100%;max-width:552px;height:auto;border-radius:8px;border:1px solid #1c2c47;display:block;margin:0 0 20px;" alt="SPY session chart — levels &amp; structure">` : '') +
          `<h1 style="font-size:20px;font-weight:800;color:#eaf3ff;letter-spacing:-.3px;margin:0 0 12px;line-height:1.25;">${esc(title)}</h1>` +
          biasPill + alertPill +
          `<div style="font-size:15px;line-height:1.7;color:#c2d2e6;white-space:pre-wrap;">${bodyText}</div>` +
          levelsTable +
          `<div style="margin-top:26px;border:1px solid #1c2c47;border-left:3px solid #10b981;border-radius:8px;padding:16px 18px;background:rgba(16,185,129,0.06);">${upsellHtml}</div>` +
          '<p style="font-size:11.5px;color:#6f8bab;line-height:1.6;margin:20px 0 0;">Market analysis &amp; education only — not financial advice, and not trade signals. Trading involves substantial risk of loss.</p>' +
        '</div>' +
        '<div style="text-align:center;font-size:11px;color:#6f8bab;padding:14px 8px;">You are subscribed to NoVo email updates. <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#6f8bab;text-decoration:underline;">Unsubscribe</a></div>' +
      '</div>' +
    '</div>'
  );

  try {
    const ids = [];
    for (const aud of targets) {
      // Paid Analyst subscribers already HAVE Analyst — never pitch it back; upsell them to Pulse instead.
      const effUpsell = (aud === ANALYST_AUD) ? 'pulse' : upsell;
      const bodyHtml = renderBody(buildUpsell(effUpsell));
      const bc = await resend.broadcasts.create({ audienceId: aud, from: FROM, subject: title, html: bodyHtml });
      const bcId = bc?.data?.id || bc?.id;
      if (bcId) { await resend.broadcasts.send(bcId); ids.push(bcId); }
    }
    if (ids.length === 0) return res.status(500).json({ error: 'no broadcast created' });
    return res.status(200).json({ ok: true, emailed: true, audiences: ids.length, broadcastIds: ids });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
