#!/usr/bin/env node
/* Keep the coin counts equal to what the collector is actually publishing -- on EVERY page that
 * carries one, not just /crypto.
 *
 * Every count was typed by hand and then went stale, which is the same failure build-sitemap.js and
 * stamp-assets.js exist to prevent. Measured 2026-08-28: the pages said 89 coins and 82 with
 * leverage positioning while the live book was 90 and 83, and the FAQ said "the other 88" when it
 * was 89. Six `data-coincount` spans looked like they updated at runtime and never did -- nothing in
 * any page's JS has ever read that attribute.
 *
 * FIRST VERSION ONLY REWROTE crypto.html, and shipped while index.html, plans.html, faq.html,
 * compare-best-gamma-gex-tools.html and crypto-live.html all still said 89. Fixing the page instead
 * of the count is exactly the trap: this furniture is copy-pasted per page, not included, so the
 * only safe unit of work is "every file that carries the marker".
 *
 * Build-time rather than client-side on purpose: the number survives with JS off, is what a crawler
 * indexes, and never flashes wrong before correcting itself.
 *
 * Contract, same as its siblings: if this rewrites anything the tree goes dirty and deploy.sh stops
 * until it is committed. A silently stale claim becomes a loud one.
 *
 * Network failure is NOT fatal -- a deploy must not depend on the collector being up.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = process.env.NOVO_STORE_URL || 'https://novo-options.trade';
const PUB = path.join(__dirname, '..', 'public');

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
    console.warn('!! crypto counts NOT synced (' + e.message + ') -- leaving the pages as they are');
    return;
  }

  const list = Array.isArray(feed.list) ? feed.list : [];
  const total = Number(feed.coins) || list.length;
  const bandA = list.filter((x) => x.band === 'A').length;
  const bandB = list.filter((x) => x.band === 'B').length;
  // The on-chain half. Rounded DOWN to a ten: it moves every pass as pools cross the liquidity
  // floor, and copy reading "203" today and "197" tomorrow looks broken rather than live. A floor
  // is also the safe direction to be wrong in for a claim about how much someone is getting.
  const chain = Math.floor((Number(feed.chain) || 0) / 10) * 10;
  if (!total || !bandA) {
    console.warn('!! crypto counts look wrong (total=' + total + ' A=' + bandA + ') -- not writing');
    return;
  }
  if (/data-chaincount/.test(fs.readFileSync(path.join(PUB, 'crypto.html'), 'utf8')) && !chain) {
    // A page CLAIMS a chain count and the feed cannot back it. Writing 0 would turn a live number
    // into an advertisement for having nothing; leaving the old one stale is the lesser wrong, and
    // saying so loudly is how it gets noticed.
    console.warn('!! chain count came back 0 while the pages claim one -- leaving them as they are');
    return;
  }

  // Every rule is anchored to surrounding text, never to a bare number: a loose digit pattern in an
  // HTML file rewrites CSS values and hex colours too. `the other N` was checked site-wide before
  // being applied beyond /crypto -- it appears only on the two crypto pages.
  const keepCase = (n, tail) => (m) => m.slice(0, 3) + ' ' + n + ' ' + tail;
  const rules = [
    ['data-coincount span', /(<span data-coincount>)\d+(<\/span>)/g, '$1' + total + '$2'],
    ['data-chaincount span', /(<span data-chaincount>)\d+(<\/span>)/g, '$1' + chain + '$2'],
    // Plain-text twin. index and faq carry this sentence inside JSON-LD as well as in the visible
    // page, and a <span> would corrupt the structured data -- so those say the number in words and
    // this keeps them level with the marker version.
    ['across N tokens on Solana', /across \d+ tokens on Solana/g, 'across ' + chain + ' tokens on Solana'],
    ['across N coins', /across \d+ coins/gi, 'across ' + total + ' coins'],
    ['all N coins', /\ball \d+ coins/gi, keepCase(total, 'coins')],
    ['all N ranked', /\ball \d+ ranked/gi, keepCase(total, 'ranked')],
    ['bare N coins', /(?<![-\w>])\b\d+ coins\b/g, total + ' coins'],
    ['the other N', /the other \d+/g, 'the other ' + (total - 1)],
    ['stat: dealer map',
      /(<div class="stat-val"[^>]*>)\d+(<\/div><div [^>]*>With a dealer map<)/, '$1' + bandA + '$2'],
    ['stat: leverage',
      /(<div class="stat-val"[^>]*>)\d+(<\/div><div [^>]*>With leverage positioning<)/,
      '$1' + bandB + '$2'],
  ];

  // Only files that actually carry a count. A page with no marker is never opened for writing.
  const files = fs.readdirSync(PUB)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(PUB, f))
    .filter((p) => {
      const t = fs.readFileSync(p, 'utf8');
      return /data-coincount/.test(t) || /data-chaincount/.test(t)
          || /tokens on Solana/.test(t)
          || /\b(all|across)?\s?\d+ coins\b/i.test(t);
    });

  let touched = 0;
  for (const p of files) {
    const before = fs.readFileSync(p, 'utf8');
    let s = before;
    const hits = [];
    for (const [name, re, to] of rules) {
      const n = (s.match(re) || []).length;
      if (n) { s = s.replace(re, to); hits.push(name + '=' + n); }
    }
    if (s === before) continue;
    fs.writeFileSync(p, s);
    touched++;
    console.log('.. ' + path.basename(p) + ': ' + hits.join(', '));
  }

  console.log(touched
    ? '.. crypto counts synced across ' + touched + ' file(s) -> ' + total + ' coins, '
      + bandA + ' with a dealer map, ' + bandB + ' with leverage positioning, '
      + chain + '+ on-chain'
    : '.. crypto counts already current across ' + files.length + ' file(s) (' + total + ' coins, '
      + bandA + ' A, ' + bandB + ' B, ' + chain + '+ chain)');
})();
