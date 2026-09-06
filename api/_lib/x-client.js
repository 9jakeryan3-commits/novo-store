/* THE one X client. Every surface that wants X data comes through here.

   WHY IT EXISTS AS A FILE. The fetch used to live inside the analyst's `search_x` tool, which is a
   CHAT tool — NoVo calls it mid-answer. Nothing else can. The dealer-map dashboard polls an endpoint
   and renders a payload; the engine writes reports in Python. Both need X, neither can call a tool,
   and the obvious shortcut is a second fetcher. Two fetchers means two query constructions, two
   baselines and two homes for the guardrail below — and they drift. That exact failure bit this repo
   three times in one day (two search indexes, two graders, two scorers), so the client is extracted
   before the third surface asks rather than after.

   ── THE BUG THIS FILE WAS BORN FIXING ────────────────────────────────────────────────────────
   The old volume figure was `(response.data || []).length` from recent-search with max_results=25.
   That is THE PAGE SIZE, not a measurement. For any liquid ticker it is 25 every hour, forever. The
   percentile then compared 25 against a stored history of 25s — `h.n < count` is never true — so
   `percentile_of_own_history` reported 0.0 permanently. A number that looked like a measurement,
   updated on schedule, and carried no information. Absent would have been more honest.

   Measured on the live API before replacing it (5 symbols, cap raised to 100): SPY 100, QQQ 100,
   IWM 98, TSLA 100, NVDA 100 — every one pinned to the page size.

   ── WHAT REPLACES IT ─────────────────────────────────────────────────────────────────────────
   /2/tweets/counts/recent returns TRUE volume, uncapped, in hourly buckets, on this tier. Verified
   live: SPY 16,503 posts over 7d against IWM's 1,577; TSLA's busiest hour 1,277 against IWM's 45.
   That discriminates. And it returns ~169 hourly buckets IN ONE CALL, so the baseline arrives WITH
   the data — the percentile is correct on the first call, on any ticker, with no 24-hour warm-up
   and no per-symbol history to accrue, keep or lose.

   ── THE GUARDRAIL TRAVELS WITH THE DATA ──────────────────────────────────────────────────────
   A percentile of mention VOLUME is a measurement: it has a denominator and you can check it. A
   "sentiment score" is a number nobody can check, and inventing one is the fabrication class our
   record guards exist to stop. This client returns counts and posts. It does not score mood, and no
   caller may add one. */

const RECENT = "https://api.x.com/2/tweets/search/recent";
const COUNTS = "https://api.x.com/2/tweets/counts/recent";

/* ── THE SOURCE ALLOWLIST, AND WHY IT IS KEYED ON author_id ──────────────────────────────────────
   Curated and verified live by Einstein, 2026-09-06: 39 accounts in six tiers. The one engineering
   requirement, and it is not hygiene — it is live, on the single account we would most want to
   quote:

     @DeItaone          1,918,688  blue   "*Walter Bloomberg"   <- THE REAL ONE (capital I)
     @deltaone              2,056  none   "deltaone"            <- homoglyph twin (lowercase l)
     @WalterBloomberg      11,494  none   "Walter Bloomberg"    <- display-NAME twin
     @business_ft               2  none   "FT Business"         <- brand-in-handle twin

   Three spoof vectors on one target. A STRING-matched allowlist hands an impersonator NoVo's voice
   on a paid surface, and the homoglyph is invisible in code review because @DeItaone and @deltaone
   render nearly identically in most fonts. author_id is assigned by X and cannot be re-registered,
   so matching is on id and the handle is a LABEL ONLY.

   ⚠ AND THE LABEL WE RENDER IS OURS, NOT THE RESPONSE'S. Posts are attributed from our own vetted
   record for the matched id, never from the payload's username/name fields. Otherwise a display
   name is still an attack surface even after the id check passes.

   Einstein's own verification killed three handles he was confident about — @BLSgov does not exist
   (it is @BLS_gov), @gregip is a 39-follower account that is not Greg Ip, @arkhamintel has 0
   followers against the real @arkham's 1.5M. A fabricated-handle rate of 3 in 52 from a list
   someone knew. Nothing goes in this file that was not checked against the live API.

   HONEST LIMIT, because it decides whether this is the right trade: an allowlist CANNOT see a
   genuine catalyst from an unlisted account — a CEO outside the company tier, a regional Fed
   president, a first-hand witness. It trades recall for precision. On a paid surface a fabricated
   catalyst is worse than a missed one, so that is the right direction — but revisit it by
   MEASURING what it misses, never by loosening it on a hunch. */
const SOURCES = require("./x-sources.json");

/* ── AND THE TOPIC HAS TO BE WRITTEN THE WAY A WIRE WRITES IT ────────────────────────────────────
   The first version of the allowlist path built `($SPY) (from:Reuters OR ...)`. My own stated
   reason for adding the from: clause was "Reuters does not write $SPY" — and then the query I
   shipped ANDed the cashtag anyway, so the objection survived into the fix for it. Einstein
   measured the result live rather than arguing it:

     sym    cashtag only (shipped)      with a topic clause
     SPY     0 posts /  0 sources        8 posts / 2 sources
     QQQ     0 posts /  0 sources       25 posts / 3 sources
     IWM     0 posts /  0 sources        1 post  / 1 source
     TSLA    2 posts /  1 source        25 posts / 6 sources
     NVDA    4 posts /  1 source        25 posts / 7 sources

   TICKERS is ["SPY","QQQ","IWM"], so the catalyst path was DEAD ON 100% OF THE COVERED UNIVERSE,
   and dead silently: sources_queried 23, dropped_unlisted 0, posts []. That renders as "we asked
   twenty-three vetted wires and they had nothing to say" — the exact confident claim the chunking
   comment above exists to prevent. The bound I guarded against simply arrived through a different
   clause.

   The subtler half is the single names, which did return something: 39 vetted sources collapsed
   onto @DeItaone alone, because Walter Bloomberg is one of the very few wire accounts that
   prefixes cashtags. An allowlist that always answers with one account is not the diversity it
   was built for.

   So the topic is expressed as a wire would write it, with the cashtag kept as an OR term so
   trader-style posts still match. Costs ~40 characters against the 512 cap.

   ⚠ VOLUME MUST NOT USE THIS. counts/recent measures TRADER attention, and swapping $SPY for
   "S&P 500" would measure a different population — a different denominator wearing the same
   label. This map governs the QUOTE path only. (mentionVolume does not read it.)

   ⚠ AND A KEYWORD CLAUSE MATCHES THE COMPANY, NOT THE STOCK. From the probe: a WSJ piece on
   "SpaceX and Tesla directors backing academic research" — a real post from a vetted wire, and
   not a market catalyst. A returned post is therefore a CANDIDATE catalyst. NoVo may report that
   a vetted wire published something; it may never assert that it caused a move. */
const TOPICS = require("./x-topics.json");

/* Priority decides who survives the query-length budget below. Official first because it is the
   only tier where the account IS the fact rather than a report of it; crypto last because
   Xavier's identity rule already forbids it from naming an asset. */
const TIER_PRIORITY = ["official", "wire", "macro_reporter", "major", "company", "crypto"];

/* X's recent-search query cap is 512 characters on this tier. The topic, the operators and the
   parentheses all live in the same budget, so the from: clause gets less than the whole of it. */
const QUERY_BUDGET = 400;

/* How many chunked requests one allowlisted lookup may cost. Three covers the full 39-source list
   with headroom; the rate budget is real (Xavier), so this is a bound rather than a loop. */
const MAX_CALLS = 3;

let _index = null;
function sourceIndex() {
  if (_index) return _index;
  _index = new Map();
  for (const tier of Object.keys(SOURCES.tiers || {})) {
    for (const s of SOURCES.tiers[tier].sources || []) {
      _index.set(String(s.id), {
        id: String(s.id), handle: s.handle, name: s.name, tier: tier,
        ticker: s.ticker || null, followers: s.followers,
      });
    }
  }
  return _index;
}

/* Below this median hourly count the series is too coarse to rank — see mentionVolume for the
   measured resolution table and why the floor is on the MEDIAN rather than the weekly total. */
const MEDIAN_FLOOR = 10;

/* The old absolute floor was `total < 500` over a 168-hour window. Once an hour is ranked against a
   POOL rather than the whole window (see WEEKEND vs WEEKDAY below) that constant silently changes
   meaning: 500 across 48 weekend hours is a three-times stricter test than 500 across 168. So the
   floor is expressed per hour — 500/168 — and multiplied back up by whatever pool is actually the
   denominator. Same test, stated in units that survive a change of window. */
const MIN_TOTAL_PER_HOUR = 500 / 168;

/* A pool below this is too short to percentile at all, whatever its median: 24 buckets can only
   resolve the rank in ~4-point steps. A full weekend is 48, so this bites only on a truncated
   window, which is exactly when it should. */
const MIN_POOL_N = 24;

/* WEEKEND HOURS ARE A DIFFERENT POPULATION, and ranking one against the other is the partial-bucket
   defect wearing a calendar instead of a clock — like against unlike. Einstein measured it over 168
   complete hours (median weekday/weekend, ET):

     SPY   77 / 41      TSLA  100 / 72      NVDA  95 / 83

   TSLA and NVDA barely care. SPY does, and SPY is what the Sunday Week Ahead is mostly about: at
   roughly half the weekday median, SPY's BUSIEST weekend hour of the week ranks at the 69.0th
   percentile against the mixed pool. There is no level of genuine Sunday activity that can rank
   above 69 — the scale is capped and does not say so, so the Week Ahead would report "quiet" or
   "middling" every single Sunday regardless of what actually happened.

   ⚠ AND IT IS NOT ONLY A WEEKEND PROBLEM, which is the half worth stating because it runs five days
   a week: the same mixing INFLATES weekday hours. Those 48 quiet weekend buckets sit at the bottom
   of the mixed pool, so an ordinary SPY weekday hour is ranked partly against hours it was never
   competing with. The cap is the visible symptom; the inflation is the common case.

   So each hour is ranked against hours OF ITS OWN KIND, the pool is named in the payload, and the
   gate below is computed on THAT POOL rather than the whole window — a gate describing a different
   denominator from the percentile it guards is the same class of mislabel all over again.

   ET, not UTC: "weekend" here means the market's weekend, and a Friday 20:00 ET bucket is 00:00Z
   Saturday. Bucketing on UTC would file six weekday evening hours a week as weekend. */
function isWeekendET(iso) {
  try {
    const wd = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short",
    }).format(new Date(iso));
    return wd === "Sat" || wd === "Sun";
  } catch (_) {
    return null;            // unknown -> caller falls back to the undivided window, never guesses
  }
}

/* -is:reply as well as -is:retweet: the first live probe came back led by a zero-engagement reply
   argument with profanity in it. A "catalyst" that is two strangers bickering is worse than no
   catalyst on a paid surface, and raw recent-search is mostly that. Kept verbatim from the original
   tool so the VOLUME and the POSTS are counted over the same population — a count filtered
   differently from the posts it accompanies is two measurements wearing one label. */
function buildQuery(symbol, free) {
  return (symbol ? `$${String(symbol).toUpperCase()}` : String(free || "")) +
         " -is:retweet -is:reply lang:en";
}

function token() {
  return (process.env.X_BEARER_TOKEN || "").trim();
}

async function call(url) {
  const tok = token();
  if (!tok) return { ok: false, status: 0, error: "X_BEARER_TOKEN not set" };
  let resp;
  try {
    resp = await fetch(url, {
      headers: { Authorization: "Bearer " + tok, "User-Agent": "NoVo/1.0" },
    });
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
  if (!resp.ok) {
    // 429 and 402 are DIFFERENT facts and the caller needs to tell them apart: rate-limited now, or
    // this tier cannot do it at all. Collapsing both into "unavailable" is how a quota problem gets
    // misdiagnosed as a missing feature for a week.
    return { ok: false, status: resp.status,
             error: resp.status === 429 ? "rate limited" :
                    resp.status === 402 ? "not available on this API tier" :
                    "http " + resp.status };
  }
  try {
    return { ok: true, status: 200, json: await resp.json() };
  } catch (e) {
    return { ok: false, status: 200, error: "unparseable response" };
  }
}

/* Mention VOLUME and its own baseline, from one call.

   Returns null on failure rather than a zero. A zero here would be indistinguishable from a genuinely
   quiet hour, and the whole point of this rewrite is that a number which cannot tell those apart is
   worse than no number. */
async function mentionVolume(symbol, free) {
  const url = COUNTS + "?query=" + encodeURIComponent(buildQuery(symbol, free)) + "&granularity=hour";
  const r = await call(url);
  if (!r.ok) return { error: r.error, status: r.status };
  const rows = (r.json && r.json.data) || [];
  if (rows.length < 2) return { error: "not enough buckets to rank", status: 200 };

  /* ⚠ THE LAST BUCKET IS THE HOUR IN PROGRESS, and X ends it at request time. Measured live: a
     43-MINUTE window arriving alongside 168 sixty-minute ones. Ranking it against them is not a
     rounding error, it INVERTS on exactly the names that matter — the partial-hour shortfall is a
     bigger fraction of a busy ticker's baseline, so TSLA (23.5k posts/week, the busiest name we
     cover) ranked at the 0.6th percentile while IWM (1,577) ranked higher. NoVo would have told a
     subscriber that the loudest name on the board was having its quietest hour of the week.

     The tell was in my own first output and I explained it away: SPY and IWM landed on an IDENTICAL
     3.6%. Two tickers a factor of ten apart in volume cannot honestly share a rank, and a collision
     like that is a thing to investigate, not to rationalise. Caught by Einstein, one layer below the
     page-size defect this file was written to fix — the count got corrected and the denominator's
     WINDOW did not. Same class, one layer down.

     So: rank the last COMPLETE hour against the prior complete hours. The in-progress hour is
     returned separately, with its elapsed minutes, and is NEVER ranked. */
  const mins = (b) => {
    try {
      return (new Date(b.end) - new Date(b.start)) / 60000;
    } catch (_) { return null; }
  };
  const counts = rows.map((x) => Number(x.tweet_count) || 0);
  const completeRows = rows.slice(0, -1);            // every bucket but the one still filling
  const complete = counts.slice(0, -1);
  const lastComplete = complete[complete.length - 1];
  const sorted = complete.slice().sort((a, b) => a - b);
  const partialMins = mins(rows[rows.length - 1]);

  /* THE RANKING POOL: hours of the same kind as the hour being ranked. If the calendar cannot be
     resolved for any bucket, or the like-pool is too short to be worth splitting, fall back to the
     whole window and SAY SO in the payload — a silent fallback would leave a caller unable to tell
     a like-for-like rank from a mixed one, which is the ambiguity this whole change exists to remove. */
  const kinds = completeRows.map((b) => isWeekendET(b && b.start));
  const lastKind = kinds[kinds.length - 1];
  let pool = complete;
  let poolName = "all complete hours";
  if (lastKind !== null && !kinds.some((k) => k === null)) {
    const like = complete.filter((_n, i) => kinds[i] === lastKind);
    if (like.length >= MIN_POOL_N) {
      pool = like;
      poolName = lastKind ? "weekend hours only (ET)" : "weekday hours only (ET)";
    } else {
      poolName = "all complete hours - too few " +
                 (lastKind ? "weekend" : "weekday") + " hours (" + like.length + ") to rank like-for-like";
    }
  } else if (lastKind === null) {
    poolName = "all complete hours - bucket timestamps unreadable, could not split weekday/weekend";
  }

  const below = pool.filter((n) => n < lastComplete).length;
  const poolSorted = pool.slice().sort((a, b) => a - b);
  const median = poolSorted[Math.floor(poolSorted.length / 2)];
  const poolTotal = pool.reduce((a, b) => a + b, 0);

  /* ⚠ A PERCENTILE IS ONLY AS GOOD AS THE SERIES' RESOLUTION, and volume is the wrong thing to
     check. The right question is how many DISTINCT values the series has, because tied hours rank
     arbitrarily among themselves. Measured across 168 complete buckets:

       tkr    7d total  median/hr  distinct  ONE extra post moves the rank by
       SPY      16,501     57        109              1.8 pts
       QQQ       9,702     36         96              2.4 pts
       TSLA     23,555     85        116              1.2 pts
       NVDA     23,130     94.5      121              1.2 pts
       IWM       1,577      6         33              7.1 pts   <- and 3.6% of hours are literal zero

     IWM resolves to 33 values across a week and a SINGLE POST swings its rank seven points. That is
     not a measurement, it is a coin flip with decimals.

     The floor is on the MEDIAN, not the weekly total: a total hides shape, and one viral 900-post
     hour among 167 dead ones would pass a total test while ranking nothing. Ten sits above the
     coarse case and far below every name that works. Of the five, IWM alone suppresses — which is
     what the resolution column says rather than what anyone's intuition said first.

     SUPPRESSED MEANS A STATED REASON, NEVER SILENCE. A missing field reads as merely absent and the
     next consumer backfills it from somewhere else. And it does NOT fall back to the weekly total:
     a total with no baseline is a number under an unstated denominator, which is the thing we just
     decided not to trust. Found by Tony, endorsed by Einstein, verified here. */
  /* Both of these are computed on the POOL, not the window, because the pool is the denominator the
     percentile actually uses. A gate that clears on the full week while the rank is taken against 48
     weekend hours is a check measuring something other than the thing it guards. `total` below stays
     window-wide because it is DESCRIPTION, not a gate — the whole distribution ships either way. */
  const zeroShare = pool.filter((n) => n === 0).length / pool.length;
  const total = (r.json.meta && r.json.meta.total_tweet_count) != null
    ? r.json.meta.total_tweet_count
    : counts.reduce((a, b) => a + b, 0);
  const totalFloor = Math.round(MIN_TOTAL_PER_HOUR * pool.length);

  /* ⚠ GATE THE RANKING, NEVER THE RAW COUNT. A percentile on a coarse series is meaningless, but a
     COUNT of zero on a coarse series is often the entire finding — NoVo's own brand returns 0
     mentions across 169 consecutive hours while the category it sells into runs ~883/week, which is
     the first hard demand-side evidence the company has. A floor that suppressed thin series
     wholesale would have hidden exactly that: a saturating counter turned upside down, blind at the
     BOTTOM instead of the top. So refuse to NARRATE, never refuse to COUNT — the whole distribution
     ships either way, because the shape IS the denominator. (Pete's catch.)

     ⚠ AND THE GATE READS THE HISTORY'S MEDIAN, NEVER THE CURRENT BUCKET. Gating on the current
     count would delete the low readings and keep the busy ones — censoring the exact tail the
     percentile exists to detect. Stated here so nobody "optimises" it into the current hour later.
     (Timmy's catch.) */
  let unrankable = null;
  if (pool.length < MIN_POOL_N) {
    unrankable = "only " + pool.length + " comparable hours (" + poolName + ") - too short to " +
                 "percentile at all";
  } else if (median < MEDIAN_FLOOR) {
    unrankable = "median " + median + " posts/hr over " + pool.length + " " + poolName + " - at " +
                 "this resolution a single post moves the rank several points";
  } else if (zeroShare >= 0.05) {
    unrankable = Math.round(zeroShare * 1000) / 10 + "% of the " + poolName + " are literally zero, " +
                 "so a percentile would rank 'nobody posted, and that is normal here' as a quiet extreme";
  } else if (poolTotal < totalFloor) {
    unrankable = "only " + poolTotal + " posts across the " + pool.length + " comparable hours " +
                 "(" + poolName + "), under the " + totalFloor + " this window size needs";
  }

  const dist = {
    window: "last 7 days, hourly buckets (X counts/recent)",
    last_complete_hour: lastComplete,
    busiest_hour: sorted[sorted.length - 1],
    median_hour: median,
    zero_hour_share_pct: Math.round(zeroShare * 1000) / 10,
    total: total,
    observations: complete.length,
    // WHICH HOURS THE RANK IS AGAINST. Named rather than implied: "62nd percentile" means two
    // different things depending on the pool, and a consumer that cannot see the denominator will
    // eventually compare a weekend reading to a weekday one as though they shared a scale.
    ranked_against: {
      pool: poolName,
      n: pool.length,
      median_hour: median,
      hour_kind: lastKind === null ? "unknown" : (lastKind ? "weekend" : "weekday"),
    },
    // Reported, never ranked. Its own field name says it is partial and carries how partial, so a
    // reader can see what the ranked figure left out rather than being handed a quiet truncation.
    in_progress_hour: {
      count: counts[counts.length - 1],
      elapsed_minutes: partialMins === null ? null : Math.round(partialMins * 10) / 10,
      note: "the hour still filling - NOT comparable to the ranked figure, never quote as a percentile",
    },
  };

  if (unrankable) {
    // rankable:false with a REASON. Never silence — a missing field reads as merely absent and the
    // next consumer backfills it from somewhere else. And "too thin to rank" and "unusually quiet"
    // are OPPOSITE claims that must not collapse into the same rendering downstream.
    return Object.assign(dist, {
      rankable: false,
      percentile_of_own_history: null,
      unrankable_because: unrankable,
    });
  }

  return Object.assign(dist, {
    rankable: true,
    // The headline measurement, over a COMPLETE hour so the comparison is like-for-like. The
    // denominator rides with it: a rate without its n is the thing the track-record page exists to
    // refuse, and that rule does not stop at the page.
    percentile_of_own_history: Math.round((below / pool.length) * 1000) / 10,
    note: "percentile of the LAST COMPLETE hour against " + poolName + ", n=" + pool.length +
          " buckets - a measurement of ATTENTION, never a direction, and never a position",
  });
}

/* Which vetted sources are eligible for THIS request, in priority order.

   The company tier's rule ("Apple is a source on AAPL and is not a source on the market";
   elonmusk is a TSLA source and nothing else) is enforced here rather than left to the caller —
   a rule stated in prose beside a general-purpose list is a rule that gets forgotten by the
   third consumer. */
function eligibleSources(symbol, tiers) {
  const want = tiers && tiers.length ? tiers.slice() : TIER_PRIORITY.slice();
  const T = String(symbol || "").toUpperCase();
  const out = [];
  for (const tier of TIER_PRIORITY) {
    if (want.indexOf(tier) === -1) continue;
    for (const s of (SOURCES.tiers[tier] || {}).sources || []) {
      if (tier === "company" && (!T || String(s.ticker || "").toUpperCase() !== T)) continue;
      out.push(Object.assign({ tier: tier }, s));
    }
  }
  return out;
}

/* The posts themselves, ranked by amplification rather than recency — an unranked recent-search is
   mostly noise, and the top of it is what a reader would actually call a catalyst.

   opts.allowlistOnly restricts the result to the vetted sources above. TWO LAYERS, DELIBERATELY:

     · the QUERY carries `from:` clauses, which is what makes the call return anything useful at
       all. Post-filtering a generic `$SPY` search against 39 accounts returns [] almost every
       time — Reuters does not write "$SPY" — so a filter-only implementation would look like a
       quiet market instead of a query that cannot work.
     · the RESULT is filtered on author_id anyway. `from:` matches HANDLES, so it is exactly the
       layer the homoglyph defeats; the id check is what actually holds. Belt and braces, and the
       braces are the ones load-bearing.

   Non-allowlisted posts are DROPPED, never down-weighted: the point is that NoVo never quotes an
   account nobody vetted, and a down-weighted impersonator is still a quotable impersonator. */
async function recentPosts(symbol, free, limit = 10, opts) {
  const o = opts || {};
  const T = String(symbol || "").toUpperCase();
  const mapped = symbol ? (TOPICS.topics || {})[T] : null;
  // cashtag_only is a WEAK query against wire accounts, so it is reported rather than assumed
  // equivalent — absence under it is not evidence the wires were silent.
  const topicHow = !symbol ? "free_text" : (mapped ? "topic_clause" : "cashtag_only");
  const topic = symbol ? (mapped ? mapped.clause : `$${T}`) : String(free || "");
  let queries = [buildQuery(symbol, free)];
  let allow = null;
  let omitted = [];
  // Sources that did not FIT the budget and sources whose request FAILED are different facts.
  // Folding them into one list would make "we ran out of room" and "the wire call errored"
  // indistinguishable downstream - the same conflation the empty-result reasons exist to undo.
  let failedGroups = [];

  if (o.allowlistOnly) {
    const elig = eligibleSources(symbol, o.tiers);
    if (!elig.length) {
      return { posts: [], allowlist: { mode: "allowlist_only", sources_queried: 0,
        note: "no vetted source is admissible for this request - the company tier is restricted " +
              "to an account's own ticker, so an unlisted symbol has no eligible source" } };
    }
    /* ⚠ THE WHOLE LIST DOES NOT FIT IN ONE QUERY, AND TRUNCATING IT IS NOT ACCEPTABLE. Measured:
       31 eligible sources need ~620 characters of from: clauses against a 512-character cap, so a
       single call reaches 23 of them. Eight vetted wires going unasked reads downstream as "the
       wires had nothing to say" — a completely different and far more confident claim than "we
       did not ask them", and it is the failure mode that would make a real catalyst look like a
       quiet tape.

       So the sources are CHUNKED across up to MAX_CALLS requests in priority order and the
       results merged, rather than the tail being dropped. Most callers ask for one or two tiers
       and never leave a single call; only an all-tiers request pays for more. Anything past the
       cap is still named in sources_omitted, because a bound that is never reported is the same
       silent truncation wearing a limit. */
    const chunks = [];
    let cur = [], curLen = 0;
    for (const s of elig) {
      const cost = ("from:" + s.handle).length + (cur.length ? 4 : 0);
      if (curLen + cost > QUERY_BUDGET && cur.length) { chunks.push(cur); cur = []; curLen = 0; }
      cur.push(s); curLen += ("from:" + s.handle).length + (cur.length > 1 ? 4 : 0);
    }
    if (cur.length) chunks.push(cur);
    for (const c of chunks.slice(MAX_CALLS)) for (const s of c) omitted.push(s.handle);
    const run = chunks.slice(0, MAX_CALLS);
    const used = [].concat.apply([], run);
    allow = { used: used, ids: new Set(used.map((s) => String(s.id))), calls: run.length };
    queries = run.map((c) => (topic ? "(" + topic + ") " : "") +
      "(" + c.map((s) => "from:" + s.handle).join(" OR ") + ") -is:retweet lang:en");
  }

  const raw = [];
  const users = {};
  const seen = new Set();
  for (const q of queries) {
    const url = RECENT + "?query=" + encodeURIComponent(q) +
      "&max_results=25&tweet.fields=created_at,public_metrics" +
      "&expansions=author_id&user.fields=username,public_metrics";
    const r = await call(url);
    // One failed chunk must not discard the chunks that worked, but it must not be invisible
    // either — a partial answer presented as a whole one is the same lie as a truncated list.
    if (!r.ok) {
      if (!raw.length && queries.length === 1) return { error: r.error, status: r.status };
      failedGroups.push(r.error);
      continue;
    }
    const j = r.json || {};
    for (const u of (j.includes && j.includes.users) || []) users[u.id] = u;
    for (const t of (j.data) || []) {
      if (t.id && seen.has(t.id)) continue;      // chunks are disjoint by author, but be certain
      if (t.id) seen.add(t.id);
      raw.push(t);
    }
  }
  let dropped = 0;
  const all = [];
  for (const t of raw) {
    const m = t.public_metrics || {};
    const aid = String(t.author_id || "");
    let author, followers, tier = null;
    if (allow) {
      if (!allow.ids.has(aid)) { dropped++; continue; }
      // Attributed from OUR vetted record, never from the response's own username/name.
      const vetted = sourceIndex().get(aid);
      author = "@" + vetted.handle;
      followers = vetted.followers;
      tier = vetted.tier;
    } else {
      const u = users[aid] || {};
      author = u.username ? "@" + u.username : "unknown";
      followers = (u.public_metrics && u.public_metrics.followers_count) || 0;
    }
    all.push({ author, followers, tier, at: t.created_at, text: t.text,
               likes: m.like_count || 0, reposts: m.retweet_count || 0 });
  }

  const score = (p) => (p.likes || 0) + 3 * (p.reposts || 0) + Math.log10(1 + (p.followers || 0));
  const posts = all.slice().sort((a, b) => score(b) - score(a)).slice(0, limit);
  if (!allow) return { posts: posts };
  return {
    posts: posts,
    allowlist: {
      mode: "allowlist_only",
      tiers_used: Array.from(new Set(allow.used.map((s) => s.tier))),
      sources_queried: allow.used.length,
      calls_made: allow.calls,
      sources_omitted: omitted,          // did not fit the query budget - NOT "had nothing to say"
      source_groups_failed: failedGroups,
      returned_before_filter: raw.length,
      dropped_unlisted: dropped,         // matched the from: clause, failed the id check
      topic_expressed_as: topicHow,
      /* ⚠ AN EMPTY RESULT MEANT THREE DIFFERENT THINGS AND ONLY ONE WAS VISIBLE (Einstein). "We
         asked and they were silent", "we asked in a language they do not speak", and "a source
         group failed" are three different claims, and NoVo will narrate the difference away if
         the payload does not carry it. Only the strongest of the three is a finding. */
      no_posts_reason: posts.length ? null
        : (failedGroups.length ? "source_group_failed"
          : topicHow === "cashtag_only" ? "weak_topic_query"
          : "sources_silent"),
      note: "matched on author_id; handles are labels only. Posts are WIRE COPY - attribute to " +
            "the account, never convert a post into a number, and let market data override " +
            "without comment. A returned post is a CANDIDATE catalyst: a keyword clause matches " +
            "the COMPANY, not the stock, so never assert that it caused a move.",
    },
  };
}

module.exports = { buildQuery, mentionVolume, recentPosts, hasToken: () => !!token() };
