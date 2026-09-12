# The RH feeder — spec for any agent session holding the Robinhood connector

**Who runs this:** any Claude session on Jake's account started AFTER the RH_NoVo connector was
added (fleet sessions from their next boot, the desktop session today). Product code cannot run
it — the MCP is OAuth-bound to the account through agent sessions, which is why this job exists.

**Posture (Jake, 09-12):** RH data is never resold in abundance and never replaces our own
sources. This job feeds GROUNDING and WITNESS material through the one ops door,
`POST /api/rh-ingest` (x-ops-secret from `NoVo-Pulse/.env` → ANALYST_PUBLIC… use
`OPS_SECRET || ANALYST_PUBLISH_SECRET`, read programmatically, never printed).

## Phase 0 — SAMPLES FIRST (one-time, blocks everything else)
Before any renderer or chat tool is built, capture ONE raw output of each and hand them to
Overwatch (`cdf11c4a`) — the consumers get designed against real shapes, not guesses:
- `get_equity_price_book` for SPY
- `get_equity_fundamentals` for SPY; `get_financials` for one name
- `get_earnings_results` for a recent reporter (e.g. NVDA)
- `get_sec_filing_facts` for one filing (plus the catalog call that found it)
- `get_index_quotes` for VIX/VXN/RVX (do they exist there? which symbols resolve?)

## Recurring job (after shapes settle; cadence per kind)
1. **depth** — `get_equity_price_book` SPY/QQQ/IWM → compact to top-of-book + a few levels per
   side + imbalance summary → POST kind=depth per ticker. RTH cadence: with each run.
2. **earnings / filing_facts / fundamentals** — daily, names surfaced by the earnings calendar
   plus SPY/QQQ/IWM constituents Jake cares about → POST per ticker.
3. **index_vol** — VIX/VXN/RVX quotes → POST kind=index_vol; the ops cross-check compares them
   to the engine's own fear-gauge values and reports drift to Overwatch WITH both numbers.
4. **news** — only when a consumer exists; grounding-only, never republished.

## Rules that bind this job
- Read tools only. NEVER call place_/cancel_/exercise_ tools — trading is Jake's own flow.
- Compact before POSTing (256KB cap per snapshot; the door rejects bigger).
- Every POST carries `as_of` from the tool's own data timestamp when it exposes one.
- Verify each run: `GET /api/rh-ingest` (same secret) lists keys with ages — an empty list
  after a run is a FAILED run, not a quiet one.
- Consumers are separate approvals: the depth panel is Yuri's lane review; the Dr. NoVo
  fundamentals tool is Jerni's lane review (SYSTEM-prompt adjacent). Nothing member-visible
  ships from this data without Overwatch applying it under those reviews.
