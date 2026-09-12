# RH feeder — Phase 0 findings

Captured 2026-09-12 (UTC), per `scripts/rh-feeder-spec.md` Phase 0. Scope per Jake's 09-12
narrowing: **news + earnings/economic + fundamentals + SEC filing facts only** — no order-book
depth (parked with item 1; not touched here).

Raw samples live alongside this file:
- `get_equity_news_SPY.json`, `get_equity_news_NVDA.json`
- `get_earnings_calendar.json`
- `get_earnings_results_NVDA.json`
- `get_equity_fundamentals_SPY.json`
- `get_financials_NVDA.json`
- `get_sec_filing_index_NVDA.json`
- `get_sec_filing_facts_catalog_NVDA_10Q_page1.json` (full raw first page, 50 of 309 concepts;
  `next_offset` present, not paginated further for phase-0 purposes)
- `get_sec_filing_facts_catalog_NVDA_10Q_document_concepts.json` (catalog filtered to
  `concept_contains=Document`)
- `get_sec_filing_facts_NVDA_10Q.json` (facts for a handful of financial concepts + the
  document/fiscal metadata concepts, same filing)

All calls were read-only (`get_*`); no `place_/cancel_/exercise_` tool was called.

---

## 1. News (`get_equity_news`) — SPY and NVDA

Each article object's verbatim field set (from `.data.articles[]`):

```
id, title, publisher, preview_text, content, published_at, source_type
```

Top-level response also carries `data.symbol`, `data.next_cursor`, and a `guide` string:
> "Articles are newest-first. Use next_cursor on a follow-up call to fetch older articles; omit
> cursor for the first page. Attribute headlines to publisher when quoting or summarizing."

### Source name + publish timestamp — PRESENT
- `publisher` is a real name: **"Benzinga"** or **"MT Newswires"** across both SPY (26
  Benzinga / 4 MT Newswires of 30) and NVDA (25 Benzinga / 5 MT Newswires of 30) samples.
- `published_at` is a full ISO-8601 timestamp with timezone offset, e.g.
  `"2026-09-11T13:27:52-04:00"`. This is a real per-article timestamp, not a date-only field —
  age-in-hours is computable directly.
- `source_type` is a lowercase, machine-friendly duplicate of `publisher`
  (`"benzinga"` / `"mt_newswires"`) — it is a **publisher slug, not an article-genre tag** (see
  below).

**Verdict: source name + publish timestamp are both carried and directly usable for "Reuters
reported on Sept 9 that X"-style attribution language.** (Publishers seen so far are Benzinga and
MT Newswires, not Reuters — the register point is about attribution mechanics, not this specific
outlet.)

### Item type (wire vs press release vs opinion) — ABSENT
`source_type` only ever takes two values, `benzinga` and `mt_newswires` — it identifies the
**aggregator/wire vendor**, not the nature of the individual piece. Titles in the same NVDA sample
span genres that a member (and Dr. NoVo) would grade very differently:
- Straight market-moving report: `"CPI Inflation Came Hot: Watch These Stocks If Kevin Warsh
  Hikes Next Week"`
- Attributed opinion/quote round-up: `"Jensen Huang Calls NVIDIA the 'World's First and Only
  Growth Value Stock'"`, `"Jensen Huang Mocks Nvidia 'Circular Financing' Fears..."`
- Explicitly rumor-grade, labeled by the publisher itself as such:
  `"Market Chatter: Nvidia, OpenAI, Oracle and Cisco AI Data Center Plan in UAE May..."`
- Social-sentiment roundup: `"Social Buzz: Wallstreetbets Stocks Mixed Premarket Friday..."`
- Templated ticker-blurb: `"What's Going On With AMD Stock Friday?"`

All five carry `source_type: "benzinga"` (or `mt_newswires` for the "Market Chatter"/"Social
Buzz" pieces) — **the field cannot distinguish a CPI-data wire report from a "chatter"-labeled
rumor piece or a CEO quote roundup.** There is no `item_type`, `category`, or similar concept in
the schema.

**Phase-0 finding: item-type (wire / PR / opinion) is ABSENT.** Per spec, this means everything
from this feed should be treated as the least-reliable kind by default; the eventual chat tool's
SYSTEM line should not claim a wire-vs-opinion distinction it cannot make from this field, and
should lean on `title`/`content` text patterns (e.g. "Market Chatter:", quote-attribution
phrasing) only as a soft heuristic, never as ground truth.

### Headline vs body — PRESENT, three levels are actually distinct (not a duplicate render)
Verified against real content (`get_equity_news_NVDA.json` article index 3):
- `title`: `"What's Going On With AMD Stock Friday?"`
- `preview_text`: `"AMD shares climb as its $2 trillion AI opportunity, Helios platform and
  bullish analyst calls put the chipmaker in focus."` (a written summary/dek, not a substring of
  the title)
- `content`: full article body starting `"Advanced Micro Devices Inc. (NASDAQ: AMD ) stock
  traded nearly 2% higher Friday as semiconductor and AI-linked stocks be..."`

So `title` (headline, written for clicks), `preview_text` (a separate summary/dek), and `content`
(full body) are three genuinely separate strings — headline-vs-body separation is available, and
in fact one level richer than the spec asked for.

### Attribution vocabulary
Per spec, the RH tool should reuse the vocabulary already shipped in `tools.js:374`
(`search_news`: "A HEADLINE IS NEVER A VERIFIED NUMBER: ATTRIBUTE IT") and `:353` (`search_x`:
"TREAT POSTS AS WIRE COPY") rather than inventing new phrasing — not independently verified in
this phase-0 pass (no tool-string design happened here), flagged for whoever builds the tool.

### Cap / pagination
`next_cursor` is a real opaque cursor (base64-looking string), confirmed present and non-empty on
both SPY and NVDA first-page responses — pagination for the 12-items-per-ticker cap (Yuri's rule)
is mechanically supported.

---

## 2. Earnings calendar (`get_earnings_calendar`)

Default call (`start_date` omitted → today US/Eastern; `days` omitted → 7-day forward window)
returned 35 events across many tickers, none of them SPY/QQQ/IWM-style large caps in this
particular window (the sample is dominated by small/micro-cap names — this window simply had no
large-cap reporters, not a tool defect; `filter=high_market_cap` is documented as returning an
explicitly empty list rather than erroring in that case).

Per-event fields: `symbol, year, quarter, eps.estimate, eps.actual, report.date, report.timing,
report.verified`.

- **Window covered**: exactly what was requested (7 days forward from 2026-09-12, i.e.
  2026-09-13 through 2026-09-18 inclusive) — confirmed against the returned `report.date` range.
- **`report.verified`**: present and mixed true/false in-sample (e.g. `SLMT` false, `PLAY` true)
  — the guide instructs treating unverified dates as tentative. This is itself a
  label-quality signal worth carrying into any card ("tentative" vs confirmed date).
  **This appears to be the closest thing to a "confidence" flag anywhere in the RH data, and it
  is not carried in most other endpoints — worth deliberately preserving in the Catalysts ·
  earnings card, not just the raw date.**
- No fiscal-vs-calendar distinction is exposed at the calendar level beyond `year`/`quarter`
  (which are fiscal, as shown by the NVDA cross-check below — e.g. NVDA's Feb 2026 report is
  tagged `year: 2026, quarter: 4`, i.e. NVDA's fiscal Q4 FY26, not calendar Q4 2026).
- Does **not** return an "expected move" (own guide text says so explicitly) — would need pairing
  with options data if that's ever wanted.

---

## 3. Earnings results (`get_earnings_results`, NVDA)

Same per-event shape as the calendar, but scoped to one symbol, trailing 8 quarters +
next-upcoming. NVDA's `year`/`quarter` fields are confirmed **fiscal**, not calendar — e.g.
`{"year":2026,"quarter":4,"report":{"date":"2026-02-25"}}` is NVDA's fiscal Q4 FY26 (period
ending ~Jan 2026), reported in February — a full quarter and calendar-year off from a naive
calendar-Q4 reading. **Actual-vs-estimate is present** (`eps.estimate` vs `eps.actual`) for every
already-reported quarter; the most recent entry (`year 2027, quarter 3`) correctly shows
`actual: null` for the not-yet-reported quarter.

No separate "period covered" (start/end date) field beyond fiscal year+quarter — a card wanting a
calendar date range for the quarter would need to derive it from `report.date` and general
knowledge of NVDA's fiscal calendar, which the tool does not itself provide.

---

## 4. Fundamentals (`get_equity_fundamentals`, SPY)

Single flat object per symbol with `market_date` (a single as-of date for the whole row, e.g.
`"2026-09-11"`) plus a mix of daily-session fields (open/high/low/volume), valuation ratios
(`pe_ratio`, `pb_ratio`), 52-week range with its own dates, dividend schedule, and a short static
company-profile block (some fields empty string/null for an ETF like SPY: `ceo`, `headquarters_*`
are `""`, `num_employees` is `null`).

- **Period covered**: `market_date` is a single day, not a range — this endpoint is a point-in-
  time snapshot (today's session), not a periodic filing figure, so "period covered" in the
  filing sense doesn't apply here; it is clearly a daily quote-adjacent field, not at risk of
  being mistaken for a quarter/year figure.
- `financial_status_indicator` ("CB0") ships with an explicit instruction (in the guide, not
  wishful design) to **never surface the code alone** — always pair with
  `financial_status_description`, which was **empty string** in this SPY sample. That is itself
  a finding: the description that's supposed to explain the code was blank for this symbol, so a
  card built directly per the guide's instruction would show nothing where it means to show an
  explanation. Worth checking on a non-ETF symbol before assuming this is universal.

---

## 5. Financials (`get_financials`, NVDA)

Per-period fields: `fiscal_year, fiscal_quarter, period_end_date, revenue, gross_profit,
net_income, net_margin`. Confirmed against the SEC facts sample: NVDA's fiscal_year 2027 /
fiscal_quarter 2 / period_end_date `2026-07-26` / revenue `96221000000` matches exactly the
`Revenues` XBRL fact for the same period in the 10-Q sample below — **the two endpoints agree**.

- **Period covered**: present and unambiguous (`period_end_date`, plus `fiscal_year` +
  `fiscal_quarter`).
- **Fiscal vs calendar**: present and clearly labeled as fiscal (`fiscal_year`/`fiscal_quarter`
  field names) — NVDA's fiscal_year 2027 covers calendar dates in 2025–2026, so a card must say
  "FY27 Q2" or similar, never a bare "Q2 2026" (that would misstate the year AND could be read as
  calendar).
- **Filing date / form type**: **ABSENT from this endpoint.** `get_financials` gives you the
  reported number and the period it covers, but not which filing it came from or when that filing
  was filed — for provenance ("per the 10-Q filed 2026-08-26") a card must join this against
  `get_sec_filing_index` / `get_sec_filing_facts`, this endpoint alone cannot answer "which filing
  and when."
- **Amended/restated flag**: **ABSENT from this endpoint** — no such field exists here (see SEC
  facts section below for where this flag does live).

---

## 6. SEC filing index + facts + facts catalog (NVDA)

### Filing index (`get_sec_filing_index`)
Per-filing fields: `filing_id, form_type, description, date_filed`, plus pagination (`next`
cursor). Confirmed **form type and filing date are both present and correct at the index level**
— e.g. the 10-Q used for the facts sample: `form_type: "10-Q"`, `date_filed: "2026-08-26"`. The
index is dominated by Form 4 insider transactions (as expected for any actively-traded name); the
10-Q, 8-Ks, 13F-HR, 3, 424B5, DEF 14A, and ARS form types are all distinguishable by `form_type`.

### Facts catalog (`get_sec_filing_facts_facts_catalog`)
309 total tagged concepts in the sampled 10-Q. Critically, the catalog **includes SEC-standard
document/dei metadata concepts**, not just financial line items:
`DocumentFiscalPeriodFocus`, `DocumentFiscalYearFocus`, `DocumentPeriodEndDate`,
`DocumentQuarterlyReport`, `DocumentTransitionReport`, `DocumentType`, and — separately —
**`AmendmentFlag`**. Each concept's catalog entry also lists every reporting `period` (with
`start_date`/`end_date`) the concept is tagged for, and any `axis_names` (segment/geography/etc.
dimension breakdowns) it carries.

### Facts (`get_sec_filing_facts`)
Fetched `Revenues, NetIncomeLoss, EarningsPerShareBasic, EarningsPerShareDiluted, Assets,
AmendmentFlag` plus the four Document* concepts, for filing_id
`c2acc89a-db67-49c6-a6d7-803a2cba3e62`.

Each numeric fact carries, verbatim: `filing_id, concept, entity (CIK), period, axises, decimals,
value, char_value, unit, start_date, end_date`. Example (NVDA Q2 FY27 revenue):
```json
{"concept":"Revenues","period":"2026-04-27T00:00:00/2026-07-26T00:00:00",
 "start_date":"2026-04-27","end_date":"2026-07-26","value":"96221000000.00","unit":"iso4217:USD"}
```

Point-in-time facts (e.g. `Assets`) carry only `end_date` (correct — a balance-sheet figure is
"as of" one date, not a range).

Checking each of the four spec label questions against this filing:

- **Period the figure covers — PRESENT.** Every fact carries `start_date`/`end_date` (duration
  concepts) or `end_date` alone (instant concepts) directly on the fact row itself — no need to
  infer the period from context. This is the single strongest label result across all the
  endpoints captured today: a filed number here is never bare.
- **Filing date and form type — PRESENT, but only by joining two tools.** The fact object itself
  carries `filing_id`, not `date_filed`/`form_type` — those live on the **filing index** entry for
  that `filing_id` (`get_sec_filing_index`: `form_type: "10-Q"`, `date_filed: "2026-08-26"`), and
  separately as **filing-level XBRL facts in their own right**: `DocumentType` (`char_value:
  "10-Q"`) and `DocumentPeriodEndDate` (`char_value: "2026-07-26"`) are fetchable through the same
  `get_sec_filing_facts` call. So "per the 10-Q filed 2026-08-26" is fully citable, but a card/tool
  must carry the `filing_id` → index lookup (or fetch `DocumentType`/`DocumentFiscalYearFocus`
  facts) — it does not arrive pre-joined onto every numeric fact.
- **Amended/restated flags — PRESENT.** `AmendmentFlag` is a real, fetchable concept; in this
  filing it is `char_value: "false"` — i.e. this 10-Q is confirmed **not** an amendment. The
  concept exists in the catalog for every filing in this form family, so a card/tool can check it
  before citing a figure and flag amended filings when the value is `"true"`.
- **Fiscal vs calendar period, where distinguished — PRESENT.** `DocumentFiscalYearFocus` =
  `"2027"` and `DocumentFiscalPeriodFocus` = `"Q2"` for a filing whose actual calendar dates are
  `2026-01-26`–`2026-07-26` — i.e. **NVDA's fiscal year is offset from the calendar year by
  roughly one year**, confirmed directly from the filing's own dei tags, not inferred. A number
  from this filing must be labeled "Q2 FY27" (matching what the filer itself calls it) — labeling
  it "Q2 2026" would be both a fiscal/calendar conflation and a plain year error.

**Net phase-0 result for filed facts: all four required labels (period, filing date+form type,
amended flag, fiscal-vs-calendar) are obtainable from this feed.** None are absent. The only
build note is that filing date/form type require joining the fact's `filing_id` against
`get_sec_filing_index` (or pulling the `DocumentType`/`DocumentPeriodEndDate` facts in the same
`get_sec_filing_facts` call) rather than being inline on every numeric fact row — cheap to do,
but the card/tool-building code must actually do it, not assume the join is free.

Also worth flagging for the consumer-side design (not a phase-0 gap, just an observation from the
sample): the same `Revenues` concept appears **many times per period** once segment/geography
breakdowns are pulled in (`ConsolidationItemsAxis`, `StatementGeographicalAxis`,
`ProductOrServiceAxis` all tag `Revenues` separately) — a naive "get me revenue" fetch without
also filtering on `axises: []` (the unqualified consolidated total) risks picking up a segment
slice instead of the total. The unqualified total is identifiable as the row with an empty
`axises` array.

---

## Summary table

| Label | News | Earnings cal/results | Fundamentals | Financials | SEC filing facts |
|---|---|---|---|---|---|
| Source name | ✅ `publisher` | n/a | n/a | n/a | n/a |
| Publish timestamp | ✅ `published_at` (full ISO+tz) | n/a | n/a | n/a | n/a |
| Item type (wire/PR/opinion) | ❌ absent (`source_type` = vendor, not genre) | n/a | n/a | n/a | n/a |
| Headline vs body | ✅ `title` / `preview_text` / `content` (3 distinct levels) | n/a | n/a | n/a | n/a |
| Period covered | n/a | ✅ fiscal year+quarter | n/a (point-in-time) | ✅ `period_end_date` | ✅ `start_date`/`end_date` on every fact |
| Filing date + form type | n/a | n/a | n/a | ❌ absent from this endpoint | ✅ via `filing_id` → index join, or `DocumentType`/`DocumentPeriodEndDate` facts |
| Amended/restated flag | n/a | n/a | n/a | ❌ absent | ✅ `AmendmentFlag` |
| Fiscal vs calendar | n/a | ✅ (fiscal, confirmed via NVDA offset) | n/a | ✅ (fiscal, field-named) | ✅ `DocumentFiscalYearFocus`/`DocumentFiscalPeriodFocus` |

**The one clear phase-0 gap requiring a fail-closed design decision per the spec: news item-type
(wire vs PR vs opinion) is absent.** Per the two-mouths rule and the card's labeling-is-the-floor
principle, both the eventual Wire card and Dr. NoVo's tool should treat every article as
undifferentiated third-party copy (no wire/PR/opinion confidence split) rather than inventing a
classification the feed does not support — e.g. by defaulting to the "opinion/least-reliable"
handling for all items, not attempting a heuristic genre guess from title text as ground truth.

Everything else asked for in the spec's label checklist was found present, though filing
date/form type require an explicit join rather than arriving inline on each numeric fact — noted
above so the tool-building pass doesn't assume it's free.
