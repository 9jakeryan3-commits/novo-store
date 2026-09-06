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

/* Below this median hourly count the series is too coarse to rank — see mentionVolume for the
   measured resolution table and why the floor is on the MEDIAN rather than the weekly total. */
const MEDIAN_FLOOR = 10;

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
  const complete = counts.slice(0, -1);              // every bucket but the one still filling
  const lastComplete = complete[complete.length - 1];
  const below = complete.filter((n) => n < lastComplete).length;
  const sorted = complete.slice().sort((a, b) => a - b);
  const partialMins = mins(rows[rows.length - 1]);
  const median = sorted[Math.floor(sorted.length / 2)];

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
  const zeroShare = complete.filter((n) => n === 0).length / complete.length;
  const total = (r.json.meta && r.json.meta.total_tweet_count) != null
    ? r.json.meta.total_tweet_count
    : counts.reduce((a, b) => a + b, 0);

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
  if (median < MEDIAN_FLOOR) {
    unrankable = "median " + median + " posts/hr over " + complete.length + " complete hours - at " +
                 "this resolution a single post moves the rank several points";
  } else if (zeroShare >= 0.05) {
    unrankable = Math.round(zeroShare * 1000) / 10 + "% of hours are literally zero, so a " +
                 "percentile would rank 'nobody posted, and that is normal here' as a quiet extreme";
  } else if (total < 500) {
    unrankable = "only " + total + " posts across the whole window";
  }

  const dist = {
    window: "last 7 days, hourly buckets (X counts/recent)",
    last_complete_hour: lastComplete,
    busiest_hour: sorted[sorted.length - 1],
    median_hour: median,
    zero_hour_share_pct: Math.round(zeroShare * 1000) / 10,
    total: total,
    observations: complete.length,
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
    percentile_of_own_history: Math.round((below / complete.length) * 1000) / 10,
    note: "percentile of the LAST COMPLETE hour against this ticker's own prior complete hours, " +
          "n=" + complete.length + " buckets - a measurement of ATTENTION, never a direction",
  });
}

/* The posts themselves, ranked by amplification rather than recency — an unranked recent-search is
   mostly noise, and the top of it is what a reader would actually call a catalyst. */
async function recentPosts(symbol, free, limit = 10) {
  const url = RECENT + "?query=" + encodeURIComponent(buildQuery(symbol, free)) +
    "&max_results=25&tweet.fields=created_at,public_metrics" +
    "&expansions=author_id&user.fields=username,public_metrics";
  const r = await call(url);
  if (!r.ok) return { error: r.error, status: r.status };
  const j = r.json || {};
  const users = {};
  for (const u of (j.includes && j.includes.users) || []) users[u.id] = u;
  const all = ((j.data) || []).map((t) => {
    const u = users[t.author_id] || {};
    const m = t.public_metrics || {};
    return {
      author: u.username ? "@" + u.username : "unknown",
      followers: (u.public_metrics && u.public_metrics.followers_count) || 0,
      at: t.created_at,
      text: t.text,
      likes: m.like_count || 0,
      reposts: m.retweet_count || 0,
    };
  });
  const score = (p) => (p.likes || 0) + 3 * (p.reposts || 0) + Math.log10(1 + (p.followers || 0));
  return { posts: all.slice().sort((a, b) => score(b) - score(a)).slice(0, limit) };
}

module.exports = { buildQuery, mentionVolume, recentPosts, hasToken: () => !!token() };
