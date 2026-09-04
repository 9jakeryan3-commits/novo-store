#!/usr/bin/env node
/**
 * Rebuild the journal hub's "Full Archive" list from the articles that actually exist.
 *
 * The hub promises "Everything in the Journal" and was listing 1,002 of 1,287 — 285 articles,
 * 22% of the corpus, unreachable from the page whose job is to reach them. The list was static
 * markup, so every article published by any session drifted it further. Nothing was wrong with
 * the entries that were there; the list simply stopped being regenerated.
 *
 * Shape preserved exactly: the first 48 <li> are the hand-picked featured entries and are left
 * untouched, in their order. Everything else becomes an `<li class="arch-x">` behind the
 * "show all" toggle, sorted by title. An article already featured is never repeated below.
 *
 * Title and section come from each file's own <title> and its breadcrumb/section label, so this
 * cannot invent a name: a file that yields neither is skipped and reported rather than listed
 * under a guessed heading.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JOURNAL = path.join(ROOT, 'public', 'journal');
const HUB = path.join(JOURNAL, 'index.html');

const SKIP = new Set(['index.html', 'search.html']);

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function readArticle(file) {
  const html = fs.readFileSync(path.join(JOURNAL, file), 'utf8');
  // The <title> is "Article Name | NoVo…" — take the part before the first pipe.
  const t = html.match(/<title>([^<]*)<\/title>/i);
  if (!t) return null;
  let title = decode(t[1]).split('|')[0].split('&mdash;')[0].trim();
  if (!title) return null;
  // Section: the journal's own category label, as the existing entries carry it.
  let section = '';
  const s = html.match(/class="(?:jt-cat|cat|kicker|section-label)"[^>]*>([^<]{2,40})</i)
         || html.match(/<span class="arch-c">\s*&middot;\s*([^<]{2,40})</i);
  if (s) section = decode(s[1]).replace(/^[·&middot;\s]+/, '').trim();
  return { file, title, section };
}

function main() {
  const files = fs.readdirSync(JOURNAL)
    .filter(f => f.endsWith('.html') && !SKIP.has(f))
    .sort();

  let hub = fs.readFileSync(HUB, 'utf8');
  const start = hub.indexOf('<ul id="arch-list"');
  if (start < 0) { console.error('!! arch-list not found'); process.exit(1); }
  const open = hub.indexOf('>', start) + 1;
  const end = hub.indexOf('</ul>', open);
  if (end < 0) { console.error('!! arch-list not closed'); process.exit(1); }
  const inner = hub.slice(open, end);

  // Keep the featured entries verbatim — they are a hand-made selection, not generated output.
  const featured = inner.match(/<li style="break-inside:avoid;margin:0 0 11px;">[\s\S]*?<\/li>/g) || [];
  const featuredHrefs = new Set(
    featured.map(li => (li.match(/href="([^"]+)"/) || [])[1]).filter(Boolean));

  const skipped = [];
  const rows = [];
  for (const f of files) {
    const href = '/journal/' + f;
    if (featuredHrefs.has(href)) continue;
    let a;
    try { a = readArticle(f); } catch (_) { a = null; }
    if (!a) { skipped.push(f); continue; }
    rows.push(a);
  }
  rows.sort((x, y) => x.title.localeCompare(y.title, 'en'));

  const lis = rows.map(r =>
    `<li class="arch-x"><a href="/journal/${r.file.replace(/\.html$/, '')}">${esc(r.title)}</a>` +
    (r.section ? ` <span class="arch-c">&middot; ${esc(r.section)}</span>` : '') +
    `</li>`).join('');

  const rebuilt = featured.join('') + lis;
  hub = hub.slice(0, open) + rebuilt + hub.slice(end);
  fs.writeFileSync(HUB, hub);

  console.log(`.. journal archive: ${featured.length} featured + ${rows.length} listed = ${featured.length + rows.length} of ${files.length} articles`);
  if (skipped.length) console.log(`.. skipped (no readable title): ${skipped.join(', ')}`);
}

main();
