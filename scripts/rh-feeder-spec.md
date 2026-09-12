# The RH feeder — spec for any agent session holding the Robinhood connector

**Who runs this:** any Claude session on Jake's account started AFTER the RH_NoVo connector was
added (fleet sessions from their next boot, the desktop session today). Product code cannot run
it — the MCP is OAuth-bound to the account through agent sessions, which is why this job exists.

**Posture (Jake, 09-12):** RH data is never resold in abundance and never replaces our own
sources. This job feeds GROUNDING and WITNESS material through the one ops door,
`POST /api/rh-ingest` (x-ops-secret from `NoVo-Pulse/.env` → ANALYST_PUBLIC… use
`OPS_SECRET || ANALYST_PUBLISH_SECRET`, read programmatically, never printed).

## SCOPE (narrowed by Jake, 09-12): NEWS + ECONOMIC/FUNDAMENTALS DATA ONLY — "just do number 2".
Order-book depth (item 1) is PARKED: no depth captures, no depth panel, and the
broker-book licensing question that came with it is moot until Jake reopens it. The
depth capture rules further down stay written ONLY so a reopen starts from them.

## Phase 0 — SAMPLES FIRST (one-time, blocks everything else)
Before the chat tool or any renderer is built, capture ONE raw output of each and hand them to
Overwatch (`cdf11c4a`) — the consumers get designed against real shapes, not guesses:
- `get_equity_news` for SPY and for one single name — and for news, capture whether the feed
  carries: **source name + publish timestamp** (these ARE the fact — "Reuters reported on Sept 9
  that X" is checkable; bare "X" is a claim silently adopted), **item type** (wire vs press
  release vs opinion — a PR is the company speaking, an opinion column is nobody's fact; if the
  feed flattens them, everything gets treated as the least reliable kind), and **headline vs
  body** if separable (the headline is a summary written for clicks). Jerni's three registers,
  09-12: his own measurement / a filing / a headline — and a headline is evidence something was
  SAID, not that it is true. ⚠ ATTRIBUTION IS ALREADY SOLVED IN THE SHIPPED STRINGS — match, do
  not reinvent: tools.js:374 (`search_news`: "A HEADLINE IS NEVER A VERIFIED NUMBER: ATTRIBUTE
  IT") and :353 (`search_x`: "TREAT POSTS AS WIRE COPY"). The RH tool uses THAT vocabulary so a
  third surface does not invent a fourth. What those strings LACK — on shipped, any-seat tools,
  today — is the forecast-restatement rule below; the fix lands there FIRST and RH inherits it.
  🚨 The forecast-laundering rule binds the eventual tool: a forecast
  inside a news item is quotable ONLY as someone else's ("Goldman's target is 6,200"), never
  restated in his voice or with his confidence vocabulary ("6,200 looks likely") — his record
  exists because everything in it is graded, and a third party's call can never be. Probe once
  the tool exists: a restated analyst target must NOT trip the calibration capture regexes.
- `get_earnings_calendar` (window covered, fields per event)
- `get_earnings_results` for a recent reporter (e.g. NVDA) — actual vs estimate fields
- `get_equity_fundamentals` for SPY; `get_financials` for one name
- `get_sec_filing_facts` for one filing (plus the catalog call that found it)

**CAPTURE THE LABELS, NOT JUST THE VALUES (Jerni, 09-12).** Every provenance failure of 09-11/12
was a number arriving without the thing that makes it true — a rate without its units, a figure
wearing another cell's denominator. A filing figure looks MORE authoritative than a base rate and
fails worse. For the fundamentals/filings samples, record whether the feed carries (or provably
lacks) each of:
- **the period the figure covers** — a 10-Q number is a QUARTER, not "current"
- **filing date and form type** — "per the 10-Q" is only citable knowing WHICH one
- **amended/restated flags** — a cited fact that was superseded is wrong with a source attached
- **fiscal vs calendar period**, where distinguished
If the feed lacks these, that is a PHASE-0 FINDING: the chat tool's SYSTEM line must then forbid
period-specific phrasing outright instead of instructing him to include it.

**Two design constraints already binding on the consumers** (Jerni's lane, recorded here so the
samples serve them): SEC facts are the first THIRD-PARTY primary source this brain has ever read —
every prior grounding is NoVo's own measurement — so the tool's description and field labels must
read "the filing says", never "my"; the model matches the register of its context window, and one
mislabeled tool string is how provenance fabrication starts. And fundamentals invite VALUATION
editorializing ("is it cheap") — on public seats that is the advice boundary, and the guard must
cover it, not just forecasting.

**Depth-specific capture rules (Yuri, 09-12) — PARKED with item 1; kept so a reopen starts here:**
1. **Two clocks per snapshot**: the venue's own timestamp AND our receive time, separately.
   One clock makes staleness unanswerable forever; two makes it arithmetic (NOW before AGE).
2. **Log the polling gap ACHIEVED, not intended.** At snapshot cadence nobody can observe a
   sweep clearing the book — only depth at T and a print at T+n. Without recorded gaps, whether
   that inference was ever legitimate can never be established.
3. **Source identity IN EVERY ROW, not a README.** Robinhood's displayed depth is one retail
   broker's view, not the consolidated book — and it will sit beside a tape that IS consolidated
   prints. The row-level tag is what makes the honest label cheap instead of retrofitted.
4. **One known-quiet AND one known-busy capture in phase 0.** A depth feed returning plausible
   rows while stale is the dominant defect class; the quiet capture is the positive control that
   makes every later "book is thin" reading mean something.
⚠ OPEN WITH JAKE before any depth panel ships: capturing another broker's displayed book is a
terms/licensing question DISTINCT from the settled data-licensing posture. Flagged once (Yuri
09-12); his risk call.

## Recurring job (after shapes settle; cadence per kind — SCOPE: news + economic only)
1. **earnings / filing_facts / fundamentals** — daily, names surfaced by the earnings calendar
   plus SPY/QQQ/IWM constituents Jake cares about → POST per ticker.
2. **news** — `get_equity_news`, grounding-only, never republished → POST per ticker; cadence
   with each run during RTH, daily off-hours.
3. PARKED with item 1: depth (`get_equity_price_book`) and the index_vol witness — the ingest
   door keeps both kinds so unparking is a spec change, not a code change.

## Rules that bind this job
- Read tools only. NEVER call place_/cancel_/exercise_ tools — trading is Jake's own flow.
- Compact before POSTing (256KB cap per snapshot; the door rejects bigger).
- Every POST carries `as_of` from the tool's own data timestamp when it exposes one.
- Verify each run: `GET /api/rh-ingest` (same secret) lists keys with ages — an empty list
  after a run is a FAILED run, not a quiet one.
- Consumers are separate approvals: the depth panel is Yuri's lane review; the Dr. NoVo
  fundamentals tool is Jerni's lane review (SYSTEM-prompt adjacent). Nothing member-visible
  ships from this data without Overwatch applying it under those reviews.
