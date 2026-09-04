#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────────
   build-sitemap.js — regenerate public/sitemap.xml from what is actually on disk.

   Why this exists: the sitemap was hand-maintained, and hand-maintaining it meant
   appending. It reached 2,149 entries for 1,067 real URLs -- the homepage and
   /analyst each listed four times -- because every edit added a line and nobody
   ever rebuilt the file. Generating it means the duplicates cannot come back.

   The rules it encodes:
     - one entry per URL, always,
     - a page marked noindex is not in the sitemap,
     - a URL that redirects is not in the sitemap (it is not a destination),
     - the URL listed is the one a visitor actually uses -- resolved through the
       vercel.json rewrites, so /trader appears rather than /trader.html,
     - lastmod is the file's real last commit date, not today's.
   ────────────────────────────────────────────────────────────────────────────── */

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const ORIGIN = 'https://novo-options.trade';
const OUT = path.join(PUB, 'sitemap.xml');

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

// file -> clean route, from the rewrites. Only literal sources: a rewrite whose
// source carries a pattern does not describe one page.
const routeFor = new Map();
for (const r of vercel.rewrites || []) {
  if (typeof r.destination !== 'string') continue;
  if (/[(:*?]/.test(r.source)) continue;
  const dest = r.destination.replace(/^\//, '').split('?')[0];
  if (dest.endsWith('.html') && !routeFor.has(dest)) routeFor.set(dest, r.source);
}

// URLs that redirect are destinations for nobody. Regex catch-alls like /(.*) are
// host-level canonicalisation, not per-page redirects -- including them would
// exclude the entire site.
const redirects = new Set(
  (vercel.redirects || []).map((r) => r.source).filter((s) => !/[(:*?]/.test(s))
);

// One git pass for every file's last commit date. Asking git per file would be
// ~1,100 processes; this is one.
const lastmod = new Map();
try {
  const log = execSync('git log --name-only --format=%x00%cs --diff-filter=AM -- public', {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
  let date = null;
  for (const line of log.split('\n')) {
    // %x00 emits a NUL ahead of each date line. Tested by charCode, not by a literal in
    // the source -- an embedded NUL makes git call this file binary and hides its diffs.
    if (line.charCodeAt(0) === 0) { date = line.slice(1).trim(); continue; }
    const f = line.trim();
    if (f && date && !lastmod.has(f)) lastmod.set(f, date);   // log is newest-first
  }
} catch (e) {
  console.error('  ! git log failed (' + e.message.split('\n')[0] + ') -- lastmod will be omitted');
}

const today = new Date().toISOString().slice(0, 10);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const entries = new Map();   // url -> {lastmod, priority} — a Map IS the dedupe
let skippedNoindex = 0, skippedRedirect = 0;

for (const abs of walk(PUB)) {
  const rel = path.relative(PUB, abs).split(path.sep).join('/');
  const html = fs.readFileSync(abs, 'utf8');

  if (/<meta[^>]+noindex/i.test(html)) { skippedNoindex++; continue; }

  // The URL a visitor uses: the rewrite if one exists, else the path itself.
  // index.html is the directory. The journal went EXTENSIONLESS on 2026-09-04, and this
  // needs no code change: the canonical block below already outranks the filename, and
  // every journal canonical now omits .html. The .html form 301s to it.
  let url;
  if (routeFor.has(rel)) url = routeFor.get(rel);
  else if (rel === 'index.html') url = '/';
  else if (rel.endsWith('/index.html')) url = '/' + rel.slice(0, -'index.html'.length);
  else url = '/' + rel;

  if (redirects.has(url)) { skippedRedirect++; continue; }

  // Prefer a canonical that points at this origin -- it is the page's own claim
  // about its address, and it outranks anything inferred from the filename.
  const can = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i);
  if (can && can[1].startsWith(ORIGIN)) {
    const c = can[1].slice(ORIGIN.length) || '/';
    if (!redirects.has(c)) url = c;
  }

  const depth = url.split('/').filter(Boolean).length;
  const priority = url === '/' ? '1.0'
    : rel.startsWith('journal/') ? '0.6'
    : depth <= 1 ? '0.8' : '0.7';

  const prev = entries.get(url);
  const mod = lastmod.get('public/' + rel) || today;
  if (!prev || mod > prev.lastmod) entries.set(url, { lastmod: mod, priority });
}

// Some real pages have no file behind them: /analyst/archive is a literal rewrite
// onto an API route that renders HTML. Walking public/ can never find those, so
// take them from the rewrite table itself rather than hardcoding a list.
for (const r of vercel.rewrites || []) {
  if (typeof r.destination !== 'string') continue;
  if (/[(:*?]/.test(r.source)) continue;
  if (!r.destination.startsWith('/api/')) continue;
  if (redirects.has(r.source) || entries.has(r.source)) continue;
  const apiFile = 'api/' + r.destination.split('?')[0].replace(/^\/api\//, '') + '.js';
  entries.set(r.source, { lastmod: lastmod.get(apiFile) || today, priority: '0.7' });
}

// The desk-note ARCHIVE DETAIL pages are the one part of the site walking public/ can never
// reach: /analyst/archive/:slug is rendered by api/analyst-publish.js from stored notes, so
// there is no file and no literal rewrite. 71 of them were live, indexable, each carrying a
// correct self-canonical -- and every one was missing from this sitemap. It grows daily.
//
// So ask the hub what it links to. Best-effort by design: a failed fetch logs and leaves the
// rest of the sitemap intact, because losing the whole file over one HTTP error is far worse
// than shipping without the archive for one build.
const archiveUrls = (() => {
  const src = process.env.NOVO_STORE_URL || ORIGIN;
  const get = (u) => execSync(
    'curl -sS --max-time 25 -A novo-build ' + JSON.stringify(u),
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  const found = new Set();
  const harvest = (html) => {
    const re = /href="(?:https?:\/\/[^"/]+)?(\/analyst\/archive\/[A-Za-z0-9._-]+)"/g;
    let m;
    while ((m = re.exec(html))) found.add(m[1]);
  };
  try {
    const first = get(src + '/analyst/archive');
    harvest(first);
    // The hub paginates. The Load-more button declares the total in data-pages; rel="next"
    // is the fallback signal. Capped at 50 so a malformed attribute cannot spin the build.
    const dp = first.match(/data-pages="(\d+)"/);
    let pages = dp ? Math.min(parseInt(dp[1], 10), 50) : (/rel="next"/.test(first) ? 50 : 1);
    for (let p = 2; p <= pages; p++) {
      let html;
      try {
        html = get(src + '/analyst/archive?page=' + p);
      } catch (e) {
        // Keep the pages that did work -- a partial archive beats no archive.
        console.warn('  ! archive page ' + p + ' failed; keeping ' + found.size + ' so far');
        break;
      }
      const before = found.size;
      harvest(html);
      if (found.size === before) break;   // nothing new: past the end
      if (!dp && !/rel="next"/.test(html)) { pages = p; }
    }
    return [...found];
  } catch (e) {
    console.warn('  ! archive detail pages NOT added (' + e.message.split('\n')[0] + ')');
    return [...found];
  }
})();

for (const u of archiveUrls) {
  if (redirects.has(u) || entries.has(u)) continue;
  // The slug leads with the note's own date, which is a truer lastmod than the build date --
  // a published desk note does not change afterwards.
  const d = u.match(/\/(\d{4}-\d{2}-\d{2})-/);
  entries.set(u, { lastmod: d ? d[1] : today, priority: '0.5' });
}
if (archiveUrls.length) console.log('  archive: ' + archiveUrls.length + ' desk notes');

const urls = [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const xml =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map(([u, m]) =>
    '  <url>\n' +
    '    <loc>' + ORIGIN + u + '</loc>\n' +
    '    <lastmod>' + m.lastmod + '</lastmod>\n' +
    '    <priority>' + m.priority + '</priority>\n' +
    '  </url>').join('\n') +
  '\n</urlset>\n';

// Never ship a sitemap that lost most of the site to a bug in this script.
const before = fs.existsSync(OUT)
  ? new Set((fs.readFileSync(OUT, 'utf8').match(/<loc>(.*?)<\/loc>/g) || []).map((s) => s.slice(5, -6)))
  : new Set();
if (before.size && urls.length < before.size * 0.8) {
  console.error('  ! REFUSING to write: ' + urls.length + ' urls vs ' + before.size + ' before (>20% drop)');
  process.exit(1);
}

fs.writeFileSync(OUT, xml, 'utf8');

const gone = [...before].filter((u) => !entries.has(u.replace(ORIGIN, '')));
console.log('  sitemap: ' + urls.length + ' urls (was ' + before.size + ' unique)');
console.log('           skipped ' + skippedNoindex + ' noindex, ' + skippedRedirect + ' redirecting');
if (gone.length) console.log('           dropped ' + gone.length + ': ' + gone.slice(0, 5).join(', '));

// ── RSS feed for the journal ──────────────────────────────────────────────────
// /journal/feed.xml: the 40 most recently touched articles, titles and deks from
// search-index.json, dates from the same git lastmod map the sitemap uses. Rebuilt
// on every deploy alongside the sitemap, so it can never drift from the corpus.
// Aggregators and AI crawlers get a machine door into 1,200+ articles that until
// now only existed as HTML.
try {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/journal/search-index.json'), 'utf8'));
  // The index has worn two shapes: journal-only entries keyed s:"slug.html", and the
  // site-wide rebuild keyed u:"/journal/slug". Read either, so the feed survives the next
  // index change the way it did not survive this one (it crashed on .s and no feed shipped).
  const byslug = new Map(idx.flatMap((e) => {
    if (!e) return [];
    if (typeof e.s === 'string') return [[e.s.replace(/\.html$/, ''), e]];
    if (typeof e.u === 'string') {
      const m = e.u.match(/^\/journal\/([a-z0-9-]+)(?:\.html)?$/);
      if (m && m[1] !== 'index') return [[m[1], e]];
    }
    return [];
  }));
  const items = [];
  for (const [file, date] of lastmod.entries()) {
    const m = file.match(/^public\/journal\/([a-z0-9-]+)\.html$/);
    if (!m || m[1] === 'index') continue;
    const e = byslug.get(m[1]);
    if (!e) continue;
    items.push({ slug: m[1], date, title: e.t, dek: e.d || '' });
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug < b.slug ? -1 : 1));
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rss =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n' +
    '<title>The NoVo Journal</title>\n' +
    '<link>' + ORIGIN + '/journal/</link>\n' +
    '<description>Market structure, dealer flow, options and crypto — plain-English pieces from the NoVo desk.</description>\n' +
    '<language>en</language>\n' +
    '<atom:link href="' + ORIGIN + '/journal/feed.xml" rel="self" type="application/rss+xml"/>\n' +
    items.slice(0, 40).map((it) =>
      '<item><title>' + esc(it.title) + '</title>' +
      '<link>' + ORIGIN + '/journal/' + it.slug + '.html</link>' +
      '<guid isPermaLink="true">' + ORIGIN + '/journal/' + it.slug + '.html</guid>' +
      '<pubDate>' + new Date(it.date + 'T12:00:00Z').toUTCString() + '</pubDate>' +
      '<description>' + esc(it.dek) + '</description></item>'
    ).join('\n') +
    '\n</channel>\n</rss>\n';
  fs.writeFileSync(path.join(ROOT, 'public/journal/feed.xml'), rss, 'utf8');
  console.log('  rss: ' + Math.min(items.length, 40) + ' items -> public/journal/feed.xml');
} catch (e) {
  console.warn('  ! rss feed NOT written (' + e.message.split('\n')[0] + ')');
}
