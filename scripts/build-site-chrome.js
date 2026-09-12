#!/usr/bin/env node
/**
 * Extract the REAL site header, footer and CSS into a module the serverless pages can import.
 *
 * /analyst/archive is rendered by api/analyst-publish.js, which cannot reach the static pages'
 * markup — so it had a hand-built lookalike header and footer. It looked close and was wrong:
 * different nav, no ticker, no menu button, no account link, a footer with different groups.
 *
 * Rather than maintain a second copy that drifts, this lifts the actual blocks out of a canonical
 * page at deploy time. Same <nav>, same ticker, same disclaimer footer, same stylesheet links and
 * the same inline <style> — because they are literally the same bytes.
 *
 * Run by scripts/deploy.sh before the deploy, so the chrome is regenerated whenever the site's is.
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const SOURCE = 'analyst.html';        // canonical: full nav, ticker and footer, no page quirks
const OUT = path.join(__dirname, '..', 'api', '_lib', 'site-chrome.js');

const html = fs.readFileSync(path.join(PUB, SOURCE), 'utf8');

function slice(from, to, label) {
  const i = html.indexOf(from);
  if (i < 0) throw new Error(`build-site-chrome: ${label}: start marker not found (${from})`);
  const j = html.indexOf(to, i);
  if (j < 0) throw new Error(`build-site-chrome: ${label}: end marker not found (${to})`);
  return html.slice(i, j);
}

// ── head: the stylesheet links and the one inline <style> block ──────────────────────────────────
const links = (html.match(/<link[^>]*rel="stylesheet"[^>]*>/g) || []).join('');
const styleM = html.match(/<style[^>]*>[\s\S]*?<\/style>/);
if (!links) throw new Error('build-site-chrome: no stylesheet links found');
if (!styleM) throw new Error('build-site-chrome: no inline <style> block found');

// ── header: <nav> through the ticker, stopping BEFORE the breadcrumb ─────────────────────────────
// The breadcrumb is per-page, so each page renders its own using the same .crumbs markup.
const header = slice('<nav>', '<nav class="crumbs"', 'header');

// ── footer: the disclaimer block to the end of the body ──────────────────────────────────────────
// Scripts are stripped: the tail of a marketing page carries page-specific JS that has no business
// running on a server-rendered archive.
let footer = slice('<div class="disclaimer">', '</body>', 'footer')
  .replace(/<script[\s\S]*?<\/script>/g, '');

// THE HEADER'S OWN HANDLERS ARE CHROME, NOT PAGE JS (2026-09-04, routed S2: the strip above
// removed the only definitions of novoNavToggle/novoMoreToggle while shipping buttons that call
// them - on mobile the menu IS the navigation, so archive readers were stranded). Lift exactly
// the inline blocks that define the header's handlers and re-emit them as SCRIPT; everything
// else stays stripped, which keeps the comment above true.
const CHROME_FNS = ['novoNavToggle', 'novoMoreToggle'];
const inlineChrome = (html.match(/<script>[\s\S]*?<\/script>/g) || [])
  .filter((b) => CHROME_FNS.some((f) => b.includes('function ' + f)))
  .join('\n');

/* ⚠ AND THE SAME ARGUMENT REACHES THE EXTERNAL SCRIPTS (2026-09-12, Jake on /daily-strike: "header
   is off and the page still needs work... appears half built compared to the rest").
   The rule above — the header's own handlers are chrome, not page JS — was written for inline
   blocks and stopped there, so every server-rendered page shipped the header's MARKUP with none of
   the code that makes it work. Measured on the live page:

     site-search.js   injects the search box INTO `.nav-inner`. Without it there is no search box at
                      all, and — worse — the nav's children carry explicit `order:` values and a
                      `::after{order:4;flex-basis:100%}` line-break, so removing the flex:1 search
                      box silently re-flows the whole bar: Plans and the account icon land LEFT of
                      the links and the logo drops to a second row. The header did not look
                      unstyled, it looked REARRANGED, which is why it read as a different site.
     ticker-live.js   drives `.tick`/`.t-name`/`.t-val`/`.t-chg`, which the header already ships.
                      Without it the strip is frozen at BUILD time — a news front page quoting
                      yesterday's prices, and the one defect here a reader would call a lie.
     chat-widget.js   the site-wide Support bubble, present on every static page and absent here.
     polish.js        the site-wide polish layer every other page runs.

   ALLOWLIST, NOT AN UN-STRIP. The comment above stays true: page-specific JS still has no business
   on a server-rendered page (np-form.js is a signup form that belongs to the marketing page and is
   deliberately absent). Adding a script to the canonical page does NOT auto-ship it here; someone
   has to decide it is chrome and name it. Tags are lifted VERBATIM so their ?v= stamps ride along —
   build-site-chrome runs after stamp-assets in deploy.sh, so they are current by construction. */
const CHROME_SRC = ['site-search.js', 'ticker-live.js', 'chat-widget.js', 'polish.js', 'ga-events.js'];
const srcTags = (html.match(/<script[^>]*\bsrc="[^"]*"[^>]*><\/script>/g) || [])
  .filter((t) => CHROME_SRC.some((n) => t.includes('/' + n)));

const script = [inlineChrome, srcTags.join('\n')].filter(Boolean).join('\n');

/* Generation-time proof, in the same spirit as the handler check below: if the header SHIPS a
   surface, the code that drives it must ship too. These fire on the real defect — a header carrying
   a ticker nothing updates, or a `.nav-inner` the search box never reaches — and they fail loudly
   at build rather than quietly on a reader's screen. Deliberately keyed on what the HEADER contains,
   so deleting a surface from the header retires its assertion instead of blocking the build. */
const DRIVEN = [
  ['class="ticker"', 'ticker-live.js', 'the market ticker would be frozen at build time'],
  ['nav-inner', 'site-search.js', 'the nav would re-flow and ship no search box'],
];
for (const [marker, file, consequence] of DRIVEN) {
  if (header.includes(marker) && !script.includes('/' + file)) {
    throw new Error(`build-site-chrome: header ships "${marker}" but ${file} is not emitted — ${consequence}`);
  }
}
// Generation-time proof the shipped header cannot call an undefined handler again: every on*
// handler the HEADER names must be defined in what we emit.
for (const m of header.matchAll(/on[a-z]+="(\w+)\(/g)) {
  if (!script.includes('function ' + m[1])) {
    throw new Error(`build-site-chrome: header calls ${m[1]}() but no emitted script defines it`);
  }
}

const sanity = [
  [header, 'nav-inner', 'header is missing the nav'],
  [header, 'class="ticker"', 'header is missing the market ticker'],
  [header, 'nav-menu-btn', 'header is missing the mobile menu button'],
  [footer, '/privacy', 'footer is missing the legal links'],
  [footer, 'disclaimer', 'footer is missing the disclaimer'],
];
for (const [hay, needle, msg] of sanity) {
  if (!hay.includes(needle)) throw new Error('build-site-chrome: ' + msg);
}
// the header must be balanced, or every page importing it inherits the break
const opens = (header.match(/<div\b/g) || []).length;
const closes = (header.match(/<\/div>/g) || []).length;
if (opens !== closes) {
  throw new Error(`build-site-chrome: header divs unbalanced (${opens} open / ${closes} close) — refusing to write`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
// Write ONLY on a real change. deploy.sh runs this and then refuses a dirty tree, so an
// unconditional write would dirty the tree on every run and block the next deploy.
const next = `// GENERATED by scripts/build-site-chrome.js from public/${SOURCE} — do not edit.
// The site's real header, footer and CSS, so server-rendered pages match the static ones exactly.
module.exports = {
  HEAD: ${JSON.stringify(links + styleM[0])},
  HEADER: ${JSON.stringify(header)},
  FOOTER: ${JSON.stringify(footer)},
  SCRIPT: ${JSON.stringify(script)},
};
`;
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
if (prev !== next) fs.writeFileSync(OUT, next);

console.log(`.. site chrome: header ${header.length}b, footer ${footer.length}b, css ${(links + styleM[0]).length}b (from ${SOURCE})`);
