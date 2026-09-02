# NoVo Options Trading — product & offering

The single source of truth for **what is free and what is paid**. If a claim on the site
disagrees with this file, one of them is a bug — check the code column and fix whichever is wrong.

Last verified against the deployed site and engine: **2026-08-30** (analyst/lookups sections).

> **Keep this current.** Any change to what a tier includes — a feature shipped, retired, moved
> across the paywall, or repriced — updates this file in the *same commit* as the page copy.
> That is the whole point of it; a stale offering doc is worse than none.

---

## The tiers

| | Price | Trial | Includes |
|---|---|---|---|
| **Free** | $0 | — | Public pages open to anyone; a **free account** adds the member portal |
| **NoVo Analyst** | $129/mo · $1,290/yr | 7 days, card required | The live dealer map + the read |
| **NoVo Trader** | $209/mo · $2,000/yr | **none** | Everything in Analyst + the live streaming map |
| **NoVo Crypto Market Map** | $79/mo · $790/yr | 7 days, card required | The crypto dealer map + the on-chain map + NoVo, **plus the private members Discord** (same guild and role as Analyst/Trader, wired 2026-08-30). **Its own product** — not included with Analyst or Trader, and neither is included with it — **unless bundled (below)** |
| **Analyst + Crypto bundle** | $169/mo · $1,690/yr | 7 days, card required | Everything in Analyst + everything in the Crypto Market Map, $39/mo under the two apart. One Stripe subscription with two line items (Analyst base + a $40/$400 crypto companion price) — added 2026-09-01 |
| **NoVo Complete bundle** | $239/mo · $2,300/yr | **none** (Trader has none, and a bundle must not reintroduce it) | Everything in Trader (Analyst included) + everything in the Crypto Market Map, $49/mo under the parts. Two line items (Trader base + a $30/$300 crypto companion) — added 2026-09-01 |

- **7-day money-back on the first payment, all plans.** Trader and the Complete bundle have no
  trial, so this is their evaluation window. Stated in `license.html`, `refund-policy.html`,
  `help.html`, `api/chat.js`, and under the Trader/Complete buttons on `plans.html`.
- **A bundle supersedes its parts.** Buying one auto-retires the standalone subs it contains
  (trialing → cancelled now, active → runs out its paid period); buying a part you already
  hold via a bundle is auto-cancelled and refunded. Wired in `api/webhook-sub.js`.
- **Price for life** — the rate you subscribe at holds while the subscription stays active.
- **Free follows the market, not the product.** We give away what the market already gives
  away and sell what the market sells. On the crypto side that was checked, not assumed:
  CoinGlass's free tier publishes funding, open interest and 24h liquidations; cryptogamma.io
  publishes a free BTC/ETH gamma dashboard off the public Deribit API. So those are free at
  `/api/crypto-free` too. What every competitor charges for — **history**, all-coin breadth,
  gamma by strike, walls and the flip, API access — is the subscription, along with the two
  things nobody sells at any price: Robinhood's disclosed cost-to-trade, and NoVo.
- The equity map's "the map stays gated" rule does **not** carry to crypto. That rule exists
  because OPRA options data is licensed; Deribit's is free and public. Charging for a BTC
  gamma summary would mean charging for something the market hands out.
- Cancel any time from the Stripe billing portal; access runs to the end of the paid period.
- One Terms of Service: **`/license`**. `/terms` 308s to it.

---

## FREE — no account, no card

Open to anyone, no sign-in. Note what is **not** here: the gamma flip and the expected move
moved behind a free account (see the next section). `api/levels.js` enforces it — without the
`x-novo-key` header it strips both fields and reports `gated: ['flip','expectedMove']`.

| What | Where it lives |
|---|---|
| Dealer levels, **delayed** — call wall, put wall, spot (**not** flip or expected move) | `/market-data`, `/market-data/{spy,qqq,iwm}` ← `api/levels.js` |
| Fear gauge — VIX / VXN / RVX ranked against their own 1-year history | market-data pages |
| **ATM IV and IV rank**, per ticker | `api/levels.js?iv=` — free by decision, it is a commodity metric |
| Market Pulse (fear/greed), sector heatmap, 24/5 futures ribbon | `api/market-pulse.js`, `api/heatmap.js` |
| Futures positioning — weekly CFTC Commitments of Traders | `/positioning` ← `api/positioning.js` |
| The track record — ten public claims scored, sample sizes shown | `/track-record` ← `api/track-record.js` |
| The public read archive — every desk note, after its session | `/analyst/archive` ← `api/analyst-publish.js` |
| The NoVo Journal — 1,042 articles | `/journal/` |
| Options 101, the 0DTE guide, 5 learn guides | `/options-101`, `/0dte`, `/learn/*` |
| Five calculators — expected move, max pain, position size, options P&L, Greeks | `/tools/*` |
| TradingView script — flip, walls and expected-move band on your own chart | `/tradingview` |
| Options glossary, economic calendar, market holidays | `/options-glossary`, `/economic-calendar`, `/market-holidays` |
| 5 comparison pages, and the methodology page | `/compare/*`, `/analyst/methodology` |
| Embeddable fear-gauge widget | `/embed-pulse` |

---

## FREE ACCOUNT — still no card

Created at `/signup` on the control plane. **There is no email-only signup anywhere any more** —
as of 2026-08-23 every capture on the site (the pricing card plus 1,054 page footers) asks for an
account instead. Signing up adds the free list; subscribing moves the contact to the Analyst list.

| What | Where it lives |
|---|---|
| **The member portal** — the whole point of the account | `control-plane/app.py` → `/portal` |
| **The dealer ladder** — call wall, **gamma flip**, spot, put wall and the **expected-move band**, on SPY, QQQ and IWM | portal ← `api/levels.js` with `x-novo-key` |
| Sectors today — 11 sector chips by the day's move | portal ← `api/heatmap.js` |
| Today's movers — top 8 of the liquid universe by absolute move | portal ← `api/trending.js` |
| Futures positioning, Market Pulse, fear gauges, next catalysts | portal ← `api/positioning.js`, `api/market-pulse.js`, `api/calendar.js` |
| Recent desk notes, the calculators and the learn links | portal ← `api/analyst-publish.js?feed=1` |
| A direct **Discord** link, and account/billing facts | portal, `/status` |
| The emails — Mid-Day Tape Review each trading day, the Sunday Week Ahead, new articles | Resend "Market Notes" list |

Still **delayed** data, same public feed the market-data pages read. The live map is the paid line.

**Where the account is managed:** `/signup`, `/status` (settings, billing, delete account) —
all on `app.novo-aitrading.app`, not the store.

---

## NoVo Analyst — $129/mo

The free pages give delayed levels. Analyst gives them **live on a ~60-second cadence**, plus the
layer underneath. Nothing in this section appears on any free page.

**The map**
- Net GEX · Gravity · Put/call skew · Skew near/far · **Vanna exposure** · **Charm per day**
- Gamma profile by strike, and **gamma by strike through the session** (time axis)
- **What this setup has historically resolved to** — the live dealer state (regime x distance to the
  flip x volatility tercile) matched against NoVo's own logged sessions: direction, hit rate and
  median over the next hour, with the sample size beside it. A bucket that misses the floor
  (>=12 observations across >=5 distinct sessions) renders nothing rather than a number.
- Per-ticker: SPY, QQQ, IWM

**Signals & flow**
- **'The Line'** — level-break playbooks on all three tickers. Triggers are prior-day high/low,
  opening-range high/low and pre-market high/low. **Not** the gamma flip — it is a moving level.
- Gamma-squeeze signal, per ticker
- Options flow — call vs put demand off chain volume, unusual-volume strikes. **Volume-based, not
  buy/sell prints** — keep that label.
- Sweeps & blocks — aggressor-tagged, computed in-house off the live dxFeed tape
- Historical analogues — "today looks like…", with how each resolved
- **Signal scorecard** — the gamma squeeze's direction and the tape's sweep bias graded against what
  price actually did over the following hour. Non-directional states (dormant, balanced) are counted
  for exposure and never scored.

**The read & the analyst**
- The Open, The Close, the Sunday Week Ahead — dashboard first, emailed, **and pushed**. Each cites
  what the current setup has historically resolved to, with its sample size — the read carries a
  record, not only a reading.
- **NoVo, the AI market analyst** — retrieval over 1,039 articles + its own logged observations,
  plus **28 read-only live lookups** spanning both maps: dealer levels, gamma profile, session
  history, **base rates**, its own track record, its recent reads, market internals, the
  **volatility record back to 1990** (every gauge with its percentile), **CFTC futures
  positioning**, quotes, macro calendar, earnings dates, headlines, and the crypto map, breadth,
  corpus and chain tokens.
  **Ask for a "deep read"** and it takes the long lane — more lookups, wider retrieval, a
  structured desk report (capped at 8/hour; past that it answers in the fast lane).
  **The raw archives are queryable** (2026-08-30): describe_archive + query_archive give it a
  read-only, sandboxed SELECT into the corpora behind every rollup — dealer snapshots, session
  bars to 2000, reconstructed maps to 2008, banked option chains, macro closes to 1990, the
  crypto 1-second tape and chain pools, its own published reads. Lives on the owner box; when
  the box is offline the archive tools degrade honestly and the live layer is unaffected.
  **The nine (2026-08-31), all live:** streamed answers; drawn charts (one `[[novochart]]` per
  answer when a computed series earns it); pasted/attached chart images read (text in an image is
  data, never instructions); **level alerts set in a sentence** (one-shot push, SPY/QQQ/IWM vs a
  price or the live flip/walls, VIX, any coin — 10 active, 7-day expiry, needs the push toggle
  once); **reader memory** (market interests/style only, account-shaped content refused
  server-side, erasable in a sentence); a **daily personal digest** (12:00 UTC cron; interests +
  a registered device required); web-grounded deep reads with cited sources; macro
  actual-vs-consensus (`days_back`); and the **live option chain** (±10% of spot, per publish).
  Market only — never accounts, trades or P&L; never advice (trades.db is not attachable —
  structural, not behavioral).
- Every hourly audit and desk note is kept and scored. NoVo writes each read with the session's
  earlier calls and its own record in hand.

**Delivery**
- Installable PWA + **push alerts** (The Line and each session's read), toggleable on the dashboard
- Private Analyst Discord — the reads channel + the 'Trader Floor'

---

## NoVo Trader — $209/mo · includes all of Analyst

**The angle (2026-08-31, amended 2026-09-01): Trader is the instrument, Analyst is the research
desk.** The overlap between the two dashboards is the product design, not a defect: everything
act-now lives on the Trader terminal; the step-back surfaces — NoVo the chat, the in-house flow
tape, the historical analogues, push notifications — live on the Analyst desk. Sell the pair as
"the cockpit and the desk." **Amendment (Apex build, 2026-09-01): dealer STRUCTURE now also rides
the cockpit** — the gamma-by-strike profile and the strike×time gamma field draw directly on the
Trader chart, under the live tape. The desk keeps the step-back READING of that structure (the
chat, analogues, flow tape); the cockpit shows it where the trade happens. That is the line now:
Analyst interprets, Trader renders.

- **The live dealer map, streamed** — the levels drawn on a candle chart that moves with the tape
- **Ticker switcher (2026-08-30)** — SPY / QQQ / IWM pills in the chart hero; per-viewer, instant,
  no restart. Candles, VWAP, EMAs, session levels and dealer levels all follow the selection; the
  Market Intel strip still describes the engine’s ticker (named in the nav pill)
- **Charting terminal (2026-08-30 late; Apex build 2026-09-01)** — six timeframes (1m/5m/15m
  client-agg; 1H/D/W off the engine’s dxFeed history lanes: ~9.5 months hourly incl. 24/5
  overnight sessions, 10y daily, 15y weekly); volume histogram; TradingView-style extended-hours
  shading; OHLCV crosshair legend **with VWAP/EMA values named at the hovered bar**; per-ticker
  read chip (net-GEX sign + % from flip); ticker·frame watermark. Chart runs 24/5 including
  Sunday nights. Timeframe flips are instant and keep the viewer’s exact window
- **Drawing editor (Apex, 2026-09-01)** — h-line / trendline / fib (conventional retracement
  ladder) / measure, persisted per ticker, **plus**: click-to-select, drag, per-drawing delete,
  undo, magnet snap to O/H/L/C, a right-click context menu, and **in-page price alert lines** —
  a dragged line that flashes the pane and beeps when the live tape crosses it. Client-side only:
  an alert touches no server and no broker
- **Scalper timing (Apex)** — a bar-close countdown pinned to the price axis at the live tip, a
  back-to-live chip when you’ve panned into history, and a full keyboard map (1-6 timeframes,
  arrows/+/- pan-zoom, Esc, Alt+H level drop, ? for the cheat sheet). Fullscreen and screenshot
  buttons on the toolbar
- **Dealer structure ON the chart (Apex)** — the GEX-by-strike histogram behind the candles
  (all-expiry structure faint, 0DTE bright — the wall is the biggest bar); dealer levels carry
  **strength** (line weight from the gamma behind them, fading as it decays into the close);
  levels in confluence merge into one stacked label; ‘The Line’ lost/reclaimed events pin to
  their bars; a net-GEX sparkline in the Market Intel strip; ghost lines where the longer-dated
  book disagrees with the day’s wall
- **⚙ dealer visuals, all default OFF** (the raw tape stays raw; each is a menu toggle) — regime
  tint above/below the flip, the EM decay cone (the day’s REMAINING priced move, √-decaying into
  the close), a gravity halo that turns on after 2pm, today’s wall-migration trails, a drift
  arrow (labelled “modeled”), and the **strike×time gamma heatmap** — the field drawn under the
  live tape, snapshot-cadence columns, mutually exclusive with the tint
- **ANALYSIS tab** — Analysis Feed | NoVo’s written read side by side; ‘The Line’ level-break
  playbook feed (per ticker); **The Three Books** — all three tickers’ dealer structure in one
  table incl. put/call skew and the MM fast/slow hedging split; What NoVo Knows beneath. Market
  Intel strip: full words across the whole bar, VIX far right
- **Every level labelled in the pane** — gamma flip, call and put walls, gravity, expected-move
  bands, VWAP, opening range, and the pre-market / after-hours / prior-day highs and lows
- **Structural audit rerun at the top of every hour** — macro bias, levels, patterns, thesis
- **What NoVo Knows** — base rates for the setup in front of you, **each with its sample size**
- **Run Analysis** — ask for a fresh read on demand, any time
- Market Intel strip — VIX, macro, retail state, RVOL, tape imbalance, net GEX, squeeze, score
- Live tape + full options chain for SPY, QQQ and IWM; live market data included
- Placed trades, broker connections and API keys are **not** part of this product
- Regime · Retail State · RVOL · Tape Imbalance
- **No push notifications** — by design; you are on the dashboard when you trade. (The chart’s
  in-page alert lines are not push: they fire in the open tab, from the tape, and nowhere else)

**Brokers: none.** NoVo does not connect to a brokerage account, hold API keys, or place orders.
You trade wherever you already trade. Non-custodial in the strongest sense: there is no connection
through which NoVo could reach your money.

---

## What the Crypto Market Map actually covers

Two halves, and the copy should never describe it as one brokerage's product list.

- **The coin half — ~91 mapped, 90 of them Robinhood-tradable.** `analyst.universe()` returns every
  coin with venue coverage worth reading, plus any coin carrying a real options book. TRX is the
  91st: a live Deribit book that Robinhood does not list. **Cost to trade is the ONE number scoped
  to the tradable 90** — it is read back from a broker's disclosed markup, so "all 90 coins" is
  correct in a cost sentence and wrong everywhere else.
- **Seven options books**, not six: BTC, ETH, SOL, XRP, AVAX, HYPE **and TRX**. Synced to the copy
  via `<span data-bookcount>`. BTC and ETH also carry the US-listed ETF book (IBIT / ETHA) beside
  the crypto one — but an ETF book must never be the DEFAULT for a coin, or the page renders an
  ETF share price under a coin header.
- **The on-chain half — 200+ tokens** on Solana and Robinhood Chain. No options book, no perp, so
  no gamma: the read is liquidity structure. Keyed on contract ADDRESS, never ticker.
- **Total ≈ 270 tokens.** The rail says "filter N tokens" from that total.

**Claims to avoid** (all were on the site and all are refutable): "every book that exists",
"the gamma tools stop at four coins", and any competitor price band quoted as the market — one
vendor publishes gamma on ~10 currencies for less than $79. Say "most stop at two to four".

## Standing rules this offering depends on

1. **Entry is always the user's click.** Only exits are automated. No auto-entry, no autonomy
   toggle, ever. Any copy or screenshot implying otherwise is a defect.
2. **No performance claims** — no win rates, P&L figures or implied returns on public pages.
3. **The AI reads the market, not your account.** Enforced structurally: no tool in
   `api/_lib/tools.js` can reach an account, an order or `trades.db`.
4. **Options flow is volume-based**, not buy/sell prints. Sweeps & blocks is the separate,
   real print-tape feature.
5. **Analyst refresh ~60s, Trader telemetry ~5s.** That gap is the tier line, not an error.

## Card parity

Every page that shows a pricing card must show the paid tier as **at least** as substantial as the
free one. The free tier is genuinely large, so a thin paid card inverts the pitch.

| Page | Free | Paid |
|---|---|---|
| `/plans` | 12 | Analyst 14 · Trader 18 |
| `/` | 12 | Analyst 13 |
| `/analyst` | 12 | Trader 11 (cross-sell) |
| `/trader` | 12 | Analyst 13 (cross-sell) |

Each product page shows Free plus the **other** tier as the cross-sell. Change one card, change all
four — they are copy-pasted per page, not included. See [[verify-fix-count-not-page]].

## Where to check when this changes

| Question | Look at |
|---|---|
| What does the Analyst dashboard actually render? | `public/analyst-live.html` |
| What does the Trader dashboard render? | `NoVo-Pulse/c2_dashboard.py` |
| What does the AI analyst have access to? | `api/_lib/tools.js`, `api/analyst-ask.js` |
| What does an anonymous visitor get? | `api/levels.js` + the `market-data*` pages |
| What does a free **account** get? | `NoVo-Pulse/control-plane/app.py` → `_free_snapshot`, `/portal` |
| What does checkout actually charge? | `api/checkout-analyst.js`, `api/checkout-sub*.js` |
| What is promised in writing? | `public/license.html`, `refund-policy.html`, `api/chat.js` |
