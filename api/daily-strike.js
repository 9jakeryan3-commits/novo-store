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

/* ── LINKING THE STORY INTO THE FREE DATA (Jake: "link the site into The Daily Strike, any free
   data that makes sense, land in the entries cleanly") ──────────────────────────────────────
   A ticker named in a story has a free gamma page on this site; a macro word has a calendar; a
   member of Congress has a disclosure tracker. Those are OUR pages, so linking them is internal
   link equity AND a genuinely better read — a reader who hits "the 765 call wall" can go look at
   the ladder that produced it.
   ⚠ LINKED ONCE, FIRST MENTION ONLY, and never inside a word: a story with SPY linked nine times
   reads as SEO spam, which is the opposite of the credibility this desk is for. The escaped body
   is what gets linked, so no markup can arrive from the model. */
const AUTOLINK = [
  ['SPY', '/market-data/spy', 'the free SPY gamma map'],
  ['QQQ', '/market-data/qqq', 'the free QQQ gamma map'],
  ['IWM', '/market-data/iwm', 'the free IWM gamma map'],
  ['VIX', '/vol', 'the volatility record'],
  ['CPI', '/economic-calendar', 'the economic calendar'],
  ['FOMC', '/economic-calendar', 'the economic calendar'],
  ['max pain', '/tools/max-pain-calculator', 'the max pain calculator'],
  ['expected move', '/tools/expected-move', 'the expected move calculator'],
  ['gamma flip', '/learn/gamma-gex-dealer-positioning', 'what a gamma flip is'],
];
function autolink(escapedBody) {
  let out = escapedBody;
  for (const [term, href, title] of AUTOLINK) {
    // word-boundaried, case-sensitive for tickers, first occurrence only
    const re = new RegExp('(^|[\\s(\\[])(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?=[\\s.,;:)\\]]|$)');
    const m = out.match(re);
    if (!m) continue;
    out = out.replace(re, '$1<a href="' + href + '" title="' + title
      + '" style="color:var(--txt1,#eaf3ff);text-decoration:none;border-bottom:1px solid rgba(34,211,238,.45);">$2</a>');
  }
  return out;
}

/* ── THE HOUSE ADS (Jake: "make ads for the products we sell") ──────────────────────────────
   Not a banner and not a box — the house rule bans both. These are hairline-separated blocks in
   the desk's own voice that name what the reader just read and where the full version lives.
   Colour-only CTA, per the standing treatment. Rotated by index so a reader scrolling the front
   page does not see the same pitch three times. */
const HOUSE_ADS = [
  { eyebrow: 'The map this desk reads',
    line: 'Every level in these stories — the flip, the walls, gravity, the expected move — is on the '
        + 'Analyst dashboard, remapped every 60 seconds for SPY, QQQ and IWM.',
    cta: 'See the Analyst desk', href: '/analyst' },
  { eyebrow: 'Same map, on a live chart',
    line: 'Trader streams the dealer levels onto a candle chart with an hourly structural audit, '
        + 'saved layouts, and the levels drawn where price meets them.',
    cta: 'See the Trader terminal', href: '/trader' },
  { eyebrow: 'The 24/7 book',
    line: 'Crypto expires every day at 08:00 UTC, so the pin repeats 365 times a year. The Crypto '
        + 'Market Map carries dealer gamma, funding by venue and the vol surface across the majors.',
    cta: 'See the Crypto map', href: '/crypto' },
  { eyebrow: 'Ask the desk',
    line: 'Dr. NoVo writes these pieces. On a subscription he answers your questions off the same '
        + 'live book, with the sample size attached to every historical claim.',
    cta: 'Meet Dr. NoVo', href: '/ai' },
];
function houseAd(i) {
  const a = HOUSE_ADS[i % HOUSE_ADS.length];
  return `<div style="margin:26px 0;padding:16px 0;border-top:1px solid var(--bdr,#2c2c30);
    border-bottom:1px solid var(--bdr2,#1c1c20);max-width:78ch;">
    <div style="font-family:var(--mono,ui-monospace),monospace;font-size:9.5px;letter-spacing:.18em;
      text-transform:uppercase;color:var(--txt3,#6e6e6e);">${a.eyebrow}</div>
    <div style="font-size:14.5px;line-height:1.65;color:var(--txt2,#a8a8a8);margin:6px 0 8px;">${a.line}</div>
    <a href="${a.href}" style="color:#22d3ee;font-weight:700;text-decoration:none;font-size:14px;">${a.cta} &rarr;</a>
  </div>`;
}

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
  .ds-cell{flex:1 1 150px;padding:11px 14px 11px 0;}
  .ds-cell:last-child{border-right:0;}
  .ds-ck{font-family:var(--mono,ui-monospace),monospace;font-size:9.5px;letter-spacing:.16em;
    text-transform:uppercase;color:var(--txt3,#6e6e6e);}
  .ds-cv{font-size:15px;font-weight:800;color:var(--txt1,#eaf3ff);margin-top:3px;letter-spacing:-.2px;}
  .ds-cs{font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;margin-top:2px;}
  .ds-up{color:#10b981;} .ds-dn{color:#f43f5e;} .ds-nu{color:var(--txt3,#6e6e6e);}
  /* ⚠ TWO COLUMNS, BECAUSE THE MARKUP HAS TWO CHILDREN (Jake, 09-12: "doesnt present as a front
     door... appears half built"). This declared THREE tracks at >=1500px while the markup only
     ever emitted one div plus one aside, so on a 1920 screen the third 360px track rendered as a
     dead band of empty space down the right-hand side. The page was not under-designed there —
     (no backticks anywhere in this block: the whole page is one template literal, so a stray
      backtick in a COMMENT ends the string and the next word is parsed as an identifier)
     it was correctly drawing a column with nothing in it. The width now goes to the CONTENT
     instead: the section bands below run 2-up once there is room, which fills the same space with
     stories and cannot desync from the child count the way a hardcoded track list did. */
  .ds-cols{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:40px;align-items:start;}
  @media (min-width:1500px){.ds-cols{gap:48px;}}
  @media (max-width:860px){.ds-cols{grid-template-columns:1fr;gap:22px;}}
  /* The bands are the grid items, so a desk running two kinds of story fills the width and a desk
     running one still reads as a column rather than a half-empty row. */
  .ds-secs{display:grid;grid-template-columns:1fr;gap:0 44px;align-items:start;}
  @media (min-width:1500px){.ds-secs{grid-template-columns:1fr 1fr;}}
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
  /* THE SECTION STRIP — the convention every other front door on this site already uses (the
     Journal's THE ANGLE / OPTIONS / MARKET STRUCTURE row). Its absence was a real part of why
     this read as half-built: a reader landing here had no idea the page HAD sections, because
     the only way to discover them was to scroll. Hairline underneath, no boxes, colour-only
     hover — the site's rule. Built from the sections that actually rendered, never a fixed list,
     so it can never advertise a band that is not on the page. */
  .ds-secnav{display:flex;flex-wrap:wrap;gap:0 26px;border-bottom:1px solid var(--bdr,#2c2c30);
    margin-bottom:22px;padding-bottom:0;}
  .ds-secnav a{font-family:var(--mono,ui-monospace),monospace;font-size:10.5px;letter-spacing:.18em;
    text-transform:uppercase;color:var(--txt3,#6e6e6e);text-decoration:none;padding:11px 0;
    border-bottom:1px solid transparent;margin-bottom:-1px;}
  .ds-secnav a:hover{color:#22d3ee;border-bottom-color:#22d3ee;}
  @media (max-width:860px){.ds-secnav{gap:0 18px;overflow-x:auto;flex-wrap:nowrap;white-space:nowrap;}}
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

  /* ── VISUAL PASS (Tema, 2026-09-12) — Jake: "the page is bland as hell ... this needs to
     compete with the best financial markets news outlet online." The bones were fine; what read
     flat was one accent colour on everything and the regime strip — the only thing here no other
     outlet can print — set as small grey text. ──────────────────────────────────────────── */
/* ── 1. THE REGIME STRIP IS THE SIGNATURE ─────────────────────────────────────
   This is the one thing on the page no other outlet can print, and it was set as
   small grey text. Price becomes display-weight; the regime carries the colour. */
.ds-cell{ padding:15px 20px 15px 0; border-top:2px solid var(--bdr2,#1c1c20); }
.ds-cell:has(.ds-up){ border-top-color:#10b981; }
.ds-cell:has(.ds-dn){ border-top-color:#f59e0b; }
.ds-ck{ font-size:10.5px; letter-spacing:.22em; text-transform:uppercase; color:var(--txt3,#6e6e6e); }
.ds-cv{
  font-family:"Space Grotesk",system-ui,sans-serif;
  font-size:clamp(26px,2.2vw,34px); font-weight:700; letter-spacing:-1px; line-height:1.04;
  margin:7px 0 6px; color:var(--txt1,#eaf3ff); font-variant-numeric:tabular-nums;
}
.ds-cs{ font-size:12.5px; line-height:1.5; font-variant-numeric:tabular-nums; }
.ds-cs.ds-up .rg{ color:#10b981; font-weight:700; }
.ds-cs.ds-dn .rg{ color:#f59e0b; font-weight:700; }
.ds-cs .flip{ color:var(--txt2,#a8a8a8); }

/* ── 2. SECTION RHYTHM ────────────────────────────────────────────────────────
   Four sections all in the same grey is most of why the page reads monotone.
   Coloured on a single-side rule, the same device the journal cards already use. */
.ds-sech{ font-size:10.5px; letter-spacing:.22em; border-top:2px solid var(--bdr2,#1c1c20); padding-top:9px; }
.ds-secs .ds-sec:nth-of-type(1) .ds-sech{ color:#f59e0b; border-top-color:#f59e0b; }
.ds-secs .ds-sec:nth-of-type(2) .ds-sech{ color:#a78bfa; border-top-color:#a78bfa; }
.ds-secs .ds-sec:nth-of-type(3) .ds-sech{ color:#10b981; border-top-color:#10b981; }
.ds-secs .ds-sec:nth-of-type(4) .ds-sech{ color:#22d3ee; border-top-color:#22d3ee; }

/* the section nav should show where you are, not read as a grey word list */
.ds-secnav a{ position:relative; padding:12px 0 13px; font-size:11px; letter-spacing:.16em; }
.ds-secnav a:hover{ color:var(--txt1,#eaf3ff); }
.ds-secnav a::after{
  content:""; position:absolute; left:0; right:0; bottom:-1px; height:2px;
  background:#22d3ee; transform:scaleX(0); transition:transform .14s ease;
}
.ds-secnav a:hover::after{ transform:scaleX(1); }

/* ── 3. HIERARCHY — the lead barely out-weighed the rail ──────────────────────*/
.ds-lead h1, .ds-lead h2{
  font-family:"Space Grotesk",system-ui,sans-serif;
  font-size:clamp(30px,3.3vw,44px); font-weight:700; letter-spacing:-1.1px; line-height:1.09;
  margin:0 0 13px;
}
.ds-lead .ds-dek{ font-size:17px; line-height:1.6; max-width:60ch; }
.ds-dek{ color:var(--txt2,#a8a8a8); }
.ds-by{ font-size:11.5px; letter-spacing:.03em; margin-top:13px; }

/* ── 4. THE RAIL — five identical rows read as a batch dump, not a desk ───────*/
.ds-rrow{ padding:13px 0; align-items:baseline; }
.ds-rrow:last-child{ border-bottom:0; }
.ds-rt{ min-width:64px; letter-spacing:.08em; font-variant-numeric:tabular-nums; }
.ds-rh{ font-size:14px; line-height:1.42; font-weight:600; }
.ds-rrow:first-child .ds-rh{ font-size:16px; line-height:1.32; }
.ds-rrow:hover .ds-rh{ color:#22d3ee; }

/* ── 5. WIDTH — a 360px rail left a dead column on a 1920 screen ──────────────*/
@media (min-width:1500px){ .ds-cols{ grid-template-columns:minmax(0,1fr) 400px; gap:56px; } }

  /* The rail led with the clock, and five stories written in one pass all read "1 hour ago",
     which says batch. They are five different DESKS — the thing this page is actually built on —
     so the desk leads and the clock follows it. */
  .ds-rrow{display:block;padding:13px 0;}
  .ds-rmeta{display:flex;align-items:baseline;gap:9px;margin-bottom:5px;}
  .ds-rk{font-family:var(--mono,ui-monospace),monospace;font-size:9.5px;letter-spacing:.18em;
    text-transform:uppercase;font-weight:700;color:#22d3ee;}
  .ds-rk[data-k="earnings"]{color:#f59e0b;}
  .ds-rk[data-k="crypto"]{color:#a78bfa;}
  .ds-rk[data-k="level"]{color:#10b981;}
  .ds-rt{min-width:0;font-size:10px;opacity:.72;padding-top:0;}
  .ds-rh{font-size:14px;line-height:1.4;font-weight:600;}
  .ds-rrow:first-child .ds-rh{font-size:16px;line-height:1.3;}
</style>
</head>
<body>
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
      + `<div class="ds-cs ${cls}"><span class="rg">${word}</span>${t.flip != null ? ` · <span class="flip">flip ${esc(String(t.flip))}</span>` : ''}</div></div>`;
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

  /* ── THE MACHINERY AGGREGATORS ACTUALLY READ ────────────────────────────────────────────
     Jake: "make The Daily Strike land on the news outlet map." An outlet is discovered through
     its FEED and its news sitemap, not by hoping a crawler stumbles onto a page. Both are
     served from THIS module rather than generated into /public, because either one disagreeing
     with the index is worse than not having it — a feed that lists a story the site does not
     serve is how an aggregator drops a publisher. */
  const fmt = String((req.query && req.query.format) || '');
  if (fmt === 'rss' || fmt === 'news-sitemap') {
    const fidx = await readIndex();
    if (fmt === 'rss') {
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
      const its = fidx.slice(0, 50).map((s) =>
        '<item><title>' + esc(s.headline) + '</title>'
        + '<link>' + SITE + '/daily-strike/' + esc(s.slug) + '</link>'
        + '<guid isPermaLink="true">' + SITE + '/daily-strike/' + esc(s.slug) + '</guid>'
        + '<pubDate>' + new Date(s.publishedAt).toUTCString() + '</pubDate>'
        + '<category>' + esc(s.kindLabel || 'Markets') + '</category>'
        + '<dc:creator>Dr. NoVo</dc:creator>'
        + (s.dek ? '<description>' + esc(s.dek) + '</description>' : '')
        + '</item>').join('\n');
      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" '
        + 'xmlns:dc="http://purl.org/dc/elements/1.1/">\n<channel>\n'
        + '<title>' + MASTHEAD + '</title>\n<link>' + SITE + '/daily-strike</link>\n'
        + '<description>Market stories written by Dr. NoVo from the day&#39;s wire and NoVo&#39;s '
        + 'own dealer-positioning data.</description>\n<language>en</language>\n'
        + '<atom:link href="' + SITE + '/daily-strike/feed.xml" rel="self" type="application/rss+xml"/>\n'
        + its + '\n</channel>\n</rss>');
    }
    // Google News reads only the last 48 hours. Sending older items is how a news sitemap gets
    // ignored outright rather than partially honoured.
    const cut = Date.now() - 48 * 3600 * 1000;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    const urls = fidx.filter((s) => s.publishedAt >= cut).slice(0, 1000).map((s) =>
      '<url>\n<loc>' + SITE + '/daily-strike/' + esc(s.slug) + '</loc>\n'
      + '<news:news><news:publication><news:name>' + MASTHEAD + '</news:name>'
      + '<news:language>en</news:language></news:publication>'
      + '<news:publication_date>' + new Date(s.publishedAt).toISOString() + '</news:publication_date>'
      + '<news:title>' + esc(s.headline) + '</news:title></news:news>\n</url>').join('\n');
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
      + 'xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n' + urls + '\n</urlset>');
  }

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
    /* Three levels on a story page, matching the rest of the site — and it is the crumb Google
       reads for the article's place in the hierarchy, not decoration. */
    const inner = `<nav class="crumbs" aria-label="Breadcrumb" style="max-width:none;padding:0 0 14px;">
  <a href="/">Home</a><span class="sep">&rsaquo;</span><a href="/daily-strike">${MASTHEAD}</a>
  <span class="sep">&rsaquo;</span><span class="cur">${esc(story.kindLabel || 'Markets')}</span></nav>
<div class="ds-mast"><a href="/daily-strike"><span class="ds-name">${MASTHEAD}</span>
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
  <div class="body" style="margin-top:16px;">${autolink(esc(story.body))}</div>
  ${houseAd(story.kind === 'crypto' ? 2 : (story.publishedAt % 3))}
  <div class="ds-src">Written by Dr. NoVo, the AI market analyst at NoVo Options Trading, from the
    day's wire and our own dealer-positioning data.${(story.sources || []).length
      ? ` Reporting cited in this piece is the work of ${esc(story.sources.join(', '))} and is
        attributed in the text.` : ''}
    Nothing here is investment advice or a recommendation to trade.</div>
  <div class="ds-cta">The book this piece reads from updates every 60 seconds on the dashboards.
    <a href="/plans">See the plans</a> &middot; <a href="/track-record">The scored record</a></div>
</article></div>
<aside class="ds-rail"><h4>More from the desk</h4>${more.map((s) =>
  `<div class="ds-rrow"><div class="ds-rmeta">`
        + `<span class="ds-rk" data-k="${esc(String(s.kind || 'markets'))}">${esc(s.kindLabel || 'Markets')}</span>`
        + `<span class="ds-rt">${esc(ago(s.publishedAt))}</span></div>`
        + `<div class="ds-rh"><a href="/daily-strike/${esc(s.slug)}">${esc(s.headline)}</a></div></div>`).join('')
  || '<div class="ds-empty">More desks publish through the session.</div>'}</aside></div>`;
    return res.status(200).send(_page(`${story.headline} | ${MASTHEAD}`,
      story.dek || String(story.body).slice(0, 155), `${SITE}/daily-strike/${slug}`, inner,
      `<script type="application/ld+json">${ld}</script>`));
  }

  // ── the front page ──
  const items = await readIndex();
  const strip = await regimeStrip();
  /* NewsMediaOrganization, not a generic Organization — this is the schema that tells Google
     the site IS a publication rather than a company that happens to have a blog, and it is what
     a News listing is assessed against. The feed is declared in the head too: an aggregator that
     lands on the front page should never have to guess where the feed lives. */
  const head = `<link rel="alternate" type="application/rss+xml" title="${MASTHEAD}" href="${SITE}/daily-strike/feed.xml">
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: `${MASTHEAD} — ${TAGLINE}`,
    description: 'Market stories written by Dr. NoVo from the day\'s wire and NoVo\'s own '
               + 'dealer-positioning data.',
    url: `${SITE}/daily-strike`, isAccessibleForFree: true,
    publisher: {
      '@type': 'NewsMediaOrganization', name: MASTHEAD, url: `${SITE}/daily-strike`,
      parentOrganization: { '@type': 'Organization', name: 'NoVo Options Trading', url: `${SITE}/` },
      logo: { '@type': 'ImageObject', url: `${SITE}/novo-logo.png?v=1` },
      diversityPolicy: `${SITE}/about`, ethicsPolicy: `${SITE}/about`,
      masthead: `${SITE}/daily-strike`,
    },
    mainEntity: { '@type': 'ItemList', itemListElement: items.slice(0, 10).map((s, i) => ({
      '@type': 'ListItem', position: i + 1, url: `${SITE}/daily-strike/${s.slug}`, name: s.headline,
    })) },
  })}</script>`;

  /* The breadcrumb every other page on this site carries. build-site-chrome deliberately stops the
     header BEFORE the crumb because it is per-page — and this page, being server-rendered, simply
     never rendered its own. `.crumbs` is styled in polish.css (which the chrome links), but its
     1180px cap centres it, and this page runs full-bleed; the override lines it up with the
     masthead's left edge instead of floating it in the middle of a wide screen. */
  const crumbs = `<nav class="crumbs" aria-label="Breadcrumb" style="max-width:none;padding:0 0 14px;">`
    + `<a href="/">Home</a><span class="sep">&rsaquo;</span><span class="cur">${MASTHEAD}</span></nav>`;

  const mast = `<div class="ds-mast"><a href="/daily-strike"><span class="ds-name">${MASTHEAD}</span>
  <span class="ds-tag">${TAGLINE}</span></a>
  <span class="ds-live">${items.length ? `<b>&bull;</b> updated ${esc(ago(items[0].publishedAt))}`
    : 'the desk opens shortly'}</span></div>${strip}`;

  if (!items.length) {
    return res.status(200).send(_page(`${MASTHEAD} — market news from the dealer's book | NoVo`,
      'Market stories written by Dr. NoVo from the day\'s wire and our own dealer-positioning data.',
      `${SITE}/daily-strike`,
      crumbs + mast + `<div class="ds-empty">The first story publishes shortly. ${MASTHEAD} is written by
        Dr. NoVo off the day's wire and our own dealer-positioning data &mdash; the headline is the
        news, the book is the part nobody else prints.</div>`, head));
  }

  const lead = items[0];
  /* The sections used to start at index 9, so a desk with five stories rendered a hero and then
     a hole where the page should be. Sections now take everything after the lead; the rail
     repeating them is ordinary newsroom shape — CNBC's Latest rail repeats its own grid. */
  const rail = items.slice(0, 8);
  const rest = items.slice(1, 40);
  const bySec = {};
  for (const s of rest) (bySec[s.kindLabel || 'Markets'] = bySec[s.kindLabel || 'Markets'] || []).push(s);

  /* The section strip is built from the bands that ACTUALLY rendered, so it can never advertise a
     section the page does not have — the newsroom version of a check that cannot fail. */
  const secKeys = Object.keys(bySec);
  const anchor = (s) => 'sec-' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const secnav = secKeys.length > 1
    ? `<nav class="ds-secnav" aria-label="Sections">${secKeys
        .map((s) => `<a href="#${anchor(s)}">${esc(s)}</a>`).join('')}</nav>`
    : '';

  const inner = crumbs + mast + secnav + `<div class="ds-cols">
  <div>
    <div class="ds-lead">
      ${lead.kindLabel ? `<div class="ds-kicker">${esc(lead.kindLabel)}</div>` : ''}
      <h2><a href="/daily-strike/${esc(lead.slug)}">${esc(lead.headline)}</a></h2>
      ${lead.dek ? `<p class="ds-dek">${esc(lead.dek)}</p>` : ''}
      <div class="ds-by">Dr. NoVo &middot; ${esc(ago(lead.publishedAt))}${
        (lead.tickers && lead.tickers.length) ? ` &middot; ${esc(lead.tickers.join(' · '))}` : ''}</div>
    </div>
    <div class="ds-secs">
    ${secKeys.map((sec, si) => `<div class="ds-sec" id="${anchor(sec)}"><div class="ds-sech">${esc(sec)}</div>`
      + bySec[sec].map((s) => `<div class="ds-item">
          <h3><a href="/daily-strike/${esc(s.slug)}">${esc(s.headline)}</a></h3>
          ${s.dek ? `<p class="ds-dek">${esc(s.dek)}</p>` : ''}
          <div class="ds-by">Dr. NoVo &middot; ${esc(ago(s.publishedAt))}${
            (s.tickers && s.tickers.length) ? ` &middot; ${esc(s.tickers.join(' · '))}` : ''}</div></div>`).join('')
      + `</div>` + (si === 0 ? houseAd(3) : '')).join('')}
    ${houseAd(1)}
      </div>
  </div>
  <aside class="ds-rail">
    <h4>Latest from the desk</h4>
    ${rail.map((s) => `<div class="ds-rrow"><div class="ds-rmeta">`
        + `<span class="ds-rk" data-k="${esc(String(s.kind || 'markets'))}">${esc(s.kindLabel || 'Markets')}</span>`
        + `<span class="ds-rt">${esc(ago(s.publishedAt))}</span></div>`
        + `<div class="ds-rh"><a href="/daily-strike/${esc(s.slug)}">${esc(s.headline)}</a></div></div>`).join('')
      || '<div class="ds-empty">More desks publish through the session.</div>'}
    ${houseAd(0)}
    <h4 style="margin-top:26px;">Free, no account</h4>
    <div class="ds-rh" style="padding:6px 0 0;font-size:13px;line-height:2;">
      <a href="/market-data/spy">SPY gamma map</a> &middot; <a href="/market-data/qqq">QQQ</a>
      &middot; <a href="/market-data/iwm">IWM</a><br>
      <a href="/economic-calendar">Economic calendar</a> &middot;
      <a href="/congress">Congress trades</a><br>
      <a href="/vol">Volatility record</a> &middot;
      <a href="/positioning">Futures positioning</a><br>
      <a href="/track-record">The scored record</a> &middot;
      <a href="/tools/max-pain-calculator">Max pain</a>
    </div>
    ${houseAd(2)}
    <h4 style="margin-top:26px;">What this desk reads</h4>
    <div class="ds-rh" style="padding:4px 0 10px;color:var(--txt3,#6e6e6e);font-size:12.5px;line-height:1.6;">
      Every story here is written off live dealer positioning &mdash; the gamma flip, the walls,
      the expected move and the scored record behind them. The wire says what happened;
      <a href="/plans" style="color:#22d3ee;">the map says what it did</a>.
      <br><br><a href="/daily-strike/feed.xml" style="color:var(--txt3,#6e6e6e);">RSS feed</a>
    </div>
  </aside></div>`;

  return res.status(200).send(_page(
    `${MASTHEAD} — market news from the dealer's book | NoVo`,
    'Market stories written by Dr. NoVo from the day\'s wire and our own dealer-positioning data: '
    + 'the headline is the news, the book is what it did.',
    `${SITE}/daily-strike`, inner, head));
};
