#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────────
   build-search-index.js — regenerate public/journal/search-index.json from what
   the site actually publishes.

   Why this exists: the index was hand-maintained, so it drifted in both
   directions at once and nothing ever noticed.

     - 21 entries pointed at articles deleted in the duplicate-merge pass. Those
       are search results that 404.
     - ALL EIGHT crypto articles were missing. The $79 product's entire education
       surface — Bitcoin gamma, funding, DVOL, liquidation cascades, the 08:00 UTC
       expiry — could not be found by the Journal's own search box.

   WIDENED 2026-09-01 (Jake: "one index, search bar in the header"). It used to
   walk public/journal/ only, so 214 of 1,500 published pages could not be found
   by any search box on the site: all 92 coin pages, all 73 archive notes, the
   tools, the learn guides, the compare pages, and every product page. The archive
   was the worst of it — it grows daily, so the gap widened on its own every day.

   THE SITEMAP IS THE SOURCE, not a directory walk. That is deliberate: it means
   search can never offer a page Google cannot see, noindex pages stay out for
   free, and anything a future build adds to the sitemap becomes searchable with
   no change here. Parity is the invariant — if this count and the sitemap count
   disagree, one of them is wrong.

   Three kinds of URL, because the site has three:
     - a file on disk                       (/journal/x.html, /crypto/btc)
     - a clean URL backed by a rewrite      (/compare/novo-vs-spotgamma)
     - server-rendered, no file at all      (/analyst/archive/:slug)
   The last kind is fetched once and then REUSED from the previous index on every
   later build: a published desk note never changes, so re-fetching 73 of them
   every deploy would spend a minute to learn nothing. Only genuinely new notes
   cost a request.

   Fields come from the page itself (og:title, kicker, meta description), so a
   page cannot sit in the index describing something it no longer says.

   Wired into scripts/deploy.sh beside build-sitemap.js, and AFTER it — this reads
   the sitemap that build-sitemap.js just wrote. Run it there, not by hand.
   ────────────────────────────────────────────────────────────────────────────── */

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PUB = path.join(__dirname, '..', 'public');
const OUT = path.join(PUB, 'journal', 'search-index.json');
const SITEMAP = path.join(PUB, 'sitemap.xml');
const VERCEL = path.join(__dirname, '..', 'vercel.json');
const ORIGIN = 'https://novo-options.trade';

function pick(html, re) {
  const m = html.match(re);
  return m ? m[1].trim() : '';
}

// Undo only the entities the templates actually emit. The JSON is consumed by
// search.js as text, so a raw &amp; would render literally in a result.
function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&middot;/g, '·')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/* ── the section label a result carries ─────────────────────────────────────── */
function section(url, kicker) {
  if (url.startsWith('/journal/')) return kicker || 'Journal';
  if (url.startsWith('/crypto/')) return 'Coin';
  if (url.startsWith('/analyst/archive')) return 'Archive';
  if (url.startsWith('/compare/') || url.startsWith('/compare-')) return 'Compare';
  if (url.startsWith('/learn/') || url.startsWith('/learn-')) return 'Learn';
  if (url.startsWith('/tools/') || url.startsWith('/tools-')) return 'Tool';
  if (url.startsWith('/market-data')) return 'Market data';
  return kicker || 'NoVo';
}

/* ── URL → file, including the clean URLs that only exist as rewrites ───────── */
const rewrites = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(VERCEL, 'utf8'));
    const map = new Map();
    for (const r of cfg.rewrites || []) {
      if (r.source && r.destination && !r.source.includes(':')) map.set(r.source, r.destination);
    }
    return map;
  } catch (e) {
    console.warn('  ! vercel.json unreadable (' + e.message + ') — clean URLs may not resolve');
    return new Map();
  }
})();

function fileFor(url) {
  const tries = [];
  const dest = rewrites.get(url);
  if (dest) tries.push(dest);
  const p = url.replace(/^\//, '');
  if (!p) tries.push('index.html');
  else tries.push(p, p + '.html', p + '/index.html');
  for (const t of tries) {
    const f = path.join(PUB, t.replace(/^\//, '').split('/').join(path.sep));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

/* ── read the sitemap this build just produced ──────────────────────────────── */
let urls = [];
try {
  const xml = fs.readFileSync(SITEMAP, 'utf8');
  urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].replace(ORIGIN, '') || '/');
} catch (e) {
  console.warn('  ! sitemap unreadable — search index NOT rebuilt (' + e.message + ')');
  process.exit(0);
}

/* ── previous index, so published notes are not re-fetched every build ──────── */
const prevByUrl = new Map();
let prevCount = 0;
try {
  const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  prevCount = prev.length;
  for (const e of prev) {
    if (e.u) prevByUrl.set(e.u, e);
    else if (e.s) prevByUrl.set('/journal/' + e.s + '.html', e);   // pre-widening schema
  }
} catch (_) { /* first run */ }

const out = [];
const skipped = [];
let fetched = 0, reused = 0;

for (const url of urls) {
  const f = fileFor(url);
  let html = null;

  if (f) {
    html = fs.readFileSync(f, 'utf8');
  } else if (prevByUrl.has(url)) {
    out.push(prevByUrl.get(url));       // server-rendered and already known
    reused++;
    continue;
  } else {
    // No file, never seen: fetch it once. Best-effort — one unreachable page must
    // not cost the whole index.
    try {
      html = execSync('curl -sS --max-time 20 -A novo-build ' + JSON.stringify(ORIGIN + url),
                      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      fetched++;
    } catch (e) {
      skipped.push(url + ' (unreachable)');
      continue;
    }
  }

  const t = pick(html, /<meta property="og:title" content="([^"]*)"/) ||
            pick(html, /<h1[^>]*>([^<]*)<\/h1>/) ||
            pick(html, /<title>([^<|]*)/);
  const d = pick(html, /<meta name="description" content="([^"]*)"/);
  const k = pick(html, /<div class="kicker">([^<]*)<\/div>/);

  // A page with no title or no description cannot be a useful search result, and
  // guessing one would put a wrong answer in the box. Report it instead.
  if (!t || !d) {
    skipped.push(url + (t ? ' (no description)' : ' (no title)'));
    continue;
  }

  out.push({ u: url, t: decode(t), k: decode(section(url, decode(k))), d: decode(d) });
}

out.sort((a, b) => (a.u < b.u ? -1 : a.u > b.u ? 1 : 0));
fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');

const bySec = out.reduce((m, e) => (m[e.k] = (m[e.k] || 0) + 1, m), {});
const top = Object.entries(bySec).sort((a, b) => b[1] - a[1]).slice(0, 4)
  .map(([k, v]) => k + ' ' + v).join(', ');
console.log(
  '  search index: ' + out.length + ' pages of ' + urls.length + ' in the sitemap (was ' +
  prevCount + ')' + (fetched ? ', fetched ' + fetched : '') + (reused ? ', reused ' + reused : '') +
  (skipped.length ? ', skipped ' + skipped.length : '')
);
if (top) console.log('    ' + top);
for (const s of skipped.slice(0, 12)) console.log('    skipped: ' + s);
if (skipped.length > 12) console.log('    ... and ' + (skipped.length - 12) + ' more');
