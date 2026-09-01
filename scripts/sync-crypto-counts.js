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
  const mapped = Number(feed.mapped) || list.length;
  const bandA = list.filter((x) => x.band === 'A').length;
  const bandB = list.filter((x) => x.band === 'B').length;
  // The on-chain half, written as "200+" and floored to a FIFTY.
  //
  // The raw figure oscillates every pass as pools cross the liquidity floor -- 206 one pass, 215 the
  // next. Flooring to a ten was not coarse enough: it still flipped 200/210 between deploys, and
  // because a rewritten tree halts the deploy, that churn was stopping releases mid-run. Fifty is
  // wide enough that the number sits still while the book grows into it.
  //
  // Floored rather than rounded, and given a plus, so the claim is true across the whole range
  // instead of exact for one pass -- and under-claiming is the safe direction to be wrong in when
  // the number is telling someone how much they get.
  // Read `chain_smoothed`, NOT `chain`. Flooring to a fifty was not enough on its own: the live
  // count genuinely ranges 131-234 across a day, which straddles the 200 edge, so the baked claim
  // still flipped 150+/200+ -- 62 band changes in 24 hours, replayed across all 373 collector
  // passes, with nothing real behind them. `chain_smoothed` is the LOWEST count over collector
  // passes that swept every network in a trailing window, so it cannot over-claim and a failed
  // per-network fetch cannot drag it down as if the map had shrunk. Same day, same data: 9 flips.
  // `chain` stays the exact live figure for coin-count.js, which must reconcile with the dashboard.
  const CHAIN_STEP = 50;
  const chainRaw = Number(feed.chain_smoothed ?? feed.chain) || 0;
  const chain = Math.floor(chainRaw / CHAIN_STEP) * CHAIN_STEP;

  // The COMBINED figure -- coins plus on-chain tokens -- which is the number the crypto dashboard
  // has shown all along: crypto-live.html sums its two rails for the filter box. The site used to
  // lead with the on-chain half alone, so a subscriber comparing the two saw "150+" here and "281
  // tokens" there with no way to reconcile them. Same source, same arithmetic, floored the same
  // way, so the baked claim stays true across the range -- and coin-count.js swaps in the exact
  // live figure for anyone with JS.
  // "assets mapped" is the size of the map, so the coin half is `mapped`, not `total`.
  const assets = Math.floor((chainRaw + mapped) / CHAIN_STEP) * CHAIN_STEP;

  // How many tools the analyst can actually call, counted off the declarations themselves.
  let tools = 0;
  try {
    tools = require('../api/_lib/tools.js').declarations.length;
  } catch (e) {
    console.warn('!! could not count analyst tools (' + e.message + ') -- leaving that number alone');
  }
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
    // The SIZE OF THE MAP, which is not `total`. `total` is feed.coins = tradable at retail,
    // because the cost-to-trade copy only exists for coins the broker lists; feed.mapped counts
    // every coin on the map. They differ by TRX -- a real options book, no retail listing -- so
    // anything saying "coins mapped" has to read this one or it undercounts by one.
    ['data-mappedcount span', /(<span data-mappedcount>)\d+(<\/span>)/g, '$1' + mapped + '$2'],
    // THE THIRD NEAR-90 NUMBER: coins with a book OR leverage positioning = band A + band B.
    // It is neither of the other two. `total` (tradable at retail) is also 90 today but is a
    // DIFFERENT SET -- it includes USDG and excludes TRX, exactly the opposite membership of
    // this one, which includes TRX (live Deribit book, no retail listing) and excludes USDG
    // (band C stablecoin, no book and no perp). They agree at 90 by coincidence, and that
    // coincidence ends the day USDG gets a perp or TRX gets listed. A sentence claiming "a book
    // or leverage positioning" has to read this, or it will silently start counting a coin that
    // has neither.
    ['data-bandcount span', /(<span data-bandcount>)\d+(<\/span>)/g, '$1' + (bandA + bandB) + '$2'],
    ['data-chaincount span', /(<span data-chaincount>)\d+\+?(<\/span>)/g, '$1' + chain + '+$2'],
    ['data-assetcount span', /(<span data-assetcount>)\d+\+?(<\/span>)/g, '$1' + assets + '+$2'],
    ...(tools ? [['data-toolcount span', /(<span data-toolcount>)\d+(<\/span>)/g, '$1' + tools + '$2']] : []),
    // Plain-text twin. index and faq carry this sentence inside JSON-LD as well as in the visible
    // page, and a <span> would corrupt the structured data -- so those say the number in words and
    // this keeps them level with the marker version.
    ['across N tokens on Solana', /across \d+\+? tokens on Solana/g, 'across ' + chain + '+ tokens on Solana'],
    // MAP-SIZE plain text, and it must run BEFORE the generic coin rules below -- which is also why
    // those three now refuse to match "... coins in the map". A sentence that says "in the map" is
    // counting the map (feed.mapped, 91), not the retail cost universe (feed.coins, 90); without
    // this the JSON-LD twin of the /crypto FAQ answer was stamped back to 90 on every single build,
    // undercounting the map by TRX forever while the visible marker beside it read 91.
    ['N coins in the map', /\b\d+ coins in the map/g, mapped + ' coins in the map'],
    ['across N coins', /across \d+ coins(?! in the map)/gi, 'across ' + total + ' coins'],
    ['all N coins', /\ball \d+ coins(?! in the map)/gi, keepCase(total, 'coins')],
    ['all N ranked', /\ball \d+ ranked/gi, keepCase(total, 'ranked')],
    ['bare N coins', /(?<![-\w>])\b\d+ coins\b(?! in the map)/g, total + ' coins'],
    ['the other N', /the other \d+/g, 'the other ' + (total - 1)],
    ['stat: dealer map',
      /(<div class="stat-val"[^>]*>)\d+(<\/div><div [^>]*>With a dealer map<)/, '$1' + bandA + '$2'],
    ['stat: leverage',
      /(<div class="stat-val"[^>]*>)\d+(<\/div><div [^>]*>With leverage positioning<)/,
      '$1' + bandB + '$2'],
  ];

  // Only files that actually carry a count. A page with no marker is never opened for writing.
  // The journal HUB carries a count too and readdirSync is not recursive, so it was invisible to
  // this script and had been sitting on a hand-typed number the sync could never reach. Named
  // explicitly rather than walking 1,000+ articles: the hub is the one file down there with a
  // marker, and a recursive walk would re-read the whole journal on every deploy.
  const EXTRA = [path.join(PUB, 'journal', 'index.html')].filter((p) => fs.existsSync(p));
  const files = fs.readdirSync(PUB)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(PUB, f))
    .concat(EXTRA)
    .filter((p) => {
      const t = fs.readFileSync(p, 'utf8');
      // data-mappedcount belongs in this list too: a page carrying ONLY that marker was never
      // opened, so the map-size count could go stale in exactly the file that cares most about it.
      return /data-coincount/.test(t) || /data-mappedcount/.test(t) || /data-bandcount/.test(t) || /data-chaincount/.test(t)
          || /data-toolcount/.test(t)
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
      + chain + '+ on-chain, ' + assets + '+ assets'
    : '.. crypto counts already current across ' + files.length + ' file(s) (' + total + ' coins, '
      + bandA + ' A, ' + bandB + ' B, ' + chain + '+ chain, ' + tools + ' tools)');
})();
