#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────────
   build-search-index.js — regenerate public/journal/search-index.json from what
   is actually on disk.

   Why this exists: the index was hand-maintained, so it drifted in both
   directions at once and nothing ever noticed.

     - 21 entries pointed at articles deleted in the duplicate-merge pass. Those
       are search results that 404.
     - ALL EIGHT crypto articles were missing. The $79 product's entire education
       surface — Bitcoin gamma, funding, DVOL, liquidation cascades, the 08:00 UTC
       expiry — could not be found by the Journal's own search box. The articles
       were written, linked and deployed, and were invisible to anyone looking
       for them on the site.

   The rules it encodes:
     - one entry per article that exists on disk, always,
     - index.html is the hub, not an article, so it is excluded,
     - the fields come from the page itself (og:title, kicker, meta description),
       so an article cannot be in the index describing something it no longer says,
     - sorted by slug, so the diff of a rebuild is readable.

   Wired into scripts/deploy.sh beside build-sitemap.js. Run it there, not by hand.
   ────────────────────────────────────────────────────────────────────────────── */

'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'journal');
const OUT = path.join(DIR, 'search-index.json');

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

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.html') && f !== 'index.html')
  .sort();

const out = [];
const skipped = [];

for (const f of files) {
  const html = fs.readFileSync(path.join(DIR, f), 'utf8');
  const slug = f.slice(0, -5);

  const t =
    pick(html, /<meta property="og:title" content="([^"]*)"/) ||
    pick(html, /<h1>([^<]*)<\/h1>/);
  const d = pick(html, /<meta name="description" content="([^"]*)"/);
  const k = pick(html, /<div class="kicker">([^<]*)<\/div>/);

  // A page with no title or no description cannot be a useful search result, and
  // guessing one would put a wrong answer in the box. Report it instead.
  if (!t || !d) {
    skipped.push(slug + (t ? ' (no description)' : ' (no title)'));
    continue;
  }

  out.push({ s: slug, t: decode(t), k: decode(k), d: decode(d) });
}

let prev = 0;
try {
  prev = JSON.parse(fs.readFileSync(OUT, 'utf8')).length;
} catch (_) {
  prev = 0;
}

fs.writeFileSync(OUT, JSON.stringify(out), 'utf8');
console.log(
  '  search index: ' + out.length + ' articles (was ' + prev + ')' +
    (skipped.length ? ', skipped ' + skipped.length : '')
);
for (const s of skipped) console.log('    skipped: ' + s);
