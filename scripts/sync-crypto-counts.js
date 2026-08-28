#!/usr/bin/env node
/* Keep the coin counts on /crypto equal to what the collector is actually publishing.
 *
 * Every count on that page was typed by hand and then went stale, which is the same failure
 * build-sitemap.js and stamp-assets.js exist to prevent. Measured on 2026-08-28: the page said
 * 89 coins and 82 with leverage positioning while the live book was 90 and 83, and the FAQ said
 * "ranks it against the other 88" when it was 89. Six `data-coincount` spans looked like they were
 * updated at runtime and were not -- nothing in the page's JS ever read that attribute.
 *
 * Build-time rather than client-side on purpose: the number then survives with JS off, is what a
 * crawler indexes, and never flashes a wrong value before correcting itself. The attribute stays
 * as the anchor this script targets, which finally gives it a job.
 *
 * Contract, same as its siblings: if this rewrites anything the tree goes dirty and deploy.sh
 * stops and tells you to commit. A silently stale claim becomes a loud one.
 *
 * Network failure is NOT fatal -- a deploy must not depend on the collector being up. It warns and
 * leaves the file alone, because the last known-good number is better than a zero.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = process.env.NOVO_STORE_URL || 'https://novo-options.trade';
const PAGE = path.join(__dirname, '..', 'public', 'crypto.html');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = require('https').get(url, { headers: { 'User-Agent': 'novo-build' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  let feed;
  try {
    feed = await get(SRC + '/api/crypto-free');
  } catch (e) {
    console.warn('!! crypto counts NOT synced (' + e.message + ') -- leaving the page as it is');
    return;                       // never block a deploy on the collector being reachable
  }

  const list = Array.isArray(feed.list) ? feed.list : [];
  const total = Number(feed.coins) || list.length;
  const bandA = list.filter((x) => x.band === 'A').length;
  const bandB = list.filter((x) => x.band === 'B').length;
  if (!total || !bandA) {
    console.warn('!! crypto counts look wrong (total=' + total + ' A=' + bandA + ') -- not writing');
    return;
  }

  const before = fs.readFileSync(PAGE, 'utf8');
  let s = before;

  // Every rule is anchored to surrounding text, never to a bare number: a loose digit pattern in an
  // HTML file rewrites CSS values and hex colours too.
  //
  // Each rule reports its own hit count, and a rule matching NOTHING is a warning rather than a
  // silent pass. That is not decoration -- the first version of this script had a lowercase-only
  // pattern that walked straight past "All 89 coins" in the JSON-LD, then reported the page as
  // "already current" while it was still wrong. A sync that cannot tell you what it synced is a
  // sync you cannot trust.
  const keepCase = (n, tail) => (m) => m.slice(0, 3) + ' ' + n + ' ' + tail;
  const rules = [
    ['data-coincount span', /(<span data-coincount>)\d+(<\/span>)/g, '$1' + total + '$2'],
    ['across N coins', /across \d+ coins/gi, 'across ' + total + ' coins'],
    ['all N coins', /\ball \d+ coins/gi, keepCase(total, 'coins')],
    ['all N ranked', /\ball \d+ ranked/gi, keepCase(total, 'ranked')],
    ['the other N', /the other \d+/g, 'the other ' + (total - 1)],
    ['stat: dealer map',
      /(<div class="stat-val"[^>]*>)\d+(<\/div><div [^>]*>With a dealer map<)/, '$1' + bandA + '$2'],
    ['stat: leverage',
      /(<div class="stat-val"[^>]*>)\d+(<\/div><div [^>]*>With leverage positioning<)/,
      '$1' + bandB + '$2'],
  ];

  const hits = [];
  for (const [name, re, to] of rules) {
    const n = (s.match(re) || []).length;
    if (n) s = s.replace(re, to);
    hits.push(name + '=' + n);
    if (!n) console.warn('!! rule matched nothing: ' + name + ' -- the page copy probably changed');
  }
  console.log('.. rules: ' + hits.join(', '));

  if (s === before) {
    console.log('.. crypto counts already current (' + total + ' coins, ' + bandA + ' A, '
                + bandB + ' B)');
    return;
  }
  fs.writeFileSync(PAGE, s);
  console.log('.. crypto counts synced -> ' + total + ' coins, ' + bandA + ' with a dealer map, '
              + bandB + ' with leverage positioning');
})();
