import { Resend } from 'resend';
import { put, list, del } from '@vercel/blob';
import crypto from 'node:crypto';
import Stripe from 'stripe';
import webpush from 'web-push';

const _stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

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

const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';

// Constant-time secret check for the owner-only publish/delete auth (avoids a timing side-channel; also the
// single source of truth for the header check on both POST and DELETE).
function _secretOk(provided) {
  const secret = process.env.ANALYST_PUBLISH_SECRET;
  if (!secret || !provided) return false;
  const a = Buffer.from(String(provided)); const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Per-instance IP rate limiter — a backstop on the write endpoints so a leaked secret can't fan out unlimited
// broadcasts/archive-deletes in a burst. Generous (60/min) so the engine's own publishes + Line alerts never trip it.
const _rl = new Map();
function _rateLimited(ip, max = 60) {
  const now = Date.now();
  const rec = _rl.get(ip) || { n: 0, reset: now + 60000 };
  if (now > rec.reset) { _rl.set(ip, { n: 1, reset: now + 60000 }); return false; }
  rec.n++; _rl.set(ip, rec);
  return rec.n > max;
}

// ── Members live-view: stateless HMAC access token + an unguessable live-state blob path + a Stripe sub check ──
const _LIVE_SECRET = () => process.env.ANALYST_LIVE_SECRET || process.env.ANALYST_PUBLISH_SECRET || '';
// The live state is a PUBLIC Vercel blob (Hobby has no private blobs), so its PATH is derived from the secret
// (SHA-256) — deterministic for the server, unguessable for anyone else → the raw URL can't be scraped.
function _liveBlobKey() {
  const s = _LIVE_SECRET();
  if (!s) return 'analyst-live/state.json';
  return 'analyst-live/' + crypto.createHash('sha256').update('livestate:' + s).digest('hex').slice(0, 40) + '.json';
}
function _signToken(email, days = 7) {   // 7-day TTL bounds post-cancel access (was 30); re-login is a one-click magic link
  const secret = _LIVE_SECRET();
  if (!secret || !email) return '';
  const payload = Buffer.from(JSON.stringify({ e: String(email).toLowerCase(), x: Date.now() + days * 86400000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function _verifyToken(token) {
  try {
    const secret = _LIVE_SECRET();
    if (!secret || !token) return null;
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig) return null;
    const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!obj || !obj.x || Date.now() > obj.x) return null;
    return obj.e;
  } catch { return null; }
}
async function _activePaidSub(email) {   // active/trialing/past_due Stripe sub (Analyst OR Trader) → member access
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) return false;
  const hasSub = async (custId) => {
    const subs = await _stripe.subscriptions.list({ customer: custId, status: 'all', limit: 20 });
    return subs.data.some(s => ['active', 'trialing', 'past_due'].includes(s.status));
  };
  try {
    // NOTE: customers.list({email}) matches the email EXACTLY (case-sensitive), but customers are
    // routinely stored with different casing than the login input (e.g. "Novotrades26@gmail.com" vs a
    // lowercased "novotrades26@..."). Stripe Search's email index IS case-insensitive, so use it as the
    // primary lookup; fall back to list() for a customer created seconds ago (Search is eventually consistent).
    const seen = new Set();
    try {
      const sr = await _stripe.customers.search({ query: `email:"${norm.replace(/"/g, '')}"`, limit: 20 });
      for (const c of sr.data) { seen.add(c.id); if (await hasSub(c.id)) return true; }
    } catch (_) { /* search index warming up or unavailable — fall through to list() */ }
    const custs = await _stripe.customers.list({ email: norm, limit: 100 });
    for (const c of custs.data) { if (!seen.has(c.id) && await hasSub(c.id)) return true; }
  } catch (e) { console.error('[analyst-live] sub check:', e.message); }
  return false;
}

// ── PUBLIC ARCHIVE (served here as GET so it doesn't add a 13th serverless function — Hobby cap is 12) ──
async function _loadJson(prefix, token) {
  try {
    const { blobs } = await list({ prefix, token });
    if (blobs && blobs[0]) { const r = await fetch(blobs[0].url); if (r.ok) return await r.json(); }
  } catch (_) {}
  return null;
}
// Fallback for the members live view when there's no fresh live read (weekends / between sessions): serve the
// most recent archived desk note so "Today's read" is never a blank card. Cached ~5 min to avoid per-poll blob reads.
let _latestReadCache = { at: 0, read: null };
async function _latestArchivedRead(token) {
  const now = Date.now();
  if (_latestReadCache.read && (now - _latestReadCache.at) < 300000) return _latestReadCache.read;
  if (!token) return null;
  try {
    const idx = await _loadJson('analyst-archive/index.json', token);
    if (!Array.isArray(idx) || !idx.length) return null;
    // ONLY fall back to real PAID desk notes (The Open / Close / Week Ahead). NEVER the Mid-Day Tape Review —
    // it's a conversion/sales email to the FREE list (upsell framing, no full dealer map), not paid content.
    const DESK = /-(the-open|the-close|the-week-ahead)$/;
    const desks = idx.filter(e => e && typeof e.slug === 'string' && DESK.test(e.slug));
    if (!desks.length) return null;
    // members see the most recent desk note regardless of the public-archive publishAfter delay
    const top = desks.slice().sort((a, b) => (b.createdAt || b.publishAfter || 0) - (a.createdAt || a.publishAfter || 0))[0];
    const rd = await _loadJson(`analyst-archive/reads/${top.slug}.json`, token);
    const read = rd ? { title: rd.title, text: rd.text, dateLabel: rd.dateLabel, stale: true } : null;
    _latestReadCache = { at: now, read };
    return read;
  } catch (_) { return null; }
}
function _biasPill(bias) {
  if (!bias) return '';
  const m = { BULLISH: ['rgba(16,185,129,0.12)', '#34d399', 'rgba(16,185,129,0.45)'], BEARISH: ['rgba(239,68,68,0.12)', '#f87171', 'rgba(239,68,68,0.45)'], NEUTRAL: ['rgba(148,163,184,0.12)', '#b3c2d6', 'rgba(148,163,184,0.4)'] }[String(bias).toUpperCase()];
  if (!m) return '';
  return `<span class="pill" style="background:${m[0]};color:${m[1]};border:1px solid ${m[2]};">Structural Bias &middot; ${esc(String(bias).toUpperCase())}</span>`;
}
function _levelsTable(levels) {
  if (!Array.isArray(levels) || !levels.length) return '';
  const fmt = p => Number(p).toFixed(2);
  const rs = levels.filter(l => l.kind === 'resistance').sort((a, b) => a.price - b.price);
  const sp = levels.filter(l => l.kind === 'support').sort((a, b) => b.price - a.price);
  const rows = (items, c) => (items.length ? items : [null]).map(l => l
    ? `<tr><td style="padding:6px 12px;color:#9fb6d1;font-size:13px;border-top:1px solid #1c2c47;">${esc(l.label)}</td><td style="padding:6px 12px;text-align:right;font-weight:700;color:${c};font-size:13px;border-top:1px solid #1c2c47;">${fmt(l.price)}</td></tr>`
    : '<tr><td style="padding:6px 12px;color:#6f8bab;font-size:13px;">&mdash;</td><td></td></tr>').join('');
  const col = (t, items, c) => `<td style="vertical-align:top;width:50%;padding:0 5px;"><div style="border:1px solid #1c2c47;border-top:2px solid ${c};border-radius:8px;overflow:hidden;"><div style="background:#12203a;padding:7px 12px;font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:${c};">${t}</div><table style="width:100%;border-collapse:collapse;">${rows(items, c)}</table></div></td>`;
  return `<div style="margin:24px 0 8px;font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#eaf3ff;">Key Levels</div><table style="width:100%;border-collapse:separate;border-spacing:0;"><tr>${col('Resistance', rs, '#f87171')}${col('Support', sp, '#34d399')}</tr></table>`;
}
function _page(t, desc, canon, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(canon)}"><meta property="og:title" content="${esc(t)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="article"><meta property="og:site_name" content="NoVo AI Trading"><link rel="icon" href="${SITE}/favicon.ico">
<style>*{box-sizing:border-box;}body{margin:0;background:#070b12;color:#c2d2e6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;}a{color:#22d3ee;text-decoration:none;}.wrap{max-width:760px;margin:0 auto;padding:28px 20px 80px;}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:34px;flex-wrap:wrap;}.brand img{height:26px;width:auto;display:block;}.cta{background:linear-gradient(180deg,#22d3ee,#3b82f6);color:#04121a;font-weight:800;font-size:13.5px;padding:10px 20px;border-radius:9px;white-space:nowrap;}h1{color:#eaf3ff;font-size:clamp(26px,4.5vw,34px);letter-spacing:-1px;line-height:1.15;margin:2px 0 10px;}.kicker{font-size:11px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#22d3ee;}.muted{color:#6f8bab;font-size:13px;}.lead{color:#9fb6d1;font-size:15.5px;max-width:640px;}.card{background:#0f1a2e;border:1px solid #1c2c47;border-radius:12px;padding:26px;margin:22px 0;}.body{white-space:pre-wrap;font-size:16px;color:#c2d2e6;}.body b{color:#22d3ee;font-weight:700;}.pill{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:5px 12px;border-radius:999px;margin:0 0 6px;}img.chart{width:100%;border-radius:8px;border:1px solid #1c2c47;display:block;margin:0 0 20px;}ul.rows{list-style:none;padding:0;margin:26px 0 0;}ul.rows li{border:1px solid #1c2c47;border-radius:11px;padding:18px 20px;margin-bottom:14px;background:#0c1526;}ul.rows a.rt{color:#eaf3ff;font-weight:800;font-size:18px;letter-spacing:-.3px;}.subcta{background:rgba(34,211,238,0.06);border:1px solid rgba(34,211,238,0.28);border-radius:12px;padding:26px;text-align:center;margin-top:36px;}.subcta a{background:linear-gradient(180deg,#22d3ee,#3b82f6);color:#04121a;font-weight:800;padding:12px 28px;border-radius:10px;display:inline-block;margin-top:14px;}.disc{font-size:11.5px;color:#6f8bab;margin-top:30px;line-height:1.6;}</style></head><body><div class="wrap">
<div class="top"><a class="brand" href="${SITE}/analyst"><img src="${SITE}/novo-logo-light.png?v=1" alt="NoVo AI Trading"></a><a class="cta" href="${SITE}/analyst">Get it live &mdash; free 7-day trial</a></div>
${inner}
<div class="disc">Market analysis &amp; education only &mdash; not financial advice, and not trade signals. Trading involves substantial risk of loss.</div>
</div></body></html>`;
}
async function handleArchive(req, res) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const slug = (req.query && req.query.slug ? String(req.query.slug) : '').replace(/[^a-z0-9-]/gi, '').slice(0, 80);
  const now = Date.now();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');
  if (!token) {
    return res.status(200).send(_page('NoVo Analyst — Archive', 'Past NoVo Analyst market reads.', `${SITE}/analyst/archive`,
      '<div class="kicker">The Archive</div><h1>Past reads are on the way.</h1><p class="lead">The archive fills automatically as each desk note publishes. <a href="' + SITE + '/analyst">Get the live read &rarr;</a></p>'));
  }
  if (slug) {
    const rd = await _loadJson(`analyst-archive/reads/${slug}.json`, token);
    if (!rd || (rd.publishAfter && now < rd.publishAfter)) {
      return res.status(404).send(_page('Not available yet — NoVo Analyst', 'This read has not been released to the public archive yet.', `${SITE}/analyst/archive`,
        '<div class="kicker">NoVo Analyst</div><h1>Not released yet.</h1><p class="lead">This read hasn\'t hit the public archive yet &mdash; subscribers already have it live. <a href="' + SITE + '/analyst">Start a free 7-day trial &rarr;</a></p><p style="margin-top:20px;"><a href="' + SITE + '/analyst/archive">&larr; Browse released reads</a></p>'));
    }
    const bt = esc(rd.text || '').replace(/(^|\n)(THE READ|KEY LEVELS|STRUCTURAL POSTURE|WHAT TO WATCH|WHAT CHANGED|WHAT IT MEANS|BOTTOM LINE|THE SETUP|THE RECAP|TOMORROW'S SETUP|THE WEEK AHEAD|CATALYSTS|SCENARIOS|LEVELS TO WATCH|FLOW DYNAMICS|EVENT PLAYBOOK|DEALER POSITIONING MAP|DEALER POSITIONING)/g, '$1<b>$2</b>');
    const desc = (rd.text || '').replace(/\s+/g, ' ').slice(0, 155);
    const inner = `<article><div class="muted">${esc(rd.dateLabel || '')} &middot; NoVo Analyst</div><h1>${esc(rd.title)}</h1>${_biasPill(rd.bias)}<div class="card">${rd.chartUrl ? `<img class="chart" src="${esc(rd.chartUrl)}" alt="SPY session chart — levels &amp; structure" onerror="this.style.display='none'">` : ''}<div class="body">${bt}</div>${_levelsTable(rd.levels)}</div><div class="subcta"><div style="color:#eaf3ff;font-weight:800;font-size:19px;">This read landed hours ago for subscribers.</div><div class="muted" style="margin-top:6px;max-width:520px;margin-left:auto;margin-right:auto;">The Open, The Close, and The Week Ahead hit your inbox before the bell &mdash; plus real-time &lsquo;The Line&rsquo; level-break alerts in Discord.</div><a href="${SITE}/analyst">Start a 7-day free trial &rarr;</a></div><p style="margin-top:24px;"><a href="${SITE}/analyst/archive">&larr; All past reads</a></p></article>`;
    return res.status(200).send(_page(`${rd.title} — NoVo Analyst`, desc, `${SITE}/analyst/archive/${slug}`, inner));
  }
  let idx = await _loadJson('analyst-archive/index.json', token);
  if (!Array.isArray(idx)) idx = [];
  const pub = idx.filter(e => !e.publishAfter || now >= e.publishAfter).sort((a, b) => (b.publishAfter || 0) - (a.publishAfter || 0));
  const rows = pub.length
    ? pub.map(e => `<li><a class="rt" href="${SITE}/analyst/archive/${esc(e.slug)}">${esc(e.title)}</a><div class="muted" style="margin:4px 0 8px;">${esc(e.dateLabel || '')}</div><div style="font-size:14px;color:#9fb6d1;">${esc(e.excerpt || '')}&hellip;</div></li>`).join('')
    : '<p class="muted" style="margin-top:24px;">Past reads will appear here after each session.</p>';
  const inner = `<div class="kicker">The Archive</div><h1>NoVo Analyst &mdash; past market reads</h1><p class="lead">Every morning desk note, closing read, and week-ahead outlook &mdash; SPY dealer positioning, the gamma flip, the levels that matter, and what to watch. Released here after each session; <a href="${SITE}/analyst">subscribers get them live before the bell &rarr;</a></p><ul class="rows">${rows}</ul><div class="subcta"><div style="color:#eaf3ff;font-weight:800;font-size:19px;">Get these live, not delayed.</div><div class="muted" style="margin-top:6px;">The read desks pay hundreds for, in your inbox before the bell &mdash; $49/mo, 7-day free trial.</div><a href="${SITE}/analyst">Start a 7-day free trial &rarr;</a></div>`;
  return res.status(200).send(_page('NoVo Analyst — Archive of SPY market reads', 'Past NoVo Analyst desk notes: SPY dealer positioning, gamma levels, structural bias, and what to watch — released after each session.', `${SITE}/analyst/archive`, inner));
}

export default async function handler(req, res) {
  // Members live-view feed (token-gated) — the /analyst/live dashboard polls this every few seconds.
  if (req.method === 'GET' && req.query && 'live' in req.query) {
    const email = _verifyToken(req.query.t || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, ''));
    if (!email) return res.status(401).json({ error: 'unauthorized' });
    res.setHeader('Cache-Control', 'no-store');
    const state = await _loadJson(_liveBlobKey(), process.env.BLOB_READ_WRITE_TOKEN) || { updated_at: 0, indices: [], stale: true };
    // Never show a blank "Today's read": fall back to the most recent archived desk note when there's no live one.
    if (!state.read || !state.read.text) {
      const fb = await _latestArchivedRead(process.env.BLOB_READ_WRITE_TOKEN);
      if (fb) state.read = fb;
    }
    return res.status(200).json(state);
  }
  // VAPID public key for the members dashboard to subscribe to Web Push (empty until configured → button stays hidden).
  if (req.method === 'GET' && req.query && req.query.push === 'key') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ key: process.env.ANALYST_VAPID_PUBLIC || '' });
  }
  // Members' email-reads preference (token-gated): is the signed-in member subscribed to the Analyst
  // broadcast audience? Returns { email_optin }. Defaults to opted-in when it can't be determined.
  if (req.method === 'GET' && req.query && 'prefs' in req.query) {
    const email = _verifyToken(req.query.t || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, ''));
    if (!email) return res.status(401).json({ error: 'unauthorized' });
    res.setHeader('Cache-Control', 'no-store');
    let email_optin = true;
    try {
      const aud = process.env.RESEND_ANALYST_AUDIENCE_ID;
      if (aud) {
        const g = await resend.contacts.get({ audienceId: aud, email });
        const d = g && g.data;
        if (d && typeof d.unsubscribed === 'boolean') email_optin = !d.unsubscribed;
      }
    } catch (_) {}
    return res.status(200).json({ email_optin });
  }

  if (req.method === 'GET') return handleArchive(req, res);

  // Rate-limit the write endpoints (defense-in-depth on the shared-secret auth).
  const _ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (_rateLimited(_ip)) return res.status(429).json({ error: 'rate limited' });

  // Toggle the signed-in member's email-reads subscription (token-gated). Flips the Resend contact's
  // `unsubscribed` flag; adds them to the audience if opting in and not already present. Best-effort.
  if (req.method === 'POST' && req.query && 'prefs' in req.query) {
    let email = '', want = true;
    try { const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); email = _verifyToken(String(b.token || '')); want = !!b.email_optin; } catch (_) {}
    if (!email) return res.status(401).json({ error: 'unauthorized' });
    const aud = process.env.RESEND_ANALYST_AUDIENCE_ID;
    if (aud) {
      try {
        let id = null;
        try { const g = await resend.contacts.get({ audienceId: aud, email }); id = g && g.data && g.data.id; } catch (_) {}
        if (id) await resend.contacts.update({ audienceId: aud, id, unsubscribed: !want });
        else if (want) await resend.contacts.create({ audienceId: aud, email, unsubscribed: false });
      } catch (e) { console.error('[prefs] email toggle:', e.message); }
    }
    return res.status(200).json({ ok: true, email_optin: want });
  }

  // Magic-link login for the members live view — verify an active sub, email a signed access link. ALWAYS
  // returns ok (never reveals whether an email has a sub); only sends the link when a paid sub is active.
  if (req.method === 'POST' && req.query && 'login' in req.query) {
    let email = '', cs = '';
    try { const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); email = String(b.email || '').trim().toLowerCase(); cs = String(b.cs || '').trim(); } catch (_) {}
    // Post-checkout welcome flow: resolve the paid email from a Stripe Checkout Session id instead of
    // asking the just-subscribed user to re-type it, so the magic link is waiting in their inbox.
    if (!email && cs && /^cs_[A-Za-z0-9_]+$/.test(cs)) {
      try {
        const sess = await _stripe.checkout.sessions.retrieve(cs);
        email = String(sess?.customer_details?.email || sess?.customer_email || '').trim().toLowerCase();
      } catch (_) {}
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email.' });
    try {
      if (await _activePaidSub(email)) {
        const link = `${SITE}/analyst/live?t=${encodeURIComponent(_signToken(email))}`;
        await resend.emails.send({
          from: FROM, to: [email], replyTo: 'support@novo-aitrading.app',
          subject: 'Your NoVo Analyst live dashboard link',
          html: `<div style="margin:0;padding:0;background:#070b12;"><div style="max-width:520px;margin:0 auto;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;"><div style="background:#0f1a2e;border:1px solid #1c2c47;border-radius:12px;padding:28px;"><div style="font-size:10.5px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22d3ee;margin-bottom:10px;">NoVo Analyst &middot; Live</div><h1 style="color:#eaf3ff;font-size:20px;margin:0 0 12px;">Your live dashboard is ready.</h1><p style="color:#9fb6d1;font-size:14px;line-height:1.6;margin:0 0 20px;">The live SPY / QQQ / SPX dealer map &mdash; net GEX, walls, Zero-Gamma, expected move, skew &mdash; updating through the session. This link keeps you signed in for 7 days.</p><a href="${link}" style="display:inline-block;background:linear-gradient(180deg,#22d3ee,#3b82f6);color:#04121a;font-weight:800;font-size:14px;padding:12px 26px;border-radius:9px;text-decoration:none;">Open the live dashboard &rarr;</a><p style="font-size:11.5px;color:#6f8bab;line-height:1.6;margin:22px 0 0;">If you didn't request this, ignore it. Market analysis &amp; education only &mdash; not financial advice, not trade signals.</p></div></div></div>`,
        });
      }
    } catch (e) { console.error('[analyst-live] login:', e.message); }
    return res.status(200).json({ ok: true });
  }

  // Save a signed-in member's device push subscription (member-token auth, NOT the owner secret). Stored at an
  // unguessable (endpoint-hashed) public blob path; the send fan-out lists them by prefix (server-token only).
  if (req.method === 'POST' && req.query && req.query.push === 'subscribe') {
    let tokenV = '', sub = null;
    try { const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); tokenV = String(b.token || ''); sub = b.sub || null; } catch (_) {}
    if (!_verifyToken(tokenV)) return res.status(401).json({ error: 'unauthorized' });
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });
    const BT = process.env.BLOB_READ_WRITE_TOKEN;
    if (!BT) return res.status(200).json({ ok: true });   // nothing to persist to yet — don't error the client
    try {
      const key = 'analyst-push/' + crypto.createHash('sha256').update(String(sub.endpoint)).digest('hex').slice(0, 40) + '.json';
      await put(key, JSON.stringify({ sub, at: Date.now() }),
        { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token: BT });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // DELETE — pull a bad read from the public archive (blob + index entry). Same shared-secret auth as POST.
  //   DELETE /api/analyst-publish?slug=YYYY-MM-DD-the-close   (x-analyst-secret header)
  if (req.method === 'DELETE') {
    if (!_secretOk(req.headers['x-analyst-secret'])) return res.status(401).json({ error: 'unauthorized' });
    const BT = process.env.BLOB_READ_WRITE_TOKEN;
    if (!BT) return res.status(500).json({ error: 'no blob token' });
    const slug = (req.query && req.query.slug ? String(req.query.slug) : '').replace(/[^a-z0-9-]/gi, '').slice(0, 80);
    if (!slug) return res.status(400).json({ error: 'slug required' });
    try {
      // #2/#4 fix (2026-07-10): update the INDEX FIRST (and only if we genuinely loaded it), THEN delete the
      // read blob. Two guards:
      //  - idxLoaded gates the index rewrite so a transient index-fetch failure can't write an empty [] and
      //    WIPE the whole archive listing (the old code initialized idx=[] and wrote it back on any fetch throw).
      //  - deleting the blob AFTER the successful index put means a mid-op failure leaves a live blob with no
      //    index entry (invisible-but-harmless), never a dangling index link to a deleted read.
      let idx = null, idxLoaded = false;
      try {
        const { blobs: ib } = await list({ prefix: 'analyst-archive/index.json', token: BT });
        if (ib && ib[0]) { const r = await fetch(ib[0].url); if (r.ok) { idx = await r.json(); idxLoaded = true; } }
        else { idx = []; idxLoaded = true; }   // no index blob yet = empty is the true state, safe to write
      } catch (_) { idxLoaded = false; }
      let removed = 0;
      if (idxLoaded && Array.isArray(idx)) {
        removed = idx.some(e => e.slug === slug) ? 1 : 0;
        // Verify-and-retry to survive a concurrent index write (the lost-update race): remove → write → re-read;
        // if a concurrent writer clobbered us and the slug reappeared, re-apply. Bounded to 3 attempts.
        for (let attempt = 0; attempt < 3; attempt++) {
          idx = idx.filter(e => e.slug !== slug);
          await put('analyst-archive/index.json', JSON.stringify(idx),
            { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token: BT });
          const check = await _loadJson('analyst-archive/index.json', BT);
          if (!Array.isArray(check) || !check.some(e => e.slug === slug)) break;   // gone → done
          idx = check;   // a concurrent writer re-added it; loop and remove again
        }
      }
      let blobsDeleted = 0;
      // Only delete the read blob if the index was actually updated (idxLoaded). If a transient index fetch/list
      // failure skipped the rewrite, deleting the blob would leave the slug in the index pointing at a missing read
      // (a dangling 404) — so leave the blob in place; the delete self-heals on a retry once the index loads.
      if (idxLoaded) {
        const { blobs } = await list({ prefix: `analyst-archive/reads/${slug}.json`, token: BT });
        if (blobs && blobs.length) { await del(blobs.map(b => b.url), { token: BT }); blobsDeleted = blobs.length; }
      }
      return res.status(200).json({ ok: true, deleted: slug, blobsDeleted, removedFromIndex: removed, indexUpdated: idxLoaded });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!_secretOk(req.headers['x-analyst-secret'])) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Live-state save — the engine POSTs the current SPY/QQQ/SPX dealer state (secret-auth) for the members
  // dashboard. Stored at the unguessable, secret-derived blob path; overwrites each cycle.
  if (req.body && typeof req.body === 'object' && req.body.kind === 'live-state') {
    const BT = process.env.BLOB_READ_WRITE_TOKEN;
    if (!BT) return res.status(500).json({ error: 'no blob token' });
    try {
      await put(_liveBlobKey(), JSON.stringify(req.body.state || {}),
        { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token: BT });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  const body = req.body || {};
  const title = (body.title || '').trim();
  const text = (body.text || '').trim();
  // SECURITY: never render client-supplied HTML. The engine only ever sends `text` (already scrubbed) and
  // relies on the server template below. Accepting body.html would let a leaked secret broadcast arbitrary
  // markup to the whole audience, bypassing the scrub/format contract — so it is deliberately ignored.
  const html = '';
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
  const archive = body.archive !== false;                               // false = don't add to the public reads archive (e.g. the Mid-Day sales email)
  if (!title || (!text && !html)) return res.status(400).json({ error: 'title + text/html required' });

  // Resolve target Resend audience(s): analyst = paid list, free = the newsletter list, both = each.
  const ANALYST_AUD = process.env.RESEND_ANALYST_AUDIENCE_ID;
  const FREE_AUD = process.env.RESEND_AUDIENCE_ID;
  const targets = [];
  if ((audience === 'analyst' || audience === 'both') && ANALYST_AUD) targets.push(ANALYST_AUD);
  if ((audience === 'free' || audience === 'both') && FREE_AUD) targets.push(FREE_AUD);
  // Only block on missing EMAIL config when we're actually emailing (send=true). Discord-only alerts
  // ('The Line', kind='alert', send=false) and archive-only reads must still reach Discord / the archive even
  // if the Resend audience is ever unset — the Discord webhook is configured independently of Resend.
  if (send && (!process.env.RESEND_API_KEY || targets.length === 0)) {
    return res.status(503).json({ error: 'delivery not configured (RESEND_API_KEY / audience ids)' });
  }

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
  // Alerts (kind=alert) ALWAYS fan out to Discord — they're Discord-only now (engine sends them send=false).
  // Full reads only hit Discord when they're also emailed (send=true); archive-only reads stay silent.
  if (discordWebhook && (kind === 'alert' || send)) {
    try {
      const biasColor = { BULLISH: 0x10b981, BEARISH: 0xf43f5e, NEUTRAL: 0x9fb6d1 };
      const pillColor = { amplify: 0xf43f5e, absorb: 0x2962ff, warn: 0xf59e0b, calm: 0x10b981 };
      let color = 0x22d3ee;
      if (bias && biasColor[bias.toUpperCase()] != null) color = biasColor[bias.toUpperCase()];
      else if (pill && pillColor[pillKind] != null) color = pillColor[pillKind];
      const _boldRe = /(^|\n)(THE READ|KEY LEVELS|STRUCTURAL POSTURE|WHAT TO WATCH|WHAT CHANGED|WHAT IT MEANS|BOTTOM LINE|THE SETUP|THE RECAP|TOMORROW'S SETUP|THE WEEK AHEAD|CATALYSTS|SCENARIOS|LEVELS TO WATCH|FLOW DYNAMICS|EVENT PLAYBOOK|DEALER POSITIONING MAP|DEALER POSITIONING)/g;
      const _bold = s => s.replace(_boldRe, '$1**$2**');
      const _cap = s => (s.length > 4096 ? s.slice(0, 4086) + '…' : s);
      // Split the LLM prose from the appended DETERMINISTIC blocks (Event Playbook / Dealer Map / Flow) into two
      // embeds so a long read (Weekly / OPEX) can never truncate the exact figures — each embed gets its own
      // 4096 budget. Alerts have no appended data → single embed (unchanged).
      let _splitAt = -1;
      for (const _mk of ['\nEVENT PLAYBOOK', '\nDEALER POSITIONING MAP']) {
        const _i = text.indexOf(_mk);
        if (_i >= 0 && (_splitAt < 0 || _i < _splitAt)) _splitAt = _i;
      }
      const _prose = _splitAt >= 0 ? text.slice(0, _splitAt).trim() : text;
      const _data = _splitAt >= 0 ? text.slice(_splitAt).trim() : '';
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
      const embeds = [{
        author: { name: label || 'NoVo Analyst', icon_url: 'https://novo-aitrading.app/novo-icon.png?v=4' },
        title, description: _cap(_bold(_prose)), color, fields,
        footer: { text: 'NoVo — market analysis & education, not trade signals.' },
        timestamp: new Date().toISOString(),
      }];
      if (chartUrl) embeds[0].image = { url: chartUrl };
      if (_data) embeds.push({ description: _cap(_bold(_data)), color: 0x22d3ee, footer: { text: 'NoVo — analysis & education, not signals.' } });
      await fetch(discordWebhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'NoVo Analyst', avatar_url: 'https://novo-aitrading.app/novo-icon.png?v=4', embeds }),
      });
    } catch (e) { console.error('[analyst-publish] discord post failed:', e.message); }
  }

  // ── WEB PUSH — fan 'The Line' (kind='alert') out to installed PWA members. Best-effort; DORMANT until the
  // ANALYST_VAPID_PUBLIC / ANALYST_VAPID_PRIVATE env keys are set (mirrors the Trader dashboard's dormant push).
  if (kind === 'alert' && process.env.ANALYST_VAPID_PUBLIC && process.env.ANALYST_VAPID_PRIVATE && process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      webpush.setVapidDetails(process.env.ANALYST_VAPID_SUBJECT || 'mailto:support@novo-aitrading.app',
        process.env.ANALYST_VAPID_PUBLIC, process.env.ANALYST_VAPID_PRIVATE);
      const BT = process.env.BLOB_READ_WRITE_TOKEN;
      const { blobs } = await list({ prefix: 'analyst-push/', token: BT });
      const payload = JSON.stringify({
        title: title || 'NoVo Analyst',
        body: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        url: `${SITE}/analyst/live`, tag: 'novo-analyst-line',
      });
      const stale = [];
      await Promise.all((blobs || []).map(async (b) => {
        try {
          const rec = await fetch(b.url).then(r => r.json());
          if (rec && rec.sub) await webpush.sendNotification(rec.sub, payload);
        } catch (err) {
          if (err && (err.statusCode === 404 || err.statusCode === 410)) stale.push(b.url);  // expired sub → prune
        }
      }));
      if (stale.length) { try { await del(stale, { token: BT }); } catch (_) {} }
    } catch (e) { console.error('[analyst-publish] push send failed:', e.message); }
  }

  // ── PUBLIC ARCHIVE (delayed) ──────────────────────────────────────────────────────────────────────
  // Save full desk-note READS (kind='read' — Open/Close/Week-Ahead/Mid-Day, NOT intraday alerts) to Blob
  // with a publishAfter timestamp. The /analyst/archive page filters by that timestamp, so today's read
  // stays subscriber-exclusive (email/Discord) and only lands in the PUBLIC archive after its session —
  // self-releasing, no cron. Runs for send=true AND send=false reads (Mid-Day is archive-only). Best-effort.
  if (kind === 'read' && archive && process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const BT = process.env.BLOB_READ_WRITE_TOKEN;
      const nowMs = Date.now();
      const etDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
      const t = title.toLowerCase();
      let kslug = 'read', delayH = 12;
      if (/pre-?market primer|the open/.test(t))     { kslug = 'the-open';       delayH = 9; }   // public after the close
      else if (/closing bell|the close/.test(t))     { kslug = 'the-close';      delayH = 16; }  // public next morning
      else if (/mid-?day/.test(t))                   { kslug = 'mid-day';        delayH = 18; }
      else if (/week ahead|weekly|the week/.test(t)) { kslug = 'the-week-ahead'; delayH = 16; }
      const slug = `${etDate}-${kslug}`;
      const publishAfter = nowMs + delayH * 3600 * 1000;
      const readObj = { slug, title, text, bias, levels, chartUrl, label, dateLabel: etDate, publishAfter, createdAt: nowMs };
      await put(`analyst-archive/reads/${slug}.json`, JSON.stringify(readObj),
        { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token: BT });
      // maintain a lightweight index (title + excerpt + publishAfter) so the archive list is one fetch, not N.
      // idxLoaded guard (mirrors the DELETE path, 2026-07-11): only rewrite the index if we GENUINELY loaded it
      // (or it genuinely doesn't exist). A transient blob list/fetch failure must NOT overwrite the archive with
      // just today's entry and wipe all history — the read blob is already saved, so it self-heals next publish.
      let idx = null, idxLoaded = false;
      try {
        const { blobs } = await list({ prefix: 'analyst-archive/index.json', token: BT });
        if (blobs && blobs[0]) { const r = await fetch(blobs[0].url); if (r.ok) { idx = await r.json(); idxLoaded = true; } }
        else { idx = []; idxLoaded = true; }   // no index blob yet = empty is the true state, safe to write
      } catch (_) { idxLoaded = false; }
      if (idxLoaded && Array.isArray(idx)) {
        const excerpt = text.replace(/\s+/g, ' ').replace(/(THE READ|KEY LEVELS|STRUCTURAL POSTURE|WHAT TO WATCH|WHAT CHANGED|WHAT IT MEANS|BOTTOM LINE|THE SETUP|THE RECAP|TOMORROW'S SETUP|THE WEEK AHEAD|CATALYSTS|SCENARIOS|LEVELS TO WATCH|FLOW DYNAMICS|EVENT PLAYBOOK|DEALER POSITIONING MAP|DEALER POSITIONING)/g, '').trim().slice(0, 180);
        const entry = { slug, title, dateLabel: etDate, kslug, bias, excerpt, publishAfter };
        // Verify-and-retry (mirrors the DELETE path): add → write → re-read; if a concurrent writer dropped our
        // entry (lost-update race), re-apply onto the fresh index. Entry is unshifted to the front so slice(0,400)
        // never drops it. Bounded to 3 attempts.
        for (let attempt = 0; attempt < 3; attempt++) {
          idx = idx.filter(e => e.slug !== slug);
          idx.unshift(entry);
          idx = idx.slice(0, 400);
          await put('analyst-archive/index.json', JSON.stringify(idx),
            { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', token: BT });
          const check = await _loadJson('analyst-archive/index.json', BT);
          if (!Array.isArray(check) || check.some(e => e.slug === slug)) break;   // our entry survived → done
          idx = check;   // clobbered by a concurrent writer; loop and re-add
        }
      }
    } catch (e) { console.error('[analyst-publish] archive save failed:', e.message); }
  }

  // Email gate: alerts are DISCORD-ONLY (engine sends them send=false); archive-only reads also skip email.
  // Only send=true reports — the Open/Close desk notes and the Weekly — go to the inbox.
  if (!send) return res.status(200).json({ ok: true, discorded: kind === 'alert', emailed: false });

  // The Open primer is the daily on-ramp — tell email subs the live intraday alerts now fire in Discord.
  const isOpenPrimer = /pre-?market primer/i.test(title);
  const discordCta = isOpenPrimer
    ? '<div style="margin-top:22px;border:1px solid #2c3a58;border-left:3px solid #5865F2;border-radius:8px;padding:16px 18px;background:rgba(88,101,242,0.08);">' +
        '<div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">&#128276; Intraday alerts are live in Discord</div>' +
        '<div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;">Real-time <b style="color:#eaf3ff">&lsquo;The Line&rsquo;</b> level-break playbooks and dealer-regime shifts fire the moment they happen &mdash; in the members-only Analyst Discord, not email. <a href="https://discord.gg/EfnPJ5gC5w" style="color:#7f8cff;font-weight:700;text-decoration:none;">Join the Analyst Discord &rarr;</a> <span style="color:#6f8bab;">(link your account on <a href="https://novo-aitrading.app/analyst" style="color:#7f8cff;text-decoration:none;">/analyst</a> to unlock the channels).</span></div>' +
      '</div>'
    : '';

  // Institutional, NoVo-branded DARK HTML email. Absolute image URL (email clients require it); the dark
  // session chart blends into the dark card. Bolded desk-note labels, audience-aware upsell, unsubscribe.
  const bodyText = esc(text).replace(/(^|\n)(THE READ|KEY LEVELS|STRUCTURAL POSTURE|WHAT TO WATCH|WHAT CHANGED|WHAT IT MEANS|BOTTOM LINE|THE SETUP|THE RECAP|TOMORROW'S SETUP|THE WEEK AHEAD|CATALYSTS|SCENARIOS|LEVELS TO WATCH|FLOW DYNAMICS|EVENT PLAYBOOK|DEALER POSITIONING MAP|DEALER POSITIONING)/g,
    '$1<b style="color:#22d3ee">$2</b>');
  // Audience-aware upsell. The FREE list gets the requested upsell (Analyst for the Weekly); the PAID Analyst
  // list already HAS Analyst, so it's never pitched back to them — they get the Trader upsell instead. Chosen
  // per-audience inside the send loop below (the Weekly goes to 'both'), so no one is sold what they own.
  const buildUpsell = (u) => u === 'both'
    // Conversion pitch for the FREE list (the Mid-Day sales email) — offer BOTH paid tiers, let them choose.
    ? '<div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:8px;">Ready for more than the taste?</div>' +
      '<div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;margin-bottom:11px;"><b style="color:#eaf3ff">NoVo Analyst</b> &mdash; the daily <b style="color:#eaf3ff">Open</b> &amp; <b style="color:#eaf3ff">Close</b> desk notes, real-time level-break alerts, and a <b style="color:#eaf3ff">live dealer dashboard</b>, $49/mo. <a href="https://novo-aitrading.app/analyst" style="color:#34d399;font-weight:700;text-decoration:none;">Get NoVo Analyst &rarr;</a></div>' +
      '<div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;"><b style="color:#eaf3ff">NoVo Trader</b> &mdash; the machine: the same read, live, executing in your own broker account within your rules. <a href="https://novo-aitrading.app" style="color:#34d399;font-weight:700;text-decoration:none;">See NoVo Trader &rarr;</a></div>'
    : u === 'analyst'
    ? '<div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Want the daily read?</div>' +
      '<div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;">This weekly outlook is the taste. <b style="color:#eaf3ff">NoVo Analyst</b> adds the daily <b style="color:#eaf3ff">Open</b> &amp; <b style="color:#eaf3ff">Close</b> desk notes, intraday level-break alerts, and a <b style="color:#eaf3ff">live dealer dashboard</b> — $49/mo. <a href="https://novo-aitrading.app/analyst" style="color:#34d399;font-weight:700;text-decoration:none;">Get NoVo Analyst &rarr;</a></div>'
    : '<div style="font-size:14px;color:#eaf3ff;font-weight:700;margin-bottom:4px;">Want it raw &amp; live?</div>' +
      '<div style="font-size:13.5px;color:#9fb6d1;line-height:1.55;">This is the read. <b style="color:#eaf3ff">NoVo Trader</b> is the machine — the same read, live, executing in your own broker account within your rules. <a href="https://novo-aitrading.app" style="color:#34d399;font-weight:700;text-decoration:none;">See NoVo Trader &rarr;</a></div>';
  // Paid-only reminder that the live web dashboard exists (the free list never sees it — it's a paid feature).
  const LIVE_CTA = `<a href="${SITE}/analyst/live" style="display:block;text-align:center;background:linear-gradient(180deg,#22d3ee,#3b82f6);color:#04121a;font-weight:800;font-size:13.5px;text-decoration:none;padding:12px 18px;border-radius:9px;margin:0 0 20px;">&#9673; Open your live dealer dashboard &rarr;</a>`;
  const renderBody = (upsellHtml, liveCta) => html || (
    '<div style="margin:0;padding:0;background:#070b12;">' +
      '<div style="max-width:600px;margin:0 auto;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">' +
        '<div style="background:#0a1120;border:1px solid #1c2c47;border-bottom:0;border-radius:12px 12px 0 0;padding:22px 24px;text-align:center;">' +
          '<img src="https://novo-aitrading.app/novo-logo-light.png?v=1" alt="NoVo AI Trading" height="30" style="height:30px;width:auto;display:inline-block;border:0;">' +
          `<div style="margin-top:9px;font-size:10.5px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#22d3ee;">${esc(label)}</div>` +
        '</div>' +
        '<div style="background:#0f1a2e;border:1px solid #1c2c47;border-top:0;border-radius:0 0 12px 12px;padding:28px 28px 24px;">' +
          (liveCta || '') +
          (chartUrl ? `<img src="${chartUrl}" width="552" style="width:100%;max-width:552px;height:auto;border-radius:8px;border:1px solid #1c2c47;display:block;margin:0 0 20px;" alt="SPY session chart — levels &amp; structure">` : '') +
          `<h1 style="font-size:20px;font-weight:800;color:#eaf3ff;letter-spacing:-.3px;margin:0 0 12px;line-height:1.25;">${esc(title)}</h1>` +
          biasPill + alertPill +
          `<div style="font-size:15px;line-height:1.7;color:#c2d2e6;white-space:pre-wrap;">${bodyText}</div>` +
          levelsTable +
          // New-user glossary — plain-English on the terms the read uses, so a newer trader isn't lost.
          '<div style="margin-top:24px;border:1px solid #1c2c47;border-radius:8px;padding:14px 16px;background:#0c1526;">' +
            '<div style="font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#6f8bab;margin-bottom:7px;">New here? The terms</div>' +
            '<div style="font-size:12.5px;color:#8aa0b8;line-height:1.65;"><b style="color:#c2d2e6;">Net GEX</b> &mdash; how dealer hedging pushes price: <b style="color:#c2d2e6;">positive</b> = dealers dampen moves (grind / mean-revert), <b style="color:#c2d2e6;">negative</b> = they amplify (moves extend). <b style="color:#c2d2e6;">Gamma flip</b> &mdash; the price where that switches. <b style="color:#c2d2e6;">VWAP</b> &mdash; the session\'s volume-weighted average price, a fair-value line.</div>' +
          '</div>' +
          discordCta +
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
      // Paid Analyst subscribers already HAVE Analyst — never pitch it back; upsell them to Trader instead,
      // and give them the live-dashboard button (a paid-only feature the free list never sees).
      const isPaid = (aud === ANALYST_AUD);
      const effUpsell = isPaid ? 'pulse' : upsell;
      const bodyHtml = renderBody(buildUpsell(effUpsell), isPaid ? LIVE_CTA : '');
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
