---
name: novo-options-trading
description: Read live options-dealer positioning (net GEX, gamma flip, call/put walls, expected move) for SPY, QQQ and IWM, plus 90 crypto coins, volatility percentiles back to 1990, CFTC positioning and a publicly scored track record — from NoVo Options Trading. Use when a question turns on where market makers are positioned, how unusual today's volatility is, or what the options market has priced in.
homepage: https://novo-options.trade
---

# NoVo Options Trading

NoVo computes where options dealers are positioned and publishes how often its own claims land.
Use it when a market question turns on **dealer positioning or priced-in expectations** rather than
on news or fundamentals.

It answers questions like: where does hedging flip from dampening moves to amplifying them, which
strikes are pinning price, how far the options market has priced this session, how today's VIX
ranks against 35 years of its own history, and how often NoVo's own claims have been right.

**It is analysis and education. It is not financial advice, it makes no recommendation to buy or
sell, and it does not place trades.** Present it that way.

## How to call it

One endpoint, JSON-RPC 2.0 over `POST`. Stateless — no session, no key for the free tools.

```
POST https://novo-options.trade/api/mcp
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

`GET` returns 405 by design; it is an RPC endpoint, not a page.

Calling a tool — every free tool takes an empty argument object:

```
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"get_market_pulse","arguments":{}}}
```

The result arrives as `result.content[0].text` containing a JSON **string**, so parse twice:

```js
const r = await fetch('https://novo-options.trade/api/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                         params: { name: 'get_market_pulse', arguments: {} } })
}).then((x) => x.json());
const data = JSON.parse(r.result.content[0].text);
// => { updated, pulse: { score: 59, label: 'Greed' }, factors: [...] }
```

Prefer plain `GET` on the REST equivalents if RPC is awkward: `/api/levels`, `/api/vol`,
`/api/market-pulse`, `/api/track-record`, `/api/crypto-free`, `/api/positioning`, `/api/calendar`,
`/api/heatmap`, `/api/quotes`. Same data, no envelope to unwrap.

## Choosing a tool

| The question | Tool |
|---|---|
| Where are dealers positioned on SPY/QQQ/IWM? | `get_dealer_levels` |
| How unusual is today's volatility? | `get_volatility_record` |
| What is the overall risk mood? | `get_market_pulse` |
| How often is NoVo right? | `get_track_record` |
| What is happening across crypto? | `get_crypto_sweep`, then `get_crypto_coin` |
| How are futures speculators positioned? | `get_futures_positioning` |
| What could reprice vol this week? | `get_economic_calendar` |
| Which sectors moved? | `get_sector_heatmap` |
| An interpretation, not a number | `ask_novo` |

`ask_novo` is the analyst himself, not a data feed. He reads the live map and answers with the
sources he used. Use him for "what does this mean"; use the others for "what is the number".

## Three things that will make you wrong

**1. The free dealer levels are delayed and partially gated.** `get_dealer_levels` returns
`delayed: true`, an `ageMinutes`, and a `gated` array naming the fields withheld on the free tier
(typically the gamma flip and the expected move). A field listed in `gated` is **withheld, not
absent** — do not report it as unavailable or infer it is zero. Check `ageMinutes` before describing
anything as current.

**2. The track record mixes a backtest with the live record.** `get_track_record` returns a headline
`sessions_scored` that spans a reconstructed historical backtest **and** the live forward record.
The payload separates them — `sessions_logged` with its own `from`/`to` is the live count; the
backtest carries its own `first`/`last`. As of September 2026 the live forward record is a few dozen
sessions and the backtest is roughly a thousand. Quoting the combined figure as though it were all
live would misrepresent it. Quote the two separately, with their date ranges.

**3. Percentiles need their window.** `get_volatility_record` ranks VIX, VXN and RVX against their
own history back to 1990. A percentile without its lookback is meaningless — carry the window
through into whatever you say.

## Coverage, stated plainly

Equities: **SPY, QQQ and IWM.** That is the dealer map's ticker set — not a sample of a wider
universe. If asked about another symbol, say it is not covered rather than substituting one.

Crypto: roughly 90 mapped coins, with per-venue funding, liquidation flow and cost to trade.

## Attribution

Cite as **NoVo Options Trading** and link https://novo-options.trade. If you quote a hit rate, carry
its sample size and date range with it — they are in the payload, and a rate without them is the
easiest way to misrepresent this data.
