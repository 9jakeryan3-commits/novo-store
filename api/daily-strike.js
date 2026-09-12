/* api/daily-strike.js — OPEN INTEREST, the NoVo market desk. Dr. NoVo writes the news.
 *
 * Jake, 2026-09-12, naming it and scoping it: a news outlet where NoVo WRITES the stories,
 * public, built to be found in search. Not an aggregator — the wire is the INPUT, the story is
 * ours. The name is the point twice over: a strike is where an option lives and where price gets
 * decided, and a strike is a hit that lands. Daily is the cadence and the expiry cycle both.
 *
 * ┌ WHY THIS IS NOT A HEADLINE FEED ────────────────────────────────────────────────────────┐
 * │ Reposting someone else's headlines is their reporting on our page, un-linkable (the feed │
 * │ carries no article URL) and worth nothing in search. A story NoVo writes off the wire AND │
 * │ the dealer map is OURS: the headline is the fact, the book is the part nobody else has.  │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * GET  /daily-strike          → the index, server-rendered with the site chrome
 * GET  /daily-strike/:slug    → one story, with NewsArticle schema
 * POST (ops secret)            → write a new story from the live wire + dealer state
 *
 * ⚠ FIVE RULES ARE BAKED INTO THE PROMPT, EACH ONE EARNED ON THIS CODEBASE:
 * 1. ATTRIBUTION. A headline is evidence something was SAID, not that it is true. Every claim
 *    that came off the wire names its publisher in the sentence ("Benzinga reported…").
 * 2. NO FORECAST LAUNDERING (Jerni, 09-12). A third party's prediction stays theirs — "Goldman's
 *    target is 6,200", never "6,200 looks likely". His record exists because everything in it is
 *    graded; an ungradeable borrowed call must never enter it wearing his voice.
 * 3. NO METHOD (Jake, 09-12). Levels, regimes and rates may be stated. Thresholds, bands, cell
 *    floors and the arithmetic behind them may not. The claim is owed to the reader; the recipe
 *    is not.
 * 4. NEVER ADVICE. This is an LLC that does not give investment advice: no "buy", no "should",
 *    no price target of his own. He explains what the book is doing, not what a reader should do.
 * 5. NO INVENTED NUMBERS. Every figure comes from the payload handed to him in this prompt.
 *
 * ⚠ AND ONE ARCHITECTURAL GUARD: these stories are NOT indexed into NoVo's retrieval corpus.
 * The journal is what he retrieves from, and a desk that writes into its own source of truth
 * starts citing itself as evidence a week later — his own commentary laundered back as research.
 * Stories live under their own blob prefix for exactly that reason.
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

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 70);

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
  .ds-wrap{max-width:760px;margin:0 auto;padding:22px 20px 60px;}
  .ds-mast{border-bottom:1px solid var(--bdr,#2c2c30);padding-bottom:12px;margin-bottom:22px;}
  .ds-mast a{text-decoration:none;}
  .ds-name{font-size:clamp(22px,4vw,30px);font-weight:900;letter-spacing:-.5px;color:var(--txt1,#eaf3ff);}
  .ds-tag{display:block;font-family:var(--mono,ui-monospace),monospace;font-size:10px;
    letter-spacing:.22em;text-transform:uppercase;color:var(--txt3,#6e6e6e);margin-top:4px;}
  .ds-item{padding:16px 0;border-bottom:1px solid var(--bdr2,#1c1c20);}
  .ds-item:last-child{border-bottom:0;}
  .ds-item h2{font-size:19px;line-height:1.35;letter-spacing:-.3px;margin:0 0 6px;}
  .ds-item h2 a{color:var(--txt1,#eaf3ff);text-decoration:none;}
  .ds-item h2 a:hover{color:#22d3ee;}
  .ds-dek{font-size:14.5px;line-height:1.6;color:var(--txt2,#a8a8a8);margin:0 0 6px;}
  .ds-by{font-family:var(--mono,ui-monospace),monospace;font-size:11px;letter-spacing:.05em;
    color:var(--txt3,#6e6e6e);}
  article h1{font-size:clamp(25px,4.6vw,36px);line-height:1.18;letter-spacing:-1px;
    color:var(--txt1,#eaf3ff);margin:0 0 10px;}
  article .lead{font-size:17px;line-height:1.65;color:var(--txt2,#a8a8a8);margin:0 0 16px;}
  article .body{font-size:16px;line-height:1.78;color:var(--txt2,#a8a8a8);white-space:pre-wrap;}
  .ds-src{margin-top:26px;padding-top:14px;border-top:1px solid var(--bdr2,#1c1c20);
    font-size:12px;line-height:1.65;color:var(--txt3,#6e6e6e);}
  .ds-cta{margin-top:26px;padding-top:16px;border-top:1px solid var(--bdr,#2c2c30);
    font-size:14.5px;line-height:1.7;color:var(--txt2,#a8a8a8);}
  .ds-cta a{color:#22d3ee;font-weight:700;text-decoration:none;}
  .ds-empty{padding:20px 0;color:var(--txt3,#6e6e6e);font-size:14px;line-height:1.7;}
</style>
${_CHROME.HEADER}
<div class="ds-wrap">
  <div class="ds-mast"><a href="/daily-strike"><span class="ds-name">${MASTHEAD}</span>
  <span class="ds-tag">${TAGLINE}</span></a></div>
${inner}
</div>
${_CHROME.FOOTER}${_CHROME.SCRIPT || ''}
</body></html>`;
}

async function readIndex() {
  const r = kv();
  if (r) {
    try {
      const hit = await r.get(IDX_KEY);
      if (hit) return typeof hit === 'string' ? JSON.parse(hit) : hit;
    } catch (_) { /* fall through to blob */ }
  }
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

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(503).json({ error: 'blob not configured' });
  const r = kv();
  if (!r) return res.status(503).json({ error: 'kv unavailable' });

  // ── the inputs: the market wire, and the book nobody else can see ──
  const g = (p) => p.catch(() => null);
  const [rawWire, rawLevels, rawTrack, rawCal] = await Promise.all([
    g(r.get('rh:news:MARKET')), g(r.get('analyst:live_levels')),
    g(r.get('novo:track_record')), g(r.get('rh:earnings_calendar')),
  ]);
  const J = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch (_) { return null; } };
  const wire = J(rawWire), levels = J(rawLevels), track = J(rawTrack), cal = J(rawCal);
  const arts = (wire && wire.data && wire.data.articles) || [];
  if (!arts.length) {
    // No wire, no story. A desk that writes anyway is inventing the news.
    return res.status(200).json({ ok: false, note: 'no wire to write from' });
  }

  const headlines = arts.slice(0, 18).map((a, i) =>
    `${i + 1}. "${a.title}" — ${a.publisher}, ${a.published_at}`).join('\n');
  const book = (levels && Array.isArray(levels.tickers))
    ? levels.tickers.map((t) => `${t.ticker}: spot ${t.spot}, ${t.regime || 'regime unknown'}, `
        + `flip ${t.flip}, call wall ${t.callWall}, put wall ${t.putWall}, `
        + `expected move ±${t.expectedMovePct}%`).join('\n')
    : '(no live dealer state)';
  const rec = (track && track.tickers) ? JSON.stringify(track.tickers).slice(0, 1200) : '(none)';
  const cals = (cal && cal.events) ? cal.events.slice(0, 8)
      .map((e) => `${e.date} ${e.symbol} Q${e.quarter}`).join('; ') : '(none)';

  const prompt = [
`You are writing today's story for OPEN INTEREST, the NoVo market desk — a public column under
your own byline. One story. It goes on the open web where anyone can read it.

WHAT MAKES THIS OURS AND NOT A REPRINT: the wire says what happened. You say what it did to the
dealer book — the level that moved, the regime it sits in, what setups like this have resolved to.
That second half is the whole reason the piece exists. Lead with the news, land on the structure.

THE WIRE (what publishers filed, newest first):
${headlines}

THE BOOK RIGHT NOW (ours, and the part no headline carries):
${book}

THE SCORED RECORD (what these setups have actually done):
${rec}

UPCOMING REPORTERS: ${cals}

RULES — these are not style notes, they are the contract:
1. ATTRIBUTE. Any fact off the wire names the publisher in the sentence: "Benzinga reported…",
   "per MT Newswires…". A headline is evidence something was SAID, not that it is true.
2. A FORECAST IN A HEADLINE STAYS ITS AUTHOR'S. "Goldman's target is 6,200" — never "6,200 looks
   likely". You do not adopt another desk's call, and you do not make one of your own here.
3. NO METHOD. Name levels, regimes, rates and sample sizes. NEVER the thresholds, bands or
   arithmetic behind how anything is graded or computed.
4. NOT ADVICE. No buy, no sell, no should, no target. You explain the book; the reader decides.
5. EVERY NUMBER COMES FROM ABOVE. If it is not in this prompt, it does not go in the story.
6. If the wire is thin, write the shorter, quieter piece. Never pad, never dramatise a flat tape.

FORMAT — return STRICT JSON and nothing else:
{"headline":"<= 70 chars, plain and specific, no clickbait, no colon-subtitle>",
 "dek":"<one sentence, <= 180 chars, what the piece establishes>",
 "body":"<350-550 words, plain paragraphs separated by a blank line. No markdown, no headers,
          no bullet lists. Your own voice.>",
 "tickers":["SPY"],
 "sources":["Benzinga","MT Newswires"]}`,
  ].join('\n');

  let out = '';
  try {
    const resp = await vertex(`${MODEL}:generateContent`, {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2400, responseMimeType: 'application/json',
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
  // A story that lost its attribution is not publishable — the rule is structural, so it is
  // checked here rather than trusted from the model.
  if (!Array.isArray(story.sources) || !story.sources.length) {
    return res.status(422).json({ error: 'story carried no sources; refusing to publish' });
  }

  const now = Date.now();
  const d = new Date(now);
  const slug = `${d.toISOString().slice(0, 10)}-${slugify(story.headline)}`.slice(0, 90);
  const rowDoc = {
    slug, headline: String(story.headline).slice(0, 140),
    dek: String(story.dek || '').slice(0, 240),
    body: String(story.body).slice(0, 12000),
    tickers: Array.isArray(story.tickers) ? story.tickers.slice(0, 6) : [],
    sources: story.sources.slice(0, 8),
    publishedAt: now,
    byline: 'Dr. NoVo',
  };

  await put(`${PREFIX}${slug}.json`, JSON.stringify(rowDoc),
    { access: 'public', token, contentType: 'application/json', addRandomSuffix: false,
      allowOverwrite: true });

  const idx = await readIndex();
  const next = [{ slug, headline: rowDoc.headline, dek: rowDoc.dek,
                  publishedAt: now, tickers: rowDoc.tickers }]
    .concat(idx.filter((x) => x.slug !== slug));
  await writeIndex(next);

  return res.status(200).json({ ok: true, slug, url: `${SITE}/daily-strike/${slug}`,
    words: rowDoc.body.split(/\s+/).length, sources: rowDoc.sources });
}

/* ── THE READER ───────────────────────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  if (req.method === 'POST') return writeStory(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET or POST' });

  const slug = String((req.query && req.query.slug) || '').replace(/[^a-z0-9-]/gi, '').slice(0, 90);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=1800');

  if (slug) {
    const story = await loadStory(slug, process.env.BLOB_READ_WRITE_TOKEN);
    if (!story) {
      return res.status(404).send(_page(`Not found — ${MASTHEAD}`, 'This story is not available.',
        `${SITE}/daily-strike`,
        `<article><h1>That story is not here.</h1><p class="lead">It may have been renamed. `
        + `<a href="/daily-strike" style="color:#22d3ee;">Back to ${MASTHEAD}</a>.</p></article>`,
        '<meta name="robots" content="noindex, follow">'));
    }
    const when = new Date(story.publishedAt);
    const body = esc(story.body);
    const ld = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'NewsArticle',
      headline: String(story.headline).slice(0, 110),
      description: story.dek || '',
      datePublished: when.toISOString(), dateModified: when.toISOString(),
      mainEntityOfPage: `${SITE}/daily-strike/${slug}`,
      image: `${SITE}/og-default.png?v=4`,
      articleSection: 'Markets',
      author: { '@type': 'Person', name: 'Dr. NoVo',
                description: 'The AI market analyst at NoVo Options Trading', url: `${SITE}/ai` },
      publisher: { '@type': 'Organization', name: 'NoVo Options Trading', url: `${SITE}/`,
                   logo: { '@type': 'ImageObject', url: `${SITE}/novo-logo.png?v=1` } },
      isAccessibleForFree: true,
    });
    const inner = `<article>
  <h1>${esc(story.headline)}</h1>
  ${story.dek ? `<p class="lead">${esc(story.dek)}</p>` : ''}
  <div class="ds-by">${esc(story.byline || 'Dr. NoVo')} &middot; ${when.toLocaleString('en-US',
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET</div>
  <div class="body" style="margin-top:16px;">${body}</div>
  <div class="ds-src">Written by Dr. NoVo, the AI market analyst at NoVo Options Trading, from the
    day's wire and our own dealer-positioning data. Reporting cited in this piece is the work of
    ${esc((story.sources || []).join(', '))} and is attributed in the text.
    Nothing here is investment advice or a recommendation to trade.</div>
  <div class="ds-cta">The book this piece reads from updates every 60 seconds on the dashboards.
    <a href="/plans">See the plans</a> &middot; <a href="/track-record">The scored record</a>
    &middot; <a href="/daily-strike">More from ${MASTHEAD}</a></div>
</article>`;
    return res.status(200).send(_page(`${story.headline} | ${MASTHEAD}`,
      story.dek || String(story.body).slice(0, 155), `${SITE}/daily-strike/${slug}`, inner,
      `<script type="application/ld+json">${ld}</script>`));
  }

  // ── the index ──
  const items = await readIndex();
  const inner = items.length
    ? items.slice(0, 40).map((s) => {
        const w = new Date(s.publishedAt);
        return `<div class="ds-item"><h2><a href="/daily-strike/${esc(s.slug)}">${esc(s.headline)}</a></h2>`
          + (s.dek ? `<p class="ds-dek">${esc(s.dek)}</p>` : '')
          + `<div class="ds-by">Dr. NoVo &middot; ${w.toLocaleString('en-US',
              { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}`
          + ((s.tickers && s.tickers.length) ? ` &middot; ${esc(s.tickers.join(' · '))}` : '')
          + `</div></div>`;
      }).join('')
    : `<div class="ds-empty">The first story publishes shortly. ${MASTHEAD} is written by
       Dr. NoVo off the day's wire and our own dealer-positioning data &mdash; the headline is
       the news, the book is the part nobody else prints.</div>`;

  const head = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: `${MASTHEAD} — ${TAGLINE}`,
    description: 'Market stories written by Dr. NoVo from the day\'s wire and NoVo\'s own '
               + 'dealer-positioning data.',
    url: `${SITE}/daily-strike`, isAccessibleForFree: true,
    publisher: { '@type': 'Organization', name: 'NoVo Options Trading', url: `${SITE}/` },
  })}</script>`;

  return res.status(200).send(_page(
    `${MASTHEAD} — market news from the dealer's book | NoVo`,
    'Market stories written by Dr. NoVo from the day\'s wire and our own dealer-positioning data: '
    + 'the headline is the news, the book is what it did.',
    `${SITE}/daily-strike`,
    `<p class="ds-dek" style="margin:-8px 0 18px;">The wire says what happened. This desk says what
     it did to the book &mdash; the level that moved, the regime it sits in, and what setups like
     it have resolved to before.</p>${inner}`, head));
};
