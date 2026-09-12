# RH_NoVo crypto data survey

**Question:** what crypto data can we get from the Robinhood MCP (`RH_NoVo`) that we do not already have?
**Method:** broad ToolSearch enumeration (never `select:` by guessed name) across `crypto`, `coin bitcoin ethereum`, `quote price historical`, `holdings positions portfolio`, `order book depth`, `robinhood`, and `+RH_NoVo`, followed by read-only sampling of every crypto-capable tool on BTC, ETH, and SOL. Zero write/order/cancel/exercise tools were called — see Limits.
**Date:** 2026-09-12. Samples in this directory: `get_currency_pairs__catalog.json`, `get_crypto_quotes__BTC_ETH_SOL.json`, `get_crypto_positions__account_423584523.json`, `get_crypto_orders__account_423584523.json`, `get_crypto_account_onboarding_info.json`.

---

## Step 1 — Complete tool inventory (73 tools)

Six broad ToolSearch queries plus `+RH_NoVo` were run at `max_results` 30–50 each. Combined, they surfaced every `mcp__RH_NoVo__*` tool the connector exposes — confirmed against the harness's own deferred-tool listing, which enumerates the server's full registered tool set independent of any query. **73 tools total.** This is the positive control: the connector is reachable and fully enumerable, so any absence below is a proven absence, not a search failure.

### Crypto-dedicated (8)
| Tool | Type | Notes |
|---|---|---|
| `get_crypto_quotes` | read | bid/ask/mark, prev close, routing venue |
| `get_currency_pairs` | read | catalog of tradable pairs + order-mechanics metadata |
| `get_crypto_positions` | read | caller's own holdings (account-scoped, not market data) |
| `get_crypto_orders` | read | caller's own order history (account-scoped) |
| `get_crypto_account_onboarding_info` | read | account provisioning status only |
| `preview_crypto_order` | simulate | **not called** — name contains "order"; treated as in-scope for the safety rule |
| `place_crypto_order` | **write** | not called |
| `cancel_crypto_order` | **write** | not called |

### Crypto-adjacent (12) — general tools where crypto is one supported asset class
`create_alert`, `get_alerts`, `update_alert`, `delete_alert`, `get_alert_log` (asset_class=crypto), `search` (asset_type=currency_pair), `add_to_watchlist`/`remove_from_watchlist` (currency_pair_ids), `get_watchlist_items` (object_type=currency_pair), `get_pnl_trade_history`, `get_realized_pnl` (asset_classes includes crypto), `get_accounts` (echoes `rhc_account_number`, the linked crypto account).

### Non-crypto (53)
Equity: `get_equity_quotes`, `get_equity_historicals`, `get_equity_fundamentals`, `get_equity_technical_indicators`, `get_equity_news`, `get_equity_price_book`, `get_equity_positions`, `get_equity_orders`, `get_equity_tax_lots`, `get_equity_tradability`, `place_equity_order`, `review_equity_order`, `cancel_equity_order`, `get_financials`, `get_earnings_calendar`, `get_earnings_results`.
Options: `get_option_chains`, `get_option_instruments`, `get_option_quotes`, `get_option_historicals`, `get_option_positions`, `get_option_orders`, `get_option_watchlist`, `add_option_to_watchlist`, `remove_option_from_watchlist`, `place_option_order`, `review_option_order`, `cancel_option_order`, `exercise_option`, `cancel_option_exercise`, `get_option_level_upgrade_info`.
Indexes: `get_indexes`, `get_index_quotes`, `get_index_historicals`.
SEC filings: `get_sec_filing`, `get_sec_filing_index`, `get_sec_filing_facts`, `get_sec_filing_facts_catalog`.
Scanner: `get_scans`, `create_scan`, `update_scan_config`, `update_scan_filters`, `run_scan`, `get_scanner_filter_specs`.
Watchlists (general): `get_watchlists`, `create_watchlist`, `update_watchlist`, `follow_watchlist`, `unfollow_watchlist`, `get_popular_watchlists`.
Account/portfolio: `get_portfolio`, `get_limited_margin_upgrade_info`, `mark_alerts_read`.

**A structurally important absence, proven by the same enumeration:** there is no `get_crypto_historicals`, no crypto technical-indicators tool, no crypto news/fundamentals tool, no crypto order book / Level-2 depth tool (the only depth tool, `get_equity_price_book`, is equity-only per its own description), and no crypto options chain (Robinhood's options tools are equity/index-underlying only). These gaps are load-bearing for Step 3.

---

## Step 2 — Samples (read-only, BTC/ETH/SOL where applicable)

- `get_crypto_quotes(["BTC-USD","ETH-USD","SOL-USD"])` → real-time bid/ask/mark + previous close, ms-precision timestamps, execution routing label. See `get_crypto_quotes__BTC_ETH_SOL.json`.
- `get_currency_pairs(limit=700)` → full catalog, single page, **91 pairs** (no `next` cursor — this is the whole Robinhood-tradable crypto universe, not a partial page). See `get_currency_pairs__catalog.json`. BTC-USD, ETH-USD, SOL-USD all present.
- `get_crypto_positions(rhs_account_number=423584523)` → empty (no crypto held on the one agentic-accessible account). See `get_crypto_positions__account_423584523.json`.
- `get_crypto_orders(rhs_account_number=423584523)` → empty (no crypto order history on that account). See `get_crypto_orders__account_423584523.json`.
- `get_crypto_account_onboarding_info()` → `already_onboarded: true`. See `get_crypto_account_onboarding_info.json`.

`preview_crypto_order`, `place_crypto_order`, `cancel_crypto_order` were **not called** — see the safety rule and Limits.

---

## Step 3 — Per-field classification vs. our live crypto-free asset

Baseline (per the task prompt, measured live minutes before this run from `GET /api/crypto-free`, not independently re-verified — see Limits): 90 coins, 91 mapped, 7 with a real options/dealer book, 90 liquidity bands, 14,499,110 corpus rows; per-coin we publish `coin`, `band`, `price`, `tradable`, `chg24h`, an 8-point sparkline; the paid map adds gamma-by-strike, funding per venue, open interest, liquidation flow, and true cost to trade.

| RH field / capability | Source tool | Classification | Why |
|---|---|---|---|
| `bid_price` / `ask_price` | `get_crypto_quotes` | **NEW** | We publish one `price` number, no spread. RH gives live top-of-book both sides (BTC sample: bid 77221.18 / ask 77221.19, a 1¢ spread) — a direct, free proxy for cost-to-trade that we don't have anywhere in the free tier. |
| `mark_price` | `get_crypto_quotes` | DUPLICATE | Same concept as our `price` field. |
| `open_price` (prior-session close) | `get_crypto_quotes` | DUPLICATE, with a caveat | Same concept as our `chg24h` anchor, but RH anchors to **midnight US/Eastern** (or the caller's IANA timezone), not a rolling 24h window — the two numbers will diverge intraday even if both are "correct." Not a straight swap-in. |
| `bid_time` / `ask_time` / `updated_at` (ms precision) | `get_crypto_quotes` | **BETTER** | Sample BTC quote: `updated_at: 2026-09-12T13:47:16.982-04:00` — sub-second tick data. Our 14.5M-row corpus and 8-point sparkline read as a periodic-snapshot design; RH is live order-book ticks. We have no comparable freshness number to cite for our own feed, which is itself a gap worth flagging. |
| `routing` (which venue priced the quote — exchange vs. market-maker, per-account) | `get_crypto_quotes` | **NEW** | Nothing like this exists in our product; it's venue-level pricing transparency (all 3 samples returned "Exchange Routing"). |
| `tradability` + `tradability_by_account_type` | `get_currency_pairs` | **BETTER** | Our `tradable` is a flat boolean. RH breaks it out per account type — e.g. a coin can be `tradable` for `individual` but `untradable` for `ira_roth`/`ira_traditional`. Of 91 pairs, IRA-tradability differs from individual-tradability on some (not diffed exhaustively — see Limits). |
| `halted` + `halted_regions` | `get_currency_pairs` | **NEW** | 33 of 91 pairs (36%) are currently `halted: true` in this sample, several with a `halted_regions` list (e.g. `["NY"]` — a BitLicense-style state-level halt). We have no halt/region concept at all; a flat `tradable:false` can't distinguish "delisted" from "temporarily halted in one state." |
| `min_order_size`, `max_order_size`, `min_order_quantity_increment`, `min_order_price_increment`, `min_order_quote_amount`, `market_orders_only` | `get_currency_pairs` | **NEW** | Order-mechanics/tick-size metadata (e.g. BTC: min size 0.000001, max 20, price increment $0.01). We publish none of this; it's only useful if we ever let users act on the data, not for a read-only feed. |
| `display_only` | `get_currency_pairs` | NEW but marginal | 1 of 91 pairs (POL-USD) — shown but not orderable. Low value at this scale. |
| Crypto order-book depth (Level 2) | — | **absent / UNUSABLE** | Confirmed absent in Step 1: `get_equity_price_book` is equity-only; there is no crypto counterpart. RH gives top-of-book only, not depth. |
| Crypto historical OHLC bars | — | **absent / UNUSABLE** | Confirmed absent in Step 1: every other asset class (equity, option, index) has a dedicated `*_historicals` tool; crypto does not. RH cannot back our sparkline even if we wanted it to. |
| `get_crypto_positions` / `get_crypto_orders` fields (quantity, cost basis, order history) | — | UNUSABLE for this product | This is the caller's own account data, not public market data — not publishable in a market-data product regardless of value. |
| `get_crypto_account_onboarding_info` | — | UNUSABLE | Account-provisioning flag, no market-data relevance. |
| Options gamma-by-strike, funding per venue, open interest, liquidation flow | — | **UNUSABLE, structurally** | Not a sampling gap — the connector has no crypto options chain and no perpetual-futures/funding concept anywhere in its 73 tools. Robinhood only offers **spot** crypto to retail here; derivatives data for crypto (which is what the paid map's 7-coin dealer book depends on) doesn't exist on this connector at all. |

**Coverage overlap:** RH's catalog is 91 pairs vs. our 90 coins / 91 mapped — very close in size. No symbol-level diff was performed (we were not given our own 90-coin list to diff against); see Limits.

---

## Step 4 — Null-result proof (not applicable, but documented per instructions)

Not a null result: RH does expose crypto-specific tools. Per Step 4's requirement to prove rather than assert, the "no crypto options / no crypto historicals / no crypto depth" claims above are backed by the full 73-tool inventory in Step 1, enumerated via the harness's own deferred-tool listing (independent of guessed names) — those three capabilities are provably absent, not just unfound by search.

---

## Step 5(c) — Recommendation

- **Worth wiring in, cheaply:** bid/ask spread (`get_crypto_quotes`) as a free, real per-coin liquidity/cost-to-trade signal — this is the one genuinely new, immediately usable field, and it's a single call for up to however many symbols the tool accepts. `halted` / `halted_regions` from `get_currency_pairs` would also upgrade our flat `tradable` boolean into something that explains *why*, for cheap (catalog is a single ~91-row, no-pagination-needed call).
- **Not worth it:** everything else. The order-mechanics fields (min/max size, increments) have no use in a display product. The account-scoped tools (positions/orders/onboarding) aren't market data and can't be published. The paid map's differentiators (gamma by strike, funding, OI, liquidation flow) are structurally unavailable — RH has no crypto derivatives surface on this connector, so there's no path to closing that gap through Robinhood at all, at any tier.
- **Net:** RH is a marginal, free upgrade to two of our five free-tier fields (spread as new data, tradable-with-reason as a better version of an existing field). It does nothing for the paid map.

## Step 5(d) — Limits

- **Live baseline not independently re-verified.** The prompt's `/api/crypto-free` numbers (90 coins, 91 mapped, 7 dealer-book, 90 bands, 14,499,110 rows) were used as given. This session's outbound network policy returned a 403 at the proxy for `novo-options.trade` (`connect_rejected`, organization policy) — confirmed via `curl` and the proxy's own `/__agentproxy/status`, not assumed. No local `.db` was touched, per the standing rule against testing against local market data.
- **Only BTC/ETH/SOL sampled directly** via `get_crypto_quotes`; the catalog call (`get_currency_pairs`) returned all 91 pairs in one page, so tradability/halt/order-mechanics fields *are* verified across the full catalog, but bid/ask/mark freshness and routing behavior were only checked for those 3 symbols — not proof that all 91 quote cleanly or that routing is uniform across the catalog.
- **No symbol-level diff against our own 90-coin list** — we weren't given it in this task, so "how much of RH's 91-pair catalog overlaps our 90 coins" is unverified beyond confirming BTC/ETH/SOL are common to both.
- **No write/order-adjacent tool was called or inspected beyond its schema** — `preview_crypto_order`, `place_crypto_order`, `cancel_crypto_order` are documented from their tool descriptions only (Step 1 table), never invoked, per the absolute safety rule (this is a live account).
- **Freshness of our own feed is asserted, not measured** — the "RH is fresher" claim in Step 3 rests on RH's ms-precision timestamps being visibly live at capture time; we have no equivalent instrumentation of our own corpus's update cadence to cite a hard number against.
