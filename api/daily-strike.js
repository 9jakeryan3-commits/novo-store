/* api/daily-strike.js — THE DAILY STRIKE, the NoVo market desk. Dr. NoVo writes the news.
 *
 * Jake, 2026-09-12, naming it and scoping it: a news outlet where NoVo WRITES the stories,
 * public, built to be found in search. Not an aggregator — the wire is the INPUT, the story is
 * ours. A strike is where an option lives and where price gets decided, and a strike is a hit
 * that lands; daily is both the cadence and the expiry cycle.
 *
 * ┌ HOW THIS COMPETES WITHOUT A NEWSROOM ───────────────────────────────────────────────────┐
 * │ CNBC, Yahoo, Seeking Alpha and Bloomberg win on VOLUME, FRESHNESS and STRUCTURE — dozens │
 * │ of stories, "35 min ago", hero + rail + sections. We will never out-staff them, and      │
 * │ imitating their shape with one story a day reads as an empty room.                       │
 * │ What none of them have is THE BOOK. So the front page is a newsroom shape wrapped around │
 * │ live dealer positioning: the regime strip at the top is our own data, updating, and every │
 * │ story is a read off it. Volume comes from KINDS — the open, the close, a level that broke,│
 * │ the crypto desk, what the options market prices into an earnings date — each a genuinely  │
 * │ different piece rather than six rewrites of the morning.                                  │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * GET  /daily-strike          → the front page: hero, latest rail, sections, live regime strip
 * GET  /daily-strike/:slug    → one story, NewsArticle schema
 * POST (ops secret, ?kind=)   → write a story of that kind from live data
 *
 * ⚠ FIVE RULES ARE BAKED INTO EVERY PROMPT, EACH ONE EARNED ON THIS CODEBASE:
 * 1. ATTRIBUTION. A headline is evidence something was SAID, not that it is true. Every claim
 *    off the wire names its publisher in the sentence.
 * 2. NO FORECAST LAUNDERING (Jerni, 09-12). A third party's prediction stays theirs — "Goldman's
 *    target is 6,200", never "6,200 looks likely". His record exists because everything in it is
 *    graded; an ungradeable borrowed call must never enter it wearing his voice.
 * 3. NO METHOD (Jake, 09-12). Levels, regimes and rates may be stated. Thresholds, bands, cell
 *    floors and the arithmetic behind them may not.
 * 4. NEVER ADVICE. No buy, no sell, no should, no target of his own.
 * 5. NO INVENTED NUMBERS. Every figure comes from the payload handed to him in the prompt.
 *
 * ⚠ ARCHITECTURAL GUARD: stories are NOT indexed into NoVo's retrieval corpus. The journal is
 * what he retrieves from, and a desk that writes into its own source of truth starts citing its
 * own commentary back as research a week later.
 */
import { put, list } from '@vercel/blob';
const { kv } = require('./_kv.js');
const { vertex, answerText } = require('./_vertex.js');
const { SYSTEM } = require('./_lib/analyst-brain.js');
const _CHROME = require('./_lib/site-chrome.js');

const SITE = 'https://novo-options.trade';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const PREFIX = 'daily-strike/stories/';
const IDX_KEY = 'ds:index';
const MASTHEAD = 'The Daily Strike';
const TAGLINE = 'the NoVo market desk';

/* THE DESKS. Each is a genuinely different piece — a different question, a different lead, a
   different slice of the same live data — which is what makes a stream of them read as a desk
   rather than one story rewritten. `label` is the section a reader sees. */
const KINDS = {
  open:     { label: 'The Open',   ask: 'What the book looks like going into the session: where spot sits against the flip, which wall is nearest, what the regime implies for range, and what the wire is putting in front of it.' },
  close:    { label: 'The Close',  ask: 'What actually happened against what the book said this morning: did price respect the wall, did it hold the flip, did the session stay inside the expected move — and what that leaves for tomorrow.' },
  level:    { label: 'Levels',     ask: 'One structural fact and what it means: the level that moved or is about to matter most across SPY, QQQ and IWM. Lead with the level, not the news.' },
  crypto:   { label: 'Crypto',     ask: 'The crypto desk read: where the majors sit against their own dealer structure and the daily 08:00 UTC expiry, and what the wire says about the space.' },
  earnings: { label: 'Earnings',   ask: 'The reporters ahead and what the options market is pricing into them — expected move, where the book is positioned. Never a prediction of the result.' },
  wire:     { label: 'The Wire',   ask: 'The single biggest story on the wire right now and what it did to the book — attribute the reporting, then go where no headline goes.' },
};

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 70);

/* "35 min ago" is the single strongest freshness signal a news front page has — every competitor
   leads with it. Computed server-side so it is in the HTML a crawler sees, not painted by JS. */
function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return m <= 1 ? 'just now' : m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

function _page(title, desc, canon, inner, extraHead) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canon}">
<meta property="og:type" content="article"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${canon}">
<meta property="og:site_name" content="NoVo Options Trading">
<meta property="og:image" content="${SITE}/og-default.png?v=4">
<meta name="twitter:card" content="summary_large_image">
${extraHead || ''}
${_CHROME.HEAD}
<style>
  .ds-wrap{width:100%;max-width:none;margin:0;padding:20px 34px 60px;}
  @media (min-width:1600px){.ds-wrap{padding:22px 56px 70px;}}
  .ds-mast{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;
    border-bottom:1px solid var(--bdr,#2c2c30);padding-bottom:12px;margin-bottom:0;}
  .ds-mast a{text-decoration:none;}
  .ds-name{font-size:clamp(22px,4vw,30px);font-weight:900;letter-spacing:-.5px;color:var(--txt1,#eaf3ff);}
  .ds-tag{display:block;font-family:var(--mono,ui-monospace),monospace;font-size:10px;
    letter-spacing:.22em;text-transform:uppercase;color:var(--txt3,#6e6e6e);margin-top:4px;}
  .ds-live{font-family:var(--mono,ui-monospace),monospace;font-size:10px;letter-spacing:.14em;
    text-transform:uppercase;color:var(--txt3,#6e6e6e);white-space:nowrap;}
  .ds-live b{color:#10b981;}
  /* THE REGIME STRIP — our data on a news page. Nobody else's front page can carry this. */
  .ds-strip{display:flex;flex-wrap:wrap;gap:0;border-bottom:1px solid var(--bdr,#2c2c30);
    margin-bottom:22px;}
  .ds-cell{flex:1 1 150px;padding:11px 14px 11px 0;border-right:1px solid var(--bdr2,#1c1c20);}
  .ds-cell:last-child{border-right:0;}
  .ds-ck{font-family:var(--mono,ui-monospace),monospace;font-size:9.5px;letter-spacing:.16em;
    text-transform:uppercase;color:var(--txt3,#6e6e6e);}
  .ds-cv{font-size:15px;font-weight:800;color:var(--txt1,#eaf3ff);margin-top:3px;letter-spacing:-.2px;}
  .ds-cs{font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;margin-top:2px;}
  .ds-up{color:#10b981;} .ds-dn{color:#f43f5e;} .ds-nu{color:var(--txt3,#6e6e6e);}
  .ds-cols{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:40px;align-items:start;}
  /* Three columns once there is room: lead+sections, a second story column, then the rail.
     A news page that stays a 760px ribbon on a 2560px monitor reads as a blog, not a desk. */
  @media (min-width:1500px){.ds-cols{grid-template-columns:minmax(0,1.55fr) minmax(0,1fr) 360px;gap:44px;}}
  @media (max-width:860px){.ds-cols{grid-template-columns:1fr;gap:22px;}}
  .ds-lead h2{font-size:clamp(24px,3.6vw,33px);line-height:1.16;letter-spacing:-.8px;margin:0 0 9px;}
  .ds-lead h2 a{color:var(--txt1,#eaf3ff);text-decoration:none;}
  .ds-lead h2 a:hover{color:#22d3ee;}
  .ds-lead .ds-dek{font-size:16.5px;line-height:1.6;color:var(--txt2,#a8a8a8);margin:0 0 8px;max-width:70ch;}
  .ds-kicker{font-family:var(--mono,ui-monospace),monospace;font-size:10px;letter-spacing:.18em;
    text-transform:uppercase;color:#22d3ee;margin-bottom:7px;}
  .ds-item{padding:15px 0;border-top:1px solid var(--bdr2,#1c1c20);}
  .ds-item h3{font-size:17.5px;line-height:1.34;letter-spacing:-.25px;margin:0 0 5px;}
  .ds-item h3 a{color:var(--txt1,#eaf3ff);text-decoration:none;}
  .ds-item h3 a:hover{color:#22d3ee;}
  .ds-dek{font-size:14px;line-height:1.58;color:var(--txt2,#a8a8a8);margin:0 0 5px;}
  .ds-by{font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;letter-spacing:.04em;
    color:var(--txt3,#6e6e6e);}
  .ds-rail h4{font-family:var(--mono,ui-monospace),monospace;font-size:10px;letter-spacing:.2em;
    text-transform:uppercase;color:var(--txt3,#6e6e6e);margin:0 0 10px;padding-bottom:8px;
    border-bottom:1px solid var(--bdr,#2c2c30);}
  .ds-rrow{display:flex;gap:11px;padding:10px 0;border-bottom:1px solid var(--bdr2,#1c1c20);}
  .ds-rt{font-family:var(--mono,ui-monospace),monospace;font-size:10px;color:var(--txt3,#6e6e6e);
    white-space:nowrap;padding-top:2px;min-width:62px;}
  .ds-rh{font-size:13.5px;line-height:1.45;}
  .ds-rh a{color:var(--txt2,#a8a8a8);text-decoration:none;}
  .ds-rh a:hover{color:#22d3ee;}
  .ds-sec{margin-top:30px;}
  .ds-sech{font-family:var(--mono,ui-monospace),monospace;font-size:10px;letter-spacing:.2em;
    text-transform:uppercase;color:var(--txt3,#6e6e6e);padding-bottom:8px;
    border-bottom:1px solid var(--bdr,#2c2c30);margin-bottom:2px;}
  article h1{font-size:clamp(26px,3.4vw,40px);line-height:1.15;letter-spacing:-1.2px;max-width:22ch;
    color:var(--txt1,#eaf3ff);margin:0 0 10px;}
  article .lead{font-size:17.5px;line-height:1.65;color:var(--txt2,#a8a8a8);margin:0 0 16px;max-width:74ch;}
  article .body{font-size:16.5px;line-height:1.78;color:var(--txt2,#a8a8a8);white-space:pre-wrap;max-width:78ch;}
  .ds-src{max-width:78ch;margin-top:26px;padding-top:14px;border-top:1px solid var(--bdr2,#1c1c20);
    font-size:12px;line-height:1.65;color:var(--txt3,#6e6e6e);}
  .ds-cta{max-width:78ch;margin-top:26px;padding-top:16px;border-top:1px solid var(--bdr,#2c2c30);
    font-size:14.5px;line-height:1.7;color:var(--txt2,#a8a8a8);}
  .ds-cta a{color:#22d3ee;font-weight:700;text-decoration:none;}
  .ds-empty{padding:20px 0;color:var(--txt3,#6e6e6e);font-size:14px;line-height:1.7;}
</style>
${_CHROME.HEADER}
<div class="ds-wrap">
${inner}
</div>
${_CHROME.FOOTER}${_CHROME.SCRIPT || ''}
</body></html>`;
}

async function readIndex() {
  const r = kv();
  if (!r) return [];
  try {
    const hit = await r.get(IDX_KEY);
    if (hit) return typeof hit === 'string' ? JSON.parse(hit) : hit;
  } catch (_) { /* fall through */ }
  return [];
}

async function writeIndex(items) {
  const r = kv();
  if (!r) return;
  try { await r.set(IDX_KEY, JSON.stringify(items.slice(0, 200))); } catch (_) {}
}

async function loadStory(slug, token) {
  try {
    const { blobs } = await list({ prefix: `${PREFIX}${slug}.json`, token });
    if (!blobs || !blobs[0]) return null;
    const res = await fetch(blobs[0].url);
    return res.ok ? await res.json() : null;
  } catch (_) { return null; }
}

/* ── THE WRITER ───────────────────────────────────────────────────────────────────────────── */
async function writeStory(req, res) {
  const want = process.env.OPS_SECRET || process.env.ANALYST_PUBLISH_SECRET || '';
  const got = req.headers['x-ops-secret']
    || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const ok = want && got.length === want.length
    && require('crypto').timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });

  const kind = KINDS[String((req.query && req.query.kind) || 'wire')] ? String(req.query.kind) : 'wire';
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(503).json({ error: 'blob not configured' });
  const r = kv();
  if (!r) return res.status(503).json({ error: 'kv unavailable' });

  const g = (p) => p.catch(() => null);
  const [rawWire, rawLevels, rawTrack, rawCal, rawCrypto] = await Promise.all([
    g(r.get('rh:news:MARKET')), g(r.get('analyst:live_levels')),
    g(r.get('novo:track_record')), g(r.get('rh:earnings_calendar')),
    g(r.get('crypto:map:live')),
  ]);
  const J = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch (_) { return null; } };
  const wire = J(rawWire), levels = J(rawLevels), track = J(rawTrack),
        cal = J(rawCal), crypto = J(rawCrypto);
  const arts = (wire && wire.data && wire.data.articles) || [];
  const hasBook = levels && Array.isArray(levels.tickers) && levels.tickers.length;
  // A desk with neither the wire nor the book has nothing to write from, and a desk that writes
  // anyway is inventing the news.
  if (!arts.length && !hasBook) return res.status(200).json({ ok: false, note: 'no inputs to write from' });

  const headlines = arts.slice(0, 18).map((a, i) =>
    `${i + 1}. "${a.title}" — ${a.publisher}, ${a.published_at}`).join('\n') || '(wire quiet)';
  const book = hasBook
    ? levels.tickers.map((t) => `${t.ticker}: spot ${t.spot}, ${t.regime || 'regime unknown'}, `
        + `flip ${t.flip}, call wall ${t.callWall}, put wall ${t.putWall}, `
        + `expected move ±${t.expectedMovePct}%, skew ${t.skewPts}`).join('\n')
    : '(no live dealer state)';
  const rec = (track && track.tickers) ? JSON.stringify(track.tickers).slice(0, 1400) : '(none)';
  const cals = (cal && cal.events) ? cal.events.slice(0, 10)
      .map((e) => `${e.date} ${e.symbol} Q${e.quarter}${e.eps_estimate ? ' est ' + e.eps_estimate : ''}`).join('; ') : '(none)';
  const cry = (crypto && crypto.coins)
    ? Object.entries(crypto.coins).slice(0, 6).map(([k, c]) => `${k}: ${c.price}`
        + (c.gamma ? `, net gex ${c.gamma.net_gex}, flip ${c.gamma.flip_zone}, max pain ${c.gamma.max_pain}` : '')).join('\n')
    : '(no crypto state)';

  const prompt =
`You are writing for ${MASTHEAD}, ${TAGLINE} — a public column under your own byline, on the open
web. TODAY'S DESK: ${KINDS[kind].label}. ${KINDS[kind].ask}

WHAT MAKES THIS OURS AND NOT A REPRINT: the wire says what happened. You say what it did to the
dealer book — the level that moved, the regime it sits in, what setups like it have resolved to.
That second half is the whole reason the piece exists. Lead with the news, land on the structure.

THE WIRE (what publishers filed, newest first):
${headlines}

THE EQUITY BOOK RIGHT NOW (ours, and the part no headline carries):
${book}

THE CRYPTO BOOK:
${cry}

THE SCORED RECORD (what these setups have actually done):
${rec}

UPCOMING REPORTERS: ${cals}

RULES — not style notes, the contract:
1. ATTRIBUTE. Any fact off the wire names the publisher in the sentence: "Benzinga reported…".
   A headline is evidence something was SAID, not that it is true.
2. A FORECAST IN A HEADLINE STAYS ITS AUTHOR'S. "Goldman's target is 6,200" — never "6,200 looks
   likely". You do not adopt another desk's call and you do not make one of your own.
3. NO METHOD. Name levels, regimes, rates and sample sizes. NEVER the thresholds, bands or
   arithmetic behind how anything is graded or computed.
4. NOT ADVICE. No buy, no sell, no should, no target. You explain the book; the reader decides.
5. EVERY NUMBER COMES FROM ABOVE. If it is not in this prompt, it does not go in the story.
6. Write THIS desk's piece — do not write a general market summary that would fit any of them.
   If the inputs are thin, write the shorter, quieter piece. Never pad, never dramatise a flat tape.

FORMAT — return STRICT JSON and nothing else:
{"headline":"<= 70 chars, plain and specific, no clickbait, no colon-subtitle>",
 "dek":"<one sentence, <= 180 chars, what the piece establishes>",
 "body":"<320-520 words, plain paragraphs separated by a blank line. No markdown, no headers,
          no bullet lists. Your own voice.>",
 "tickers":["SPY"],
 "sources":["Benzinga"]}`;

  let out = '';
  try {
    const resp = await vertex(`${MODEL}:generateContent`, {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.75, maxOutputTokens: 2400, responseMimeType: 'application/json',
                          thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
    });
    out = String(answerText(resp) || '').trim();
  } catch (e) {
    return res.status(502).json({ error: 'generation failed: ' + (e && e.message) });
  }

  let story = null;
  try { story = JSON.parse(out); } catch (_) { story = null; }
  if (!story || !story.headline || !story.body) {
    return res.status(502).json({ error: 'model returned no usable story' });
  }
  // A piece that cites the wire must name who reported it. Checked here rather than trusted from
  // the model — but a book-only desk (levels, close) legitimately has no wire source.
  const needsSource = (kind === 'wire');
  if (needsSource && (!Array.isArray(story.sources) || !story.sources.length)) {
    return res.status(422).json({ error: 'wire story carried no sources; refusing to publish' });
  }

  const now = Date.now();
  const slug = `${new Date(now).toISOString().slice(0, 10)}-${slugify(story.headline)}`.slice(0, 90);
  const doc = {
    slug, kind, kindLabel: KINDS[kind].label,
    headline: String(story.headline).slice(0, 140),
    dek: String(story.dek || '').slice(0, 240),
    body: String(story.body).slice(0, 12000),
    tickers: Array.isArray(story.tickers) ? story.tickers.slice(0, 6) : [],
    sources: Array.isArray(story.sources) ? story.sources.slice(0, 8) : [],
    publishedAt: now, byline: 'Dr. NoVo',
  };

  await put(`${PREFIX}${slug}.json`, JSON.stringify(doc),
    { access: 'public', token, contentType: 'application/json', addRandomSuffix: false,
      allowOverwrite: true });

  const idx = await readIndex();
  await writeIndex([{ slug, kind, kindLabel: doc.kindLabel, headline: doc.headline, dek: doc.dek,
                      publishedAt: now, tickers: doc.tickers }]
    .concat(idx.filter((x) => x.slug !== slug)));

  return res.status(200).json({ ok: true, kind, slug, url: `${SITE}/daily-strike/${slug}`,
    words: doc.body.split(/\s+/).length, sources: doc.sources });
}

/* ── THE REGIME STRIP: our own data, on a news front page ─────────────────────────────────── */
async function regimeStrip() {
  const r = kv();
  if (!r) return '';
  let lv = null;
  try {
    const raw = await r.get('analyst:live_levels');
    lv = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) { lv = null; }
  if (!lv || !Array.isArray(lv.tickers) || !lv.tickers.length) return '';
  const cells = lv.tickers.slice(0, 3).map((t) => {
    const long = String(t.regime || '').indexOf('long') === 0;
    const cls = t.regime ? (long ? 'ds-up' : 'ds-dn') : 'ds-nu';
    const word = t.regime ? (long ? 'dealers dampen' : 'dealers amplify') : 'regime unknown';
    return `<div class="ds-cell"><div class="ds-ck">${esc(t.ticker)}</div>`
      + `<div class="ds-cv">${t.spot != null ? esc(String(t.spot)) : '—'}</div>`
      + `<div class="ds-cs ${cls}">${word}${t.flip != null ? ` · flip ${esc(String(t.flip))}` : ''}</div></div>`;
  }).join('');
  const when = lv.asof ? ago(lv.asof) : '';
  return `<div class="ds-strip">${cells}<div class="ds-cell"><div class="ds-ck">The book</div>`
    + `<div class="ds-cv" style="font-size:12.5px;font-weight:600;line-height:1.4;color:var(--txt2,#a8a8a8)">`
    + `Live dealer positioning${when ? ` · ${esc(when)}` : ''}</div>`
    + `<div class="ds-cs ds-nu"><a href="/plans" style="color:#22d3ee;text-decoration:none;">see the full map →</a></div></div></div>`;
}

/* ── THE READER ───────────────────────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  if (req.method === 'POST') return writeStory(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET or POST' });

  const slug = String((req.query && req.query.slug) || '').replace(/[^a-z0-9-]/gi, '').slice(0, 90);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Short edge cache: a news front page whose timestamps are an hour stale reads as abandoned.
  res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=120, stale-while-revalidate=900');

  if (slug) {
    const story = await loadStory(slug, process.env.BLOB_READ_WRITE_TOKEN);
    if (!story) {
      return res.status(404).send(_page(`Not found — ${MASTHEAD}`, 'This story is not available.',
        `${SITE}/daily-strike`,
        `<div class="ds-mast"><a href="/daily-strike"><span class="ds-name">${MASTHEAD}</span>`
        + `<span class="ds-tag">${TAGLINE}</span></a></div>`
        + `<article style="margin-top:22px;"><h1>That story is not here.</h1>`
        + `<p class="lead"><a href="/daily-strike" style="color:#22d3ee;">Back to ${MASTHEAD}</a>.</p></article>`,
        '<meta name="robots" content="noindex, follow">'));
    }
    const when = new Date(story.publishedAt);
    const idx = await readIndex();
    const more = idx.filter((x) => x.slug !== slug).slice(0, 6);
    const ld = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'NewsArticle',
      headline: String(story.headline).slice(0, 110),
      description: story.dek || '',
      datePublished: when.toISOString(), dateModified: when.toISOString(),
      mainEntityOfPage: `${SITE}/daily-strike/${slug}`,
      image: `${SITE}/og-default.png?v=4`,
      articleSection: story.kindLabel || 'Markets',
      author: { '@type': 'Person', name: 'Dr. NoVo',
                description: 'The AI market analyst at NoVo Options Trading', url: `${SITE}/ai` },
      publisher: { '@type': 'Organization', name: 'NoVo Options Trading', url: `${SITE}/`,
                   logo: { '@type': 'ImageObject', url: `${SITE}/novo-logo.png?v=1` } },
      isAccessibleForFree: true,
    });
    const inner = `<div class="ds-mast"><a href="/daily-strike"><span class="ds-name">${MASTHEAD}</span>
  <span class="ds-tag">${TAGLINE}</span></a>
  <span class="ds-live">${esc(ago(story.publishedAt))}</span></div>
${await regimeStrip()}
<div class="ds-cols"><div>
<article>
  ${story.kindLabel ? `<div class="ds-kicker">${esc(story.kindLabel)}</div>` : ''}
  <h1>${esc(story.headline)}</h1>
  ${story.dek ? `<p class="lead">${esc(story.dek)}</p>` : ''}
  <div class="ds-by">${esc(story.byline || 'Dr. NoVo')} &middot; ${when.toLocaleString('en-US',
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET
      &middot; ${esc(ago(story.publishedAt))}</div>
  <div class="body" style="margin-top:16px;">${esc(story.body)}</div>
  <div class="ds-src">Written by Dr. NoVo, the AI market analyst at NoVo Options Trading, from the
    day's wire and our own dealer-positioning data.${(story.sources || []).length
      ? ` Reporting cited in this piece is the work of ${esc(story.sources.join(', '))} and is
        attributed in the text.` : ''}
    Nothing here is investment advice or a recommendation to trade.</div>
  <div class="ds-cta">The book this piece reads from updates every 60 seconds on the dashboards.
    <a href="/plans">See the plans</a> &middot; <a href="/track-record">The scored record</a></div>
</article></div>
<aside class="ds-rail"><h4>More from the desk</h4>${more.map((s) =>
  `<div class="ds-rrow"><div class="ds-rt">${esc(ago(s.publishedAt))}</div>`
  + `<div class="ds-rh"><a href="/daily-strike/${esc(s.slug)}">${esc(s.headline)}</a></div></div>`).join('')
  || '<div class="ds-empty">More desks publish through the session.</div>'}</aside></div>`;
    return res.status(200).send(_page(`${story.headline} | ${MASTHEAD}`,
      story.dek || String(story.body).slice(0, 155), `${SITE}/daily-strike/${slug}`, inner,
      `<script type="application/ld+json">${ld}</script>`));
  }

  // ── the front page ──
  const items = await readIndex();
  const strip = await regimeStrip();
  const head = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: `${MASTHEAD} — ${TAGLINE}`,
    description: 'Market stories written by Dr. NoVo from the day\'s wire and NoVo\'s own '
               + 'dealer-positioning data.',
    url: `${SITE}/daily-strike`, isAccessibleForFree: true,
    publisher: { '@type': 'Organization', name: 'NoVo Options Trading', url: `${SITE}/` },
  })}</script>`;

  const mast = `<div class="ds-mast"><a href="/daily-strike"><span class="ds-name">${MASTHEAD}</span>
  <span class="ds-tag">${TAGLINE}</span></a>
  <span class="ds-live">${items.length ? `<b>&bull;</b> updated ${esc(ago(items[0].publishedAt))}`
    : 'the desk opens shortly'}</span></div>${strip}`;

  if (!items.length) {
    return res.status(200).send(_page(`${MASTHEAD} — market news from the dealer's book | NoVo`,
      'Market stories written by Dr. NoVo from the day\'s wire and our own dealer-positioning data.',
      `${SITE}/daily-strike`,
      mast + `<div class="ds-empty">The first story publishes shortly. ${MASTHEAD} is written by
        Dr. NoVo off the day's wire and our own dealer-positioning data &mdash; the headline is the
        news, the book is the part nobody else prints.</div>`, head));
  }

  const lead = items[0];
  const rail = items.slice(1, 9);
  const rest = items.slice(9, 33);
  const bySec = {};
  for (const s of rest) (bySec[s.kindLabel || 'Markets'] = bySec[s.kindLabel || 'Markets'] || []).push(s);

  const inner = mast + `<div class="ds-cols">
  <div>
    <div class="ds-lead">
      ${lead.kindLabel ? `<div class="ds-kicker">${esc(lead.kindLabel)}</div>` : ''}
      <h2><a href="/daily-strike/${esc(lead.slug)}">${esc(lead.headline)}</a></h2>
      ${lead.dek ? `<p class="ds-dek">${esc(lead.dek)}</p>` : ''}
      <div class="ds-by">Dr. NoVo &middot; ${esc(ago(lead.publishedAt))}${
        (lead.tickers && lead.tickers.length) ? ` &middot; ${esc(lead.tickers.join(' · '))}` : ''}</div>
    </div>
    ${Object.keys(bySec).map((sec) => `<div class="ds-sec"><div class="ds-sech">${esc(sec)}</div>`
      + bySec[sec].map((s) => `<div class="ds-item">
          <h3><a href="/daily-strike/${esc(s.slug)}">${esc(s.headline)}</a></h3>
          ${s.dek ? `<p class="ds-dek">${esc(s.dek)}</p>` : ''}
          <div class="ds-by">Dr. NoVo &middot; ${esc(ago(s.publishedAt))}</div></div>`).join('')
      + `</div>`).join('')}
  </div>
  <aside class="ds-rail">
    <h4>Latest from the desk</h4>
    ${rail.map((s) => `<div class="ds-rrow"><div class="ds-rt">${esc(ago(s.publishedAt))}</div>`
      + `<div class="ds-rh"><a href="/daily-strike/${esc(s.slug)}">${esc(s.headline)}</a></div></div>`).join('')
      || '<div class="ds-empty">More desks publish through the session.</div>'}
    <h4 style="margin-top:26px;">What this desk reads</h4>
    <div class="ds-rh" style="padding:4px 0 10px;color:var(--txt3,#6e6e6e);font-size:12.5px;line-height:1.6;">
      Every story here is written off live dealer positioning &mdash; the gamma flip, the walls,
      the expected move and the scored record behind them. The wire says what happened;
      <a href="/plans" style="color:#22d3ee;">the map says what it did</a>.
    </div>
  </aside></div>`;

  return res.status(200).send(_page(
    `${MASTHEAD} — market news from the dealer's book | NoVo`,
    'Market stories written by Dr. NoVo from the day\'s wire and our own dealer-positioning data: '
    + 'the headline is the news, the book is what it did.',
    `${SITE}/daily-strike`, inner, head));
};
