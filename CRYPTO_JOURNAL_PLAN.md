# The crypto Journal — plan to ~545 articles

**Status:** approved 2026-08-29. Batch 1 in progress.

**The gap:** the Journal is 1,032 articles. Eleven of them are crypto, for a product that is one
of three in the line-up and the only one at $79. The on-chain half of that product — 190-odd
tokens across Solana and Robinhood Chain — had **two** articles when this plan was written.

---

## 1. What the competition actually looks like (researched 2026-08-29)

| Who | Crypto education depth | What it actually is |
|---|---|---|
| **MenthorQ** | **12 articles** | Their crypto-gamma page is a single sales page. Their *equity* library is Volatility 79, Options Basic 29 — they invested in equities and left crypto alone |
| **Deribit Insights** | ~60 articles + a 97-lecture course | The real incumbent, but it is venue and product documentation: how to use Deribit, not how the structure works |
| **Glassnode** | Research posts | Builds crypto GEX from **taker flow** rather than OI x gamma — crypto venues expose who the taker was on each trade. A genuinely different method from ours, and worth an article of its own |
| CryptoGamma.io · GammaFlip.io · BackQuant | Thin | Dashboards with one landing page of explanation |
| CoinGlass | Data platform, $29–$699/mo | Learn section is API and metric documentation |
| Binance Academy · Coinbase Learn · BingX · MetaMask | Thousands of pages | Generic "what is a funding rate". Completely saturated |

**The finding: nobody owns crypto derivatives market structure.** The largest dedicated library in
the niche is twelve articles. The Journal has already proven the format works at 1,000+ in exactly
this shape on equities.

---

## 2. The strategic split

**Skip entirely.** "What is Bitcoin", how to buy crypto, wallets, exchange 101. Binance Academy has
thousands of those pages, they rank permanently, and a reader at that stage has no intent to buy a
$79 market-structure product. Writing them would add pages and no customers.

**Own.** Dealer positioning · funding · liquidations · on-chain liquidity · per-coin structure ·
execution cost. That is the product, and it is where the competition is twelve articles deep.

---

## 3. Taxonomy — ~545, mirroring the proven equity shape

The equity journal's own distribution is the template: Dealer Flow 90, Options 101 79, Charting 69,
Compare 68, Market Structure 68, Scalping 55. Crypto mirrors it with the categories that have a
crypto analogue, and adds the two that are crypto-native (perps/funding, on-chain).

| Category | Target | Status |
|---|---|---|
| Crypto Dealer Flow | 90 | 6 written |
| Perps & Funding | 70 | 3 written |
| **On-Chain Structure** | **70** | **Batch 1 — in progress** |
| Crypto Options 101 | 60 | 1 written |
| Per-Coin Structure | 60 | 0 |
| Volatility & DVOL | 40 | 1 written |
| Execution & Cost | 35 | 1 written |
| Liquidations & Leverage | 30 | 1 written |
| Macro & ETF Flows | 25 | 0 |
| Risk & Discipline (24/7) | 25 | 0 |
| Glossary & FAQ | 25 | 0 |
| Compare | 15 | 0 |

---

## 4. THE RULE THAT DECIDES WHETHER THIS WORKS

**Every per-coin and per-venue article must carry a figure only NoVo can state** — its own computed
book depth, flip behaviour, funding character, venue coverage, on-chain presence.

Swapping the noun from SOL to XRP is the 11-article `how-to-trade-0dte-on-<broker>` template at
sixty times the scale, and that template is *already* flagged on this site at 0.78–0.91 similarity.
NoVo has per-coin data. Using it is the entire difference between a library and a content farm.

Supporting rules, all inherited and non-negotiable:

1. **Dedupe against the corpus BEFORE writing**, by article *body*, never by filename — the nav and
   footer match every keyword on all 1,032 pages. See `verify-fix-count-not-page`.
2. **No performance claims.** No win rates, no P&L, no implied returns.
3. **No NoVo internals** — no thresholds, floors, formulas, collection cadences or vendor names that
   are not already public. Deribit is named publicly; the on-chain data vendor is not.
4. **Counts go in `<span data-count>` markers**, never as literal text. Literal counts are how
   "89 coins" and "six cryptos" went stale.
5. **Crypto articles get the 2-up CTA led by Crypto**, Analyst second — never led by Trader.
6. Every article: a disclaimer, valid JSON-LD, a canonical, its own twitter card (the template's is
   inherited from a SPY article — overwrite it), and a meta description at or under 165 characters
   ending on a sentence boundary.
7. **Run `scripts/build-search-index.js`** — a new article that is not in the index cannot be found
   in the Journal's own search box. All 8 original crypto articles had this defect.

---

## 5. Batch 1 — On-Chain Structure (20)

Already live: `on-chain-liquidity-vs-order-book`, `a-ticker-is-not-a-token`.

Eighteen to write, each a distinct mechanism rather than a restatement:

| # | Slug | The thing it actually explains |
|---|---|---|
| 1 | `what-is-robinhood-chain` | An exchange running its own L2, read as market structure |
| 2 | `how-an-amm-prices-a-token` | Price as a consequence of a curve, not a book |
| 3 | `slippage-and-price-impact-on-chain` | What it costs to move a pool |
| 4 | `impermanent-loss-and-why-liquidity-leaves` | The LP's economics, and why depth departs |
| 5 | `liquidity-added-vs-pulled` | Depth as a flow, and why it needs history |
| 6 | `pool-depth-is-not-volume` | Two numbers constantly conflated |
| 7 | `mev-and-sandwich-attacks` | Execution cost you cannot see on the chart |
| 8 | `routing-pools-vs-real-demand` | Why the biggest pool is plumbing |
| 9 | `holder-concentration-and-exit-risk` | Many wallets or a few |
| 10 | `solana-vs-evm-liquidity-structure` | Two genuinely different microstructures |
| 11 | `the-liquidity-lifecycle-of-a-new-token` | How depth evolves after a launch |
| 12 | `honeypots-and-unsellable-tokens` | When the exit does not exist at all |
| 13 | `why-wrapped-assets-exist` | WETH, WBTC and plumbing literacy |
| 14 | `what-the-quote-asset-tells-you` | USDG vs USDC vs USDT vs the gas asset |
| 15 | `tokenized-stocks-and-24-7-equity-exposure` | Stock tokens against a tape that closes |
| 16 | `dex-vs-cex-price-discovery` | Where price is actually made |
| 17 | `gas-fees-as-a-trading-cost` | The cost line that has no equity analogue |
| 18 | `thin-liquidity-and-volatility` | Why a shallow pool moves like short gamma |

---

## 6. Order after Batch 1

Per-Coin Structure last, deliberately — it is the category most likely to read as scaled content,
and it should be written once the house voice for crypto is settled across the other categories.

Batch 2: Perps & Funding · Batch 3: Crypto Dealer Flow · Batch 4: Crypto Options 101 ·
Batch 5: Volatility, Execution, Liquidations · Batch 6: Macro, Risk, Glossary, Compare ·
Batch 7: Per-Coin Structure.

---

## 7. Open

- One source lists Deribit options on **Polygon/POL** beside the seven NoVo maps. If that book is
  live it is an eighth, and `data-bookcount` is understating the product. Verify on the crypto side.
- The on-chain feed reads **191 tokens**, down from the 206–215 the site copy was written at.
  `sync-crypto-counts.js` floors to a step of 50, so the published claim dropped to "150+" —
  true, but under-claiming by 41 tokens. Either tighten the step or confirm the decline is real.
