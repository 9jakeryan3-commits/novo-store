#!/usr/bin/env node
/* ──────────────────────────────────────────────────────────────────────────────
   stamp-assets.js — rewrite every ?v= on a local JS/CSS asset to a hash of that
   file's actual contents.

   Why this exists: these assets are served with

       Cache-Control: public, max-age=31536000, immutable

   which is a YEAR, and `immutable` tells the browser not to revalidate even on a
   reload. Combined with a hand-typed ?v=1 that nobody remembered to bump, an edit
   to chat-widget.js was invisible to every returning visitor -- effectively
   permanently. That is exactly how a fixed greeting bug kept showing the old
   greeting: the fix shipped, the browser never asked for it.

   Content-hashing removes the remembering. Change the file and the URL changes;
   leave it alone and the URL is stable and stays cached, which is the whole point
   of the long max-age.

   JS and CSS only. The images (og-*, icons) are versioned by hand on purpose --
   they change rarely and their numbers are referenced elsewhere.
   ────────────────────────────────────────────────────────────────────────────── */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUB = path.resolve(__dirname, '..', 'public');
const hashes = new Map();

function hashOf(asset) {
  if (hashes.has(asset)) return hashes.get(asset);
  const file = path.join(PUB, asset);
  let h = null;
  if (fs.existsSync(file)) {
    h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
  }
  hashes.set(asset, h);
  return h;
}

function walk(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// /name.js?v=xxxx  or  /name.css?v=xxxx  — local, root-relative assets only.
// Sub-paths count too: the journal's blog.css and search.js live under /journal/
// and carry the same immutable cache as everything else.
const REF = /(["'(])\/((?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.(?:js|css))\?v=([a-zA-Z0-9]+)/g;

let files = 0, rewrites = 0, missing = new Set();
const changed = new Map();

function stamp(abs, self) {
  const src = fs.readFileSync(abs, 'utf8');
  const out = src.replace(REF, (m, q, asset, ver) => {
    // A file that stamps a reference to ITSELF can never settle: rewriting it changes its hash,
    // which invalidates the value just written. Nothing does this today; refuse it loudly if
    // anything ever starts.
    if (asset === self) { missing.add(asset + ' (self-reference — cannot be hashed)'); return m; }
    const h = hashOf(asset);
    if (!h) { missing.add(asset); return m; }          // referenced but not on disk — leave it alone
    if (h !== ver) {
      rewrites++;
      changed.set(asset, ver + ' -> ' + h);
    }
    return q + '/' + asset + '?v=' + h;
  });
  if (out !== src) { fs.writeFileSync(abs, out, 'utf8'); files++; }
}

/* TWO PASSES, AND THE ORDER IS LOAD-BEARING.

   Scripts load scripts: site-search.js injects the keyboard layer, so that reference lives in a
   .js file, not an .html one. Stamping only HTML left it permanently un-bustable — a year of
   `immutable`, which is the exact failure this file was written to end, one level down.

   But rewriting a .js file CHANGES ITS OWN CONTENT and therefore its own hash. Stamp the HTML
   first and every page would carry the pre-rewrite hash of site-search.js and serve a stale copy.
   So: assets first, then drop the memoised hashes, then HTML against the settled bytes. */
for (const abs of walk(PUB, ['.js', '.css'])) {
  stamp(abs, path.relative(PUB, abs).split(path.sep).join('/'));
}
hashes.clear();
for (const abs of walk(PUB, ['.html'])) stamp(abs, null);

console.log('  assets: ' + rewrites + ' refs restamped across ' + files + ' files');
for (const [a, d] of changed) console.log('          ' + a.padEnd(20) + d);
if (missing.size) console.log('          ! referenced but not on disk: ' + [...missing].join(', '));
