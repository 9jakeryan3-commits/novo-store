import { list } from '@vercel/blob';

// NoVo Analyst — PUBLIC archive of past desk notes. Server-rendered HTML (SEO). Reads are saved to Blob by
// analyst-publish.js with a publishAfter timestamp; this endpoint only shows reads whose delay has passed, so
// today's read stays subscriber-exclusive and lands here after its session. Self-releasing — no scheduler.
//   /analyst/archive          -> index (list of released reads)
//   /analyst/archive/:slug    -> a single read (404 until publishAfter passes)

const SITE = process.env.SITE_URL || 'https://novo-aitrading.app';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadJson(prefix, token) {
  try {
    const { blobs } = await list({ prefix, token });
    if (blobs && blobs[0]) { const r = await fetch(blobs[0].url); if (r.ok) return await r.json(); }
  } catch (_) {}
  return null;
}

function biasPill(bias) {
  if (!bias) return '';
  const m = { BULLISH: ['rgba(16,185,129,0.12)', '#34d399', 'rgba(16,185,129,0.45)'], BEARISH: ['rgba(239,68,68,0.12)', '#f87171', 'rgba(239,68,68,0.45)'], NEUTRAL: ['rgba(148,163,184,0.12)', '#b3c2d6', 'rgba(148,163,184,0.4)'] }[String(bias).toUpperCase()];
  if (!m) return '';
  return `<span class="pill" style="background:${m[0]};color:${m[1]};border:1px solid ${m[2]};">Structural Bias &middot; ${esc(String(bias).toUpperCase())}</span>`;
}

function levelsTable(levels) {
  if (!Array.isArray(levels) || !levels.length) return '';
  const fmt = p => Number(p).toFixed(2);
  const res = levels.filter(l => l.kind === 'resistance').sort((a, b) => a.price - b.price);
  const sup = levels.filter(l => l.kind === 'support').sort((a, b) => b.price - a.price);
  const rows = (items, c) => (items.length ? items : [null]).map(l => l
    ? `<tr><td style="padding:6px 12px;color:#9fb6d1;font-size:13px;border-top:1px solid #1c2c47;">${esc(l.label)}</td><td style="padding:6px 12px;text-align:right;font-weight:700;color:${c};font-size:13px;border-top:1px solid #1c2c47;">${fmt(l.price)}</td></tr>`
    : '<tr><td style="padding:6px 12px;color:#6f8bab;font-size:13px;">&mdash;</td><td></td></tr>').join('');
  const col = (title, items, c) => `<td style="vertical-align:top;width:50%;padding:0 5px;"><div style="border:1px solid #1c2c47;border-top:2px solid ${c};border-radius:8px;overflow:hidden;"><div style="background:#12203a;padding:7px 12px;font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:${c};">${title}</div><table style="width:100%;border-collapse:collapse;">${rows(items, c)}</table></div></td>`;
  return `<div style="margin:24px 0 8px;font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#eaf3ff;">Key Levels</div><table style="width:100%;border-collapse:separate;border-spacing:0;"><tr>${col('Resistance', res, '#f87171')}${col('Support', sup, '#34d399')}</tr></table>`;
}

function page(title, desc, canonical, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="article"><meta property="og:site_name" content="NoVo AI Trading">
<link rel="icon" href="${SITE}/favicon.ico">
<style>
 *{box-sizing:border-box;} body{margin:0;background:#070b12;color:#c2d2e6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;}
 a{color:#22d3ee;text-decoration:none;} .wrap{max-width:760px;margin:0 auto;padding:28px 20px 80px;}
 .top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:34px;flex-wrap:wrap;}
 .brand img{height:26px;width:auto;display:block;}
 .cta{background:linear-gradient(180deg,#22d3ee,#3b82f6);color:#04121a;font-weight:800;font-size:13.5px;padding:10px 20px;border-radius:9px;white-space:nowrap;}
 h1{color:#eaf3ff;font-size:clamp(26px,4.5vw,34px);letter-spacing:-1px;line-height:1.15;margin:2px 0 10px;}
 .kicker{font-size:11px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#22d3ee;}
 .muted{color:#6f8bab;font-size:13px;} .lead{color:#9fb6d1;font-size:15.5px;max-width:640px;}
 .card{background:#0f1a2e;border:1px solid #1c2c47;border-radius:12px;padding:26px;margin:22px 0;}
 .body{white-space:pre-wrap;font-size:16px;color:#c2d2e6;} .body b{color:#22d3ee;font-weight:700;}
 .pill{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:5px 12px;border-radius:999px;margin:0 0 6px;}
 img.chart{width:100%;border-radius:8px;border:1px solid #1c2c47;display:block;margin:0 0 20px;}
 ul.rows{list-style:none;padding:0;margin:26px 0 0;} ul.rows li{border:1px solid #1c2c47;border-radius:11px;padding:18px 20px;margin-bottom:14px;background:#0c1526;transition:border-color .15s;}
 ul.rows li:hover{border-color:rgba(34,211,238,0.4);} ul.rows a.rt{color:#eaf3ff;font-weight:800;font-size:18px;letter-spacing:-.3px;}
 .subcta{background:rgba(34,211,238,0.06);border:1px solid rgba(34,211,238,0.28);border-radius:12px;padding:26px;text-align:center;margin-top:36px;}
 .subcta a{background:linear-gradient(180deg,#22d3ee,#3b82f6);color:#04121a;font-weight:800;padding:12px 28px;border-radius:10px;display:inline-block;margin-top:14px;}
 .disc{font-size:11.5px;color:#6f8bab;margin-top:30px;line-height:1.6;}
</style></head><body><div class="wrap">
 <div class="top"><a class="brand" href="${SITE}/analyst"><img src="${SITE}/novo-logo-light.png?v=1" alt="NoVo AI Trading"></a><a class="cta" href="${SITE}/analyst">Get it live &mdash; free 7-day trial</a></div>
 ${inner}
 <div class="disc">Market analysis &amp; education only &mdash; not financial advice, and not trade signals. Trading involves substantial risk of loss.</div>
</div></body></html>`;
}

export default async function handler(req, res) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const slug = (req.query && req.query.slug ? String(req.query.slug) : '').replace(/[^a-z0-9-]/gi, '').slice(0, 80);
  const now = Date.now();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');

  if (!token) {
    res.status(200).send(page('NoVo Analyst — Archive', 'Past NoVo Analyst market reads.', `${SITE}/analyst/archive`,
      '<div class="kicker">The Archive</div><h1>Past reads are on the way.</h1><p class="lead">The archive fills automatically as each desk note publishes. <a href="' + SITE + '/analyst">Get the live read &rarr;</a></p>'));
    return;
  }

  // ── single read ──
  if (slug) {
    const rd = await loadJson(`analyst-archive/reads/${slug}.json`, token);
    if (!rd || (rd.publishAfter && now < rd.publishAfter)) {
      res.status(404).send(page('Not available yet — NoVo Analyst', 'This read has not been released to the public archive yet.', `${SITE}/analyst/archive`,
        '<div class="kicker">NoVo Analyst</div><h1>Not released yet.</h1><p class="lead">This read hasn\'t hit the public archive yet &mdash; subscribers already have it live. <a href="' + SITE + '/analyst">Start a free 7-day trial &rarr;</a></p><p style="margin-top:20px;"><a href="' + SITE + '/analyst/archive">&larr; Browse released reads</a></p>'));
      return;
    }
    const bodyText = esc(rd.text || '').replace(/(^|\n)(THE READ|KEY LEVELS|STRUCTURAL POSTURE|WHAT TO WATCH|WHAT CHANGED|WHAT IT MEANS)/g, '$1<b>$2</b>');
    const desc = (rd.text || '').replace(/\s+/g, ' ').slice(0, 155);
    const inner = `<article>
      <div class="muted">${esc(rd.dateLabel || '')} &middot; NoVo Analyst</div>
      <h1>${esc(rd.title)}</h1>
      ${biasPill(rd.bias)}
      <div class="card">
        ${rd.chartUrl ? `<img class="chart" src="${esc(rd.chartUrl)}" alt="SPY session chart — levels &amp; structure">` : ''}
        <div class="body">${bodyText}</div>
        ${levelsTable(rd.levels)}
      </div>
      <div class="subcta">
        <div style="color:#eaf3ff;font-weight:800;font-size:19px;">This read landed hours ago for subscribers.</div>
        <div class="muted" style="margin-top:6px;max-width:520px;margin-left:auto;margin-right:auto;">The Open, The Close, and The Week Ahead hit your inbox before the bell &mdash; plus real-time &lsquo;The Line&rsquo; level-break alerts in Discord.</div>
        <a href="${SITE}/analyst">Start a 7-day free trial &rarr;</a>
      </div>
      <p style="margin-top:24px;"><a href="${SITE}/analyst/archive">&larr; All past reads</a></p>
    </article>`;
    res.status(200).send(page(`${rd.title} — NoVo Analyst`, desc, `${SITE}/analyst/archive/${slug}`, inner));
    return;
  }

  // ── index ──
  let idx = await loadJson('analyst-archive/index.json', token);
  if (!Array.isArray(idx)) idx = [];
  const pub = idx.filter(e => !e.publishAfter || now >= e.publishAfter).sort((a, b) => (b.publishAfter || 0) - (a.publishAfter || 0));
  const rows = pub.length
    ? pub.map(e => `<li><a class="rt" href="${SITE}/analyst/archive/${esc(e.slug)}">${esc(e.title)}</a><div class="muted" style="margin:4px 0 8px;">${esc(e.dateLabel || '')}</div><div style="font-size:14px;color:#9fb6d1;">${esc(e.excerpt || '')}&hellip;</div></li>`).join('')
    : '<p class="muted" style="margin-top:24px;">Past reads will appear here after each session.</p>';
  const inner = `<div class="kicker">The Archive</div>
    <h1>NoVo Analyst &mdash; past market reads</h1>
    <p class="lead">Every morning desk note, closing read, and week-ahead outlook &mdash; SPY dealer positioning, the gamma flip, the levels that matter, and what to watch. Released here after each session; <a href="${SITE}/analyst">subscribers get them live before the bell &rarr;</a></p>
    <ul class="rows">${rows}</ul>
    <div class="subcta">
      <div style="color:#eaf3ff;font-weight:800;font-size:19px;">Get these live, not delayed.</div>
      <div class="muted" style="margin-top:6px;">The read desks pay hundreds for, in your inbox before the bell &mdash; $39/mo, 7-day free trial.</div>
      <a href="${SITE}/analyst">Start a 7-day free trial &rarr;</a>
    </div>`;
  res.status(200).send(page('NoVo Analyst — Archive of SPY market reads', 'Past NoVo Analyst desk notes: SPY dealer positioning, gamma levels, structural bias, and what to watch — released after each session.', `${SITE}/analyst/archive`, inner));
}
