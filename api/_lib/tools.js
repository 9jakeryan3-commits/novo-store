// api/_lib/tools.js — the read-only lookups NoVo's analyst can call for itself.
//
// Function calling does not change the invariant analyst-ask.js already runs on: the model never
// executes anything and never computes a number. It chooses which of a fixed, server-owned set of
// READ-ONLY lookups it needs, and this file runs them. Nothing here writes, nothing here touches
// trades.db, and nothing here can reach an account — the market/account line is enforced by what
// is absent from this list, not by asking the model nicely.
//
// Every executor is called in-process by analyst-ask.js. None of them self-fetch a sibling /api
// route: a three-round tool loop would otherwise add six TLS handshakes and six cold starts before
// the model even begins writing.
//
// Every result carries its own freshness. A tool that cannot answer returns { error } rather than
// nothing, so the model can say "I don't have that" instead of filling the gap from memory.

const { kv } = require("../_kv.js");

const TICKERS = ["SPY", "QQQ", "IWM"];
const okTicker = (t) => TICKERS.includes(String(t || "").toUpperCase()) ? String(t).toUpperCase() : null;

// One retry on a transient. A live test saw a single Yahoo pull fail while ten sequential and
// twelve parallel ones succeeded — a blip, not rate limiting. Without the retry the analyst tells
// a paying subscriber it has no headlines when it does, which is worse than the extra 400ms.
async function get(url, headers, tries = 2) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return r;
      last = r;
      if (r.status === 404 || r.status === 400) return r;   // a real answer; retrying changes nothing
    } catch (e) { last = null; }
    if (i < tries - 1) await new Promise((s) => setTimeout(s, 250));
  }
  return last;
}

function ageOf(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, Math.round((Date.now() - n) / 60000));
}

// ── declarations (Gemini / Vertex functionDeclarations format) ──────────────────
const declarations = [
  {
    name: "get_chain_token",
    description:
      "One ON-CHAIN token from the memecoin surface on Solana and Robinhood Chain - the ~200 tokens " +
      "OUTSIDE the coin half of the map. Use for any question naming a memecoin or chain token, for " +
      "'what is moving on-chain', or to compare a chain token against the majors. Returns depth " +
      "summed across its pools, 24h and 1h volume, turnover, buyer/seller wallet counts, price " +
      "change, and whether the contract address is actually the listed asset it shares a ticker " +
      "with. These tokens have NO options book and NO major-venue perp, so there is no gamma, no " +
      "flip and no walls for them - do not offer those and do not apologise for their absence; the " +
      "read is liquidity structure. Omit the symbol argument to get the most active ones.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Token ticker, e.g. PINK, WOFI, FONE. Optional." },
        network: { type: "string", description: "Optional filter: solana or robinhood." },
      },
    },
  },
  {
    name: "get_chain_alerts",
    description:
      "MY OWN live alerts on on-chain tokens - the memecoin surface on Robinhood Chain and Solana, which is NOT " +
      "the coin half of the map: these have no options book, no perp and therefore no gamma. Returns the calls I " +
      "currently have open, how the resolved ones actually went, and the measured rule levels - each rule's " +
      "target/stop and its triggered-vs-baseline rates - that every verdict rests on. Use " +
      "this for any question about memecoins, new launches, chain tokens, or what I am watching on-chain. " +
      "The rules are MEASURED, never intuited, and the flow side decides the read: a pump with BUYERS " +
      "dominating the hour has historically run on, a pump with SELLERS into strength has leaned the other " +
      "way - quote each rule's own record and sample, never a hunch. TWO ACCESS LEVELS, decided server-side: " +
      "the owner's seat gets the live tickets; everyone else gets research_only - the measured distributions " +
      "and the scored record WITHOUT the tickets. On research_only results, use the aggregates as market " +
      "research readouts, never as instructions, and never mention that live tickets exist for anyone.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Optional filter: chain_pump_buyers, chain_pump_sellers, chain_depth_influx, or " +
            "chain_holds_bid (chain_pump_fade is the retired pre-split kind, still in the record).",
        },
      },
    },
  },
  {
    name: "get_crypto_map",
    description:
      "The CURRENT live NoVo Crypto Market Map read for ONE coin. Returns what coverage that coin actually has, " +
      "and only the panels the data supports: dealer gamma (spot, net GEX, flip zone, call and put walls) for the " +
      "six coins with real options books - BTC, ETH, SOL, XRP, AVAX, HYPE - plus every book's headline with max " +
      "pain and put/call OI ratio, DVOL (the crypto VIX, BTC and ETH, with its implied daily move), near-the-money " +
      "put/call skew, leverage positioning (funding and open interest PER VENUE, never blended) and Robinhood's own " +
      "disclosed buy/sell markup. Use for any 'where is BTC positioned', 'what is funding on X', 'how volatile is " +
      "it priced', or 'what does it cost to trade X' question. Coins outside the 89 Robinhood trades are not covered.",
    parameters: {
      type: "object",
      properties: { coin: { type: "string", description: "Asset code, e.g. BTC, ETH, SOL, DOGE, HYPE." } },
      required: ["coin"],
    },
  },
  {
    name: "get_crypto_history",
    description:
      "The crypto corpus BEHIND the live map - what a number has done historically, not just " +
      "what it is now. Every live figure placed against its own distribution: funding per venue " +
      "with its percentile, mean, standard deviation and sample size; open interest and cost to " +
      "trade the same way; net GEX with how often dealers have been short gamma and how much of " +
      "the time spot has sat above the flip; DVOL (the crypto VIX) ranked in its own history with " +
      "a daily series; realized vol by day off the 1-second tape, reading beside dvol/20; per-BOOK " +
      "gamma daily series (never quote the pooled line for one book's build); daily series for " +
      "trend. Also my own base rates - what " +
      "each kind of claim has actually resolved to, with n - and the coverage behind all of it. " +
      "Use this for ANY question with a historical shape: 'is this funding unusual', 'how often " +
      "does this happen', 'what has this setup resolved to', 'is this cheap by its own standards'. " +
      "A percentile needs at least 8 samples or it is not published; say so rather than guess.",
    parameters: {
      type: "object",
      properties: {
        coin: { type: "string", description: "Asset code, e.g. BTC. Omit for base rates and coverage only." },
      },
    },
  },
  {
    name: "get_crypto_breadth",
    description:
      "The CROSS-SECTIONAL crypto read across all 89 coins at once: median round-trip cost, the cheapest and " +
      "priciest coins to trade on Robinhood, the largest open interest, and 24h liquidation flow by coin and side. " +
      "Use for 'what is crypto doing overall', 'which coin is cheapest to trade', 'where did the liquidations hit'. " +
      "This is the crypto equivalent of market internals - there is no per-coin call that answers it.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_dealer_levels",
    description:
      "The CURRENT live dealer positioning read for ONE ticker: spot, gamma flip, call wall, put wall, net GEX, " +
      "gravity, today's expected move, ATM IV and the regime label. This is the paid real-time map — always prefer " +
      "it over search_journal for 'where is X right now' questions.",
    parameters: {
      type: "object",
      properties: { ticker: { type: "string", enum: TICKERS } },
      required: ["ticker"],
    },
  },
  {
    name: "get_gamma_profile",
    description:
      "Strike-by-strike dealer gamma for ONE ticker, sampled every few minutes through today's session. To " +
      "compare how two tickers are positioned, call this once per ticker. Use for " +
      "'how has gamma built or drained today' and 'which strikes are heaviest' — get_dealer_levels gives only the " +
      "summary levels, not the curve.",
    parameters: {
      type: "object",
      properties: {
        ticker: { type: "string", enum: TICKERS },
        lookback_minutes: { type: "integer", description: "How far back to include. Default 120, max 480." },
      },
      required: ["ticker"],
    },
  },
  {
    name: "get_session_history",
    description:
      "What NoVo has actually logged across past sessions for ONE ticker, and how many sessions that covers. Call " +
      "once per ticker to compare their histories. Use " +
      "for 'usually', 'how often', 'tends to' questions instead of guessing. Always report the session count.",
    parameters: {
      type: "object",
      properties: { ticker: { type: "string", enum: TICKERS } },
      required: ["ticker"],
    },
  },
  {
    name: "search_journal",
    description:
      "Semantic search over my own writing: 1,000+ Journal articles on mechanics, plus my own logged " +
      "market observations. Use for 'why does X happen', 'what does Y mean', 'what have you seen like this'. Call " +
      "again with a refined query if the first results miss.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        source: {
          type: "string", enum: ["journal", "memory", "any"],
          description: "Mechanics articles (journal), my own observations (memory), or both (any, default).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_quote",
    description:
      "Last price and percent change for any symbol not covered by get_dealer_levels — an individual name, VIX, " +
      "crude, gold, the 10-year yield.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string", description: "As Yahoo would recognise it: AAPL, ^VIX, GC=F, ^TNX." } },
      required: ["symbol"],
    },
  },
  {
    name: "get_economic_calendar",
    description: "Upcoming major US macro releases — FOMC, CPI, jobs, GDP, PCE, ISM — with date, ET time and consensus.",
    parameters: {
      type: "object",
      properties: { days_ahead: { type: "integer", description: "Default 10, max 18." } },
    },
  },
  {
    name: "get_earnings_dates",
    description: "The next scheduled earnings date for a ticker. Relevant to IV and skew questions.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_track_record",
    description:
      "How my own published claims have actually scored against my logged history: expected-move " +
      "containment, whether price travels further per hour in negative gamma, whether GRAVITY dampens movement around it (it PINS, it does not attract) " +
      "toward it, whether the WALLS hold, whether steep SKEW precedes a WIDER hour (it measures volatility, never direction), whether the squeeze SCALE is " +
      "real, how THE LINE's level-breaks resolved, the lean NoVo states on the open, and the pulse against the next " +
      "session. Several claims ALSO carry an `archive` block -- the same question re-asked over ~4,500 reconstructed " +
      "sessions back to 2008, graded on the session after each close. Quote it as a backtest, with its window and n, " +
      "and never merged with the live figure beside it. The `crypto` block is the crypto half of the same record — " +
      "my self-scored crypto claims by kind (gamma damp, funding extreme per paying side, OI quadrant per direction, " +
      "cost anomaly), where n_cells (independent coin-days) is the real denominator, trustworthy:false means an early " +
      "reading never a base rate, and directional rates carry the market drift they must beat. " +
      "Each claim carries its sample size. Use for 'how often', 'does that actually hold', 'how accurate are you'. This is " +
      "the scored record — get_session_history gives the raw session summary, not the hit rate.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_base_rates",
    description:
      "What has ACTUALLY happened next, historically, from a given dealer-map state — conditional base rates " +
      "built from my own logged snapshots. Cells are keyed by regime (short/long gamma), distance to the " +
      "gamma flip (below_far/below_near/at_line/above_near/above_far) and volatility tercile (low/mid/high), " +
      "each with the median move 15m and 60m forward and into the close, plus how often it resolved upward. " +
      "Use for 'how often does', 'what usually happens when', 'is that normal', 'what's the edge here'. " +
      "Also returns `signals`: how my OWN calls have scored — the squeeze state and the tape's sweep bias " +
      "graded against what price actually did over the next hour (correct_rate is directional accuracy; " +
      "dormant/balanced make no claim and are never scored). Use it when asked whether a signal is worth " +
      "trusting, and be straight when the record is thin or poor — an honest miss is worth more than a spun one. " +
      "CRITICAL: quote a cell ONLY when usable is true. n counts ~60s snapshots and is autocorrelated — " +
      "`sessions` is the real denominator, so a cell with sessions=1 is one afternoon, not evidence, no matter " +
      "how large n looks. Say the sample size out loud whenever you cite a number from here. " +
      "TWO HORIZONS, and they are not interchangeable. `cells` is my own intraday tape: what happened over " +
      "the next 15 and 60 minutes. It starts when I began logging, so it grows one session a day and its " +
      "session counts are small on purpose. `daily` is the SAME buckets read off maps reconstructed back to " +
      "2008 and graded on the NEXT SESSION open-to-close — hundreds of sessions per cell. Use the intraday " +
      "one for anything inside the day, which is most 0DTE questions; reach for `daily` when the question is " +
      "about the shape of a setup rather than the next hour, or when the intraday cell is thin and the honest " +
      "answer needs weight behind it. NEVER average them, never present one as the other, and always say " +
      "which clock a number is on — \"6 sessions intraday\" and \"252 sessions since 2008\" are both true " +
      "and answer different questions. `daily` is reconstructed, not traded: say so when you lean on it.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "SPY, QQQ or IWM. Omit for all three." },
        usable_only: { type: "boolean", description: "Default true. Set false only to show how thin a bucket is." },
      },
    },
  },
  {
    name: "get_market_internals",
    description:
      "The market internals I collect daily and had no way to quote until now: the VIX TERM " +
      "STRUCTURE (VIX9D, VIX, VIX3M, VIX6M with its shape and front-vs-3m spread), FINRA " +
      "off-exchange SHORT VOLUME per ticker with its own percentile, and OPTIONS PARTICIPATION " +
      "against each ticker's own recent baseline. " +
      "Use it for 'what is the vol curve doing', 'is the front bid', 'is short volume unusual', " +
      "'is participation heavy today'. " +
      "SHORT VOLUME IS A FLOW, NOT SHORT INTEREST -- it is one day's off-exchange executions, most " +
      "of it market makers hedging, so frame it as one-sidedness and NEVER as bearishness. Quote " +
      "the percentile, not the bare ratio: 55% means nothing on its own because SPY sits in the " +
      "fifties most days, and below 20 samples the rank comes back null rather than a number that " +
      "would look authoritative. " +
      "EVERYTHING HERE IS DATED. `termStructure.as_of` is the OLDEST of its four legs and the " +
      "options-volume rows carry `as_of` -- these are daily closes, so on an active session the " +
      "newest value is usually YESTERDAY'S. Say the date when you quote them; never present a " +
      "prior close as the current print.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "SPY, QQQ or IWM. Omit for all three." },
      },
    },
  },
  {
    name: "get_recent_reads",
    description:
      "my own recent desk notes — date, kind, the BIAS it published, and an excerpt. Use when asked " +
      "what you said earlier, whether you have changed your view, or to compare a past call with what " +
      "actually happened. This is your own record, not the archive: quote it as yours, and if an earlier " +
      "read did not hold up, say so plainly rather than reframing it.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "How many, 1-15. Default 5." } },
    },
  },
  {
    name: "search_news",
    description:
      "Recent headlines for one ticker — title and published age only, never article text. Use for " +
      "'why did X move' and 'what is the catalyst'. Scoped by symbol, so ask per ticker; use SPY for a " +
      "question about the market as a whole. A headline is never a verified number: attribute it.",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker, e.g. SPY, NVDA, ^VIX. Defaults to SPY." } },
      required: ["symbol"],
    },
  },
  {
    name: "describe_archive",
    description:
      "The MAP of the raw archives before querying them: every table I can reach in the chosen " +
      "archive ('dealer' = the equity corpus: per-minute dealer snapshots, session bars to 2000, " +
      "daily maps reconstructed to 2008, banked option chains, macro series to 1990, my published " +
      "reads; 'crypto' = the crypto corpus: gamma by strike, funding, OI, the 1-second tape, chain " +
      "pools, my scored claims) with its columns, row count and date span. ALWAYS call this before " +
      "the first query_archive of a conversation - guessing at schema wastes a round.",
    parameters: {
      type: "object",
      properties: { db: { type: "string", enum: ["dealer", "crypto"], description: "Which archive." } },
      required: ["db"],
    },
  },
  {
    name: "query_archive",
    description:
      "Run ONE read-only SQL SELECT against the raw archives on my own box - the observations " +
      "BEHIND every rollup. Use when no other tool answers the question's exact shape: 'every " +
      "session since 2008 where the flip sat within 0.3% at the open', 'the strike ladder that was " +
      "banked at Thursday's open', 'BTC's 1-second tape through the CPI print'. Rules: SELECT only, " +
      "one statement, always add a LIMIT and a date filter (a 1.2s budget kills broad scans), " +
      "columns come from describe_archive. Results cap at 200 rows - aggregate in SQL rather than " +
      "fetching rows to count. HONESTY RULES APPLY DOUBLE HERE: you are computing a statistic " +
      "nobody pre-vetted, so state the n and the window, use session/coin-day counts as the " +
      "denominator (snapshot rows are ~60s apart and autocorrelated), and never pool " +
      "source='backfill' with live rows. If it returns an error, the archive box may be offline - " +
      "say the archive is unreachable and answer from the live layer.",
    parameters: {
      type: "object",
      properties: {
        db: { type: "string", enum: ["dealer", "crypto"], description: "Which archive." },
        sql: { type: "string", description: "One SELECT statement. Include LIMIT." },
        max_rows: { type: "number", description: "Row cap, 1-200. Default 200." },
      },
      required: ["db", "sql"],
    },
  },
  {
    name: "get_chain_history",
    description:
      "The on-chain corpus's HISTORY - the one series that can never be backfilled. Per token " +
      "(keyed network:address, never bare ticker): a daily series of price, pooled depth, 24h " +
      "volume, hourly wallet counts and 24h change, up to 21 days, plus the sweep's own shape by " +
      "day (tokens seen, first appearances - survivorship stated, not hidden). Use for 'how long " +
      "has this token held depth', 'is this pool bleeding', 'what did it do yesterday', or any " +
      "chain-token question with a time shape. days_seen below the window means the token entered " +
      "late or left the sweep - say that rather than treating absence as a quiet day.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Token ticker - returns EVERY address sharing it, because one ticker covers many tokens. Optional." },
        address: { type: "string", description: "Contract address for an exact token. Optional." },
        network: { type: "string", description: "solana or robinhood. Optional filter." },
      },
    },
  },
  {
    name: "get_market_breadth",
    description:
      "The equity market's INTERNAL state right now: advancing-vs-declining breadth and the SPY " +
      "put/call ratio behind the Market Pulse, plus the 11 SPDR sectors' moves on the day. Use for " +
      "'how broad is this move', 'is this rally thin', 'which sectors are carrying it', 'is the " +
      "tape one-sided'. Breadth is participation, never direction advice; a rally on 3 sectors and " +
      "negative breadth is a different market from the same rally on 9.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_vol_history",
    description:
      "The volatility RECORD behind the current print: VIX daily closes since 1990, VIX9D, VIX3M, " +
      "VIX6M, VXN, RVX, VVIX and CBOE SKEW — each with its current level, its percentile against its " +
      "FULL history AND against the last two years, min/median/max and the sample size, plus the term " +
      "structure with its shape. THE tool for 'is vol high', 'is this cheap', 'where does VIX rank', " +
      "'what percentile is this'. Quote BOTH percentiles when they disagree — 'the 33rd percentile " +
      "since 1990 but the 13th of the last two years' — because a level can be historically cheap and " +
      "locally rich at once. Daily closes: quote last_date, and never present a prior close as the " +
      "current print.",
    parameters: {
      type: "object",
      properties: {
        series: { type: "string", description: "Optional: VIX, VIX9D, VIX3M, VIX6M, VXN, RVX, VVIX or SKEW. Omit for all." },
      },
    },
  },
  {
    name: "get_futures_positioning",
    description:
      "Weekly FUTURES positioning from the CFTC's Commitments of Traders: net position of speculators " +
      "(non-commercial, the funds) and hedgers (commercial) in E-mini S&P 500, Nasdaq 100, Russell 2000 " +
      "and VIX futures, with the week-over-week change, open interest and a short trend. The dealer map " +
      "reads OPTIONS positioning intraday; this is the futures crowd on a weekly clock — who is long the " +
      "index itself. Use for 'how are funds positioned', 'is the market crowded long', 'what is spec " +
      "positioning in VIX'. Released Friday for the prior TUESDAY, so it is days old BY DESIGN — always " +
      "give the report date. A crowded net is fuel for a move the other way, never a direction call.",
    parameters: { type: "object", properties: {} },
  },
];

// ── executors ──────────────────────────────────────────────────────────────────
// ctx supplies what only analyst-ask.js has: the loaded index and its embed/search pair.
function makeExecutors(ctx = {}) {
  const r = kv();

  // Comped seats only, for now. The thresholds behind these calls rest on a few dozen resolved
  // observations from a single window -- enough to act on personally, nowhere near enough to sell.
  // Gated through _lib/comp.js -- the ONE implementation of the COMP_EMAILS check every surface
  // shares, so this gate can never drift from the dashboards'.
  const { isComp } = require("./comp.js");

  async function get_chain_token({ symbol, network } = {}) {
    if (!r) return { error: "chain map unavailable" };
    let snap = null;
    try { snap = await r.get("crypto:map:live"); } catch (_) { snap = null; }
    if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
    const rows = (snap && Array.isArray(snap.chain)) ? snap.chain : null;
    if (!rows) return { error: "no chain data published yet" };

    let hits = rows;
    if (network) hits = hits.filter((t) => t.network === String(network).toLowerCase());
    if (symbol) {
      const q = String(symbol).toUpperCase();
      hits = hits.filter((t) => String(t.symbol || "").toUpperCase() === q);
      if (!hits.length) {
        return {
          not_found: q,
          // A ticker missing from the sweep is not proof it does not exist -- the sweep is the top
          // pools by liquidity, so a small token is simply below the cut. Say that, do not say the
          // token is not real.
          note: "not in the current sweep - it covers the deepest pools per network, so a smaller "
              + "token can be below the cut rather than nonexistent",
          tracked: rows.length,
        };
      }
      // A ticker can cover several DIFFERENT tokens: CYBERLEEK and WOFI each ran ten distinct
      // Solana addresses on one pass. Return them all rather than picking one and calling it the
      // answer -- which address it is, is the actual question.
      return { as_of: snap.as_of, symbol: q, matches: hits.length, tokens: hits.slice(0, 6) };
    }
    return {
      as_of: snap.as_of,
      tracked: rows.length,
      networks: [...new Set(rows.map((t) => t.network))],
      most_active: hits.slice().sort((a, b) => (b.vol_h24 || 0) - (a.vol_h24 || 0)).slice(0, 12),
    };
  }

  async function get_chain_alerts({ kind } = {}) {
    const comped = isComp(ctx.email);
    if (!r) return { error: "live alerts unavailable" };
    let snap = null;
    try { snap = await r.get("crypto:map:live"); } catch (_) { snap = null; }
    if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
    const a = snap && snap.alerts;
    if (!a) return { error: "no alerts published yet - the crypto collector is not reporting" };

    const pick = (rows) => (kind ? (rows || []).filter((x) => x.kind === kind) : (rows || []));

    // THE RESEARCH IS SHAREABLE; THE TICKETS ARE NOT. The tickets are direct buy/sell
    // instructions and instructions to subscribers are the line this product never crosses —
    // but the measured distributions and the scored record are market research, and Jake's
    // call (2026-08-30) is that NoVo may analyse WITH them for anyone. So a non-comped caller
    // gets the aggregates only, with the live tickets absent — not refused, absent.
    if (!comped) {
      return {
        as_of: snap.as_of,
        research_only: true,
        record: a.record,
        levels: a.levels,
        min_samples: a.min_samples,
        note: "Aggregate research from my on-chain rule lab: measured forward-move distributions " +
              "per rule and the scored record. Use these as READOUTS — 'tokens in this state have " +
              "historically moved X% of the time, n=...' — and always with the sample. Never turn " +
              "a rate into an instruction to buy, sell or avoid anything, and do not describe " +
              "this as an alert service.",
      };
    }
    return {
      as_of: snap.as_of,
      open: pick(a.open).slice(0, 25),
      recent_resolved: pick(a.recent).slice(0, 25),
      // The record travels WITH the calls on purpose. An alert shown without the base rate it beat
      // is a tip, and 'meaningful' stays false until a rule has enough resolved claims to mean
      // anything - state the count, never dress a hit rate on nine samples as evidence.
      record: a.record,
      // The measured rule table: per-kind target/stop levels plus the triggered-vs-untriggered
      // rates each verdict rests on. The feed ships `levels` + `min_samples` — the earlier
      // `baseline`/`thresholds` keys never existed in the payload and always read undefined.
      levels: a.levels,
      min_samples: a.min_samples,
    };
  }

  async function get_dealer_levels({ ticker }) {
    const tk = okTicker(ticker);
    if (!tk) return { error: "ticker must be SPY, QQQ or IWM" };
    if (!r) return { error: "live levels unavailable" };
    let snap = null;
    try { snap = await r.get("analyst:live_levels"); } catch (_) { snap = null; }
    if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
    if (!snap) return { error: "no live read published yet" };
    const row = (snap.tickers || []).find((x) => x.ticker === tk);
    if (!row) return { error: `no live read for ${tk}` };
    return { ...row, session: snap.session || null, ageMinutes: ageOf(snap.asof), live: true };
  }

  async function get_gamma_profile({ ticker, lookback_minutes }) {
    const tk = okTicker(ticker);
    if (!tk) return { error: "ticker must be SPY, QQQ or IWM" };
    if (!r) return { error: "gamma profile unavailable" };
    const look = Math.min(Math.max(Number(lookback_minutes) || 120, 15), 480);
    const day = new Date().toISOString().slice(0, 10);
    let raw = [];
    try { raw = await r.lrange(`gh:${tk}:${day}`, 0, 119); } catch (_) { raw = []; }
    const cutoff = Date.now() - look * 60000;
    const snaps = (raw || [])
      .map((x) => { try { return typeof x === "string" ? JSON.parse(x) : x; } catch (_) { return null; } })
      .filter((x) => x && x.t >= cutoff)
      .sort((a, b) => a.t - b.t);
    if (!snaps.length) return { error: "no profile history for today yet", ticker: tk };
    // Hand back the newest curve in full plus how the heaviest strikes moved, not 100 raw columns.
    const latest = snaps[snaps.length - 1];
    const byStrike = (rows) => (rows || []).slice().sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8);
    return {
      ticker: tk,
      columns: snaps.length,
      spanMinutes: Math.round((latest.t - snaps[0].t) / 60000),
      latest: { at: new Date(latest.t).toISOString(), heaviestStrikes: byStrike(latest.r) },
      earliest: { at: new Date(snaps[0].t).toISOString(), heaviestStrikes: byStrike(snaps[0].r) },
      ageMinutes: ageOf(latest.t),
    };
  }

  async function get_session_history({ ticker }) {
    const tk = okTicker(ticker);
    if (!tk) return { error: "ticker must be SPY, QQQ or IWM" };
    if (!r) return { error: "session history unavailable" };
    let ctxs = null;
    try { ctxs = await r.get("analyst:context"); } catch (_) { ctxs = null; }
    if (typeof ctxs === "string") { try { ctxs = JSON.parse(ctxs); } catch (_) { ctxs = null; } }
    if (!ctxs) return { error: "no logged session history yet" };
    const scoped = ctxs[tk] || ctxs[tk.toLowerCase()] || ctxs;
    return { ticker: tk, history: scoped, note: "counts and medians over the sessions NoVo has logged, not a forecast" };
  }

  async function search_journal({ query, source }) {
    const q = String(query || "").trim().slice(0, 300);
    if (!q) return { error: "empty query" };
    if (!ctx.index || !ctx.embed || !ctx.search) return { error: "corpus unavailable" };
    const qv = await ctx.embed(q);
    if (!qv) return { error: "could not embed the query" };
    const want = String(source || "any");
    const hits = ctx.search(ctx.index, qv, 8)
      .filter((h) => want === "any" || (want === "memory" ? h.s === "memory" : h.s !== "memory"))
      .slice(0, 5);
    if (!hits.length) return { error: "nothing in the corpus matched", query: q };
    return {
      query: q,
      results: hits.map((h) => ({
        title: h.t,
        kind: h.s === "memory" ? "my own earlier read" : "Journal",
        url: h.u || null,
        excerpt: String(h.x || "").slice(0, 700),
      })),
    };
  }

  async function get_quote({ symbol }) {
    const sym = String(symbol || "").trim().slice(0, 16);
    if (!sym) return { error: "no symbol" };
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
      const resp = await get(url, { "User-Agent": "Mozilla/5.0" });
      if (!resp || !resp.ok) return { error: `no quote for ${sym}` };
      const res = (await resp.json())?.chart?.result?.[0];
      const m = res?.meta;
      if (!m || m.regularMarketPrice == null) return { error: `no quote for ${sym}` };
      const price = m.regularMarketPrice;
      const closes = (res?.indicators?.quote?.[0]?.close || []).filter((c) => c != null);
      let prev = null;
      if (closes.length >= 2) {
        const last = closes[closes.length - 1];
        prev = Math.abs(last - price) / price < 0.0005 ? closes[closes.length - 2] : last;
      }
      if (prev == null) prev = m.chartPreviousClose ?? m.previousClose;
      return {
        symbol: sym.toUpperCase(),
        name: m.shortName || m.longName || null,
        price: Math.round(price * 100) / 100,
        changePct: prev ? Math.round(((price - prev) / prev) * 10000) / 100 : null,
        marketState: m.marketState || null,
      };
    } catch (e) { return { error: `quote lookup failed for ${sym}` }; }
  }

  async function get_economic_calendar({ days_ahead } = {}) {
    const days = Math.min(Math.max(Number(days_ahead) || 10, 1), 18);
    const MAJOR = /\b(fed|fomc|interest rate|cpi|inflation|nonfarm|payroll|employment|unemployment|jobless|gdp|pce|retail sales|ism|consumer confidence|ppi)\b/i;
    const isUS = (c) => /united states|^us$|^u\.s\.?$/i.test(String(c || "").trim());
    const ymd = (d) => d.toISOString().slice(0, 10);
    // One day per request is Nasdaq's only granularity, so a ten-day window is ten requests.
    // Sequentially — each with a retry — that overran the tool loop's per-round budget and came
    // back to the model as a timeout, which it correctly but uselessly reported as "no calendar".
    // In parallel the whole window costs about one round trip.
    const out = [];
    try {
      const perDay = await Promise.all(
        Array.from({ length: days }, async (_unused, i) => {
          const real = new Date(Date.now() + i * 86400000);
          // Nasdaq buckets US events one calendar day late; api/calendar.js documents the +1 in detail.
          const q = new Date(real.getTime() + 86400000);
          const resp = await get(`https://api.nasdaq.com/api/calendar/economicevents?date=${ymd(q)}`,
            { "User-Agent": "Mozilla/5.0", Accept: "application/json" });
          if (!resp || !resp.ok) return [];
          let rows = [];
          try { rows = (await resp.json())?.data?.rows || []; } catch (_) { return []; }
          return rows.filter((x) => isUS(x.country) && MAJOR.test(x.eventName || ""))
            .map((x) => ({
              date: ymd(real),
              timeET: String(x.gmt || "").trim() || null,   // Nasdaq mislabels this "gmt"; it is ET
              event: String(x.eventName || "").trim(),
              consensus: String(x.consensus || "").trim() || null,
              previous: String(x.previous || "").trim() || null,
            }));
        }));
      for (const day of perDay) out.push(...day);   // Promise.all preserves order, so this stays date-ordered
    } catch (_) { /* fall through to whatever was collected */ }
    if (!out.length) return { error: "no calendar data available right now" };
    return { events: out.slice(0, 14) };
  }

  // Nasdaq answers this one in prose, not fields — there is no structured date anywhere in the
  // payload — so the date and the session are parsed out of the sentence. If the sentence ever
  // stops matching, this returns an error rather than a guess.
  async function get_earnings_dates({ symbol }) {
    const sym = String(symbol || "").trim().toUpperCase().replace(/[^A-Z.\-]/g, "").slice(0, 10);
    if (!sym) return { error: "no symbol" };
    let text = "";
    try {
      const resp = await get(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(sym)}/earnings-date`,
        { "User-Agent": "Mozilla/5.0", Accept: "application/json" });
      if (!resp || !resp.ok) return { error: `no earnings date found for ${sym}` };
      const j = await resp.json();
      text = String(j?.data?.reportText || "").replace(/\s+/g, " ").trim();
    } catch (_) { return { error: `no earnings date found for ${sym}` }; }
    if (!text) return { error: `no earnings date found for ${sym}` };

    const md = /(\d{2})\/(\d{2})\/(\d{4})/.exec(text);
    // Nasdaq says so in prose when its vendor has not posted the next date — pass that through
    // rather than a bare failure, so the model says "not scheduled yet" instead of inventing one.
    if (!md) {
      return /hasn't provided|has not provided|not available/i.test(text)
        ? { symbol: sym, date: null, note: `no confirmed next earnings date published for ${sym} yet` }
        : { error: `no earnings date found for ${sym}` };
    }
    const iso = `${md[3]}-${md[1]}-${md[2]}`;
    const days = Math.round((Date.parse(iso + "T20:00:00Z") - Date.now()) / 86400000);
    const session = /after market close/i.test(text) ? "after the close"
                  : /before market open/i.test(text) ? "before the open" : null;
    return {
      symbol: sym, date: iso, session, daysAway: days,
      detail: text,
      note: days < 0
        ? "this date has passed — Nasdaq had not posted the next one when this was read"
        : "expected date, not confirmed by the company; it moves",
    };
  }

  // Google News keyword search was tried first and returned message-board spam for market queries —
  // literally unrelated surgery ads against "SPY options". Yahoo's per-symbol finance feed is
  // scoped by ticker rather than by keyword match, so relevance is structural instead of hoped for.
  async function search_news({ symbol }) {
    const sym = String(symbol || "SPY").trim().toUpperCase().replace(/[^A-Z.\-^]/g, "").slice(0, 10);
    if (!sym) return { error: "no symbol" };
    try {
      const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`;
      const resp = await get(url, { "User-Agent": "Mozilla/5.0" });
      if (!resp || !resp.ok) return { error: "news unavailable" };
      const xml = await resp.text();
      const clean = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
      const items = [];
      const re = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = re.exec(xml)) && items.length < 6) {
        const block = m[1];
        // [\s\S] has to be double-escaped here: this is a template literal, where \s collapses
        // to a bare "s" and the class silently degrades to [sS] — matching nothing but letters.
        const pick = (tag) => {
          const t = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
          return t ? (clean(t[1]) || null) : null;
        };
        const title = pick("title");
        if (!title) continue;
        const pub = pick("pubDate");
        const ts = pub ? Date.parse(pub) : NaN;
        items.push({
          title,
          published: pub,
          ageHours: Number.isFinite(ts) ? Math.round((Date.now() - ts) / 3600000) : null,
        });
      }
      if (!items.length) return { error: `no recent headlines for ${sym}` };
      return {
        symbol: sym, headlines: items,
        note: "headlines only, no article text — attribute to the wire, never state as verified fact",
      };
    } catch (_) { return { error: "news lookup failed" }; }
  }

  // The scored record behind /track-record, read from the same key the public page serves. The
  // analyst was answering "how often does SPY close inside the expected move" with "I have not
  // logged that" while the site published the count — its own strongest evidence, out of reach.
  async function get_market_internals({ symbol } = {}) {
    if (!r) return { error: "market internals unavailable" };
    let snap = null;
    try { snap = await r.get("novo:market_internals"); } catch (_) { snap = null; }
    if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
    if (!snap) return { error: "no market internals published yet" };

    const want = symbol ? [String(symbol).toUpperCase()] : TICKERS;
    const pick = (obj) => {
      if (!obj) return null;
      const out = {};
      for (const t of want) if (obj[t]) out[t] = obj[t];
      return Object.keys(out).length ? out : null;
    };
    return {
      // The curve is not per-ticker: VIX is the SPY-side construct and the shape is a market-wide
      // statement, so it is returned whole rather than filtered by symbol.
      termStructure: snap.termStructure || null,
      shortVolume: pick(snap.shortVolume),
      optionsVolume: pick(snap.optionsVolume),
      publishedAt: snap.received || snap.generated || null,
      note: "Daily closes. Every block carries its own as_of -- quote the date, and never read a "
          + "prior close as the current print.",
    };
  }

  async function get_base_rates({ symbol, usable_only } = {}) {
    if (!r) return { error: "base rates unavailable" };
    let snap = null;
    try { snap = await r.get("novo:base_rates"); } catch (_) { snap = null; }
    if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
    if (!snap || !snap.tickers) return { error: "no base rates published yet" };
    const only = usable_only !== false;
    const want = symbol ? [String(symbol).toUpperCase()] : TICKERS;
    const out = {};
    for (const tk of want) {
      const t = snap.tickers[tk];
      if (!t) continue;
      const cells = (t.cells || []).filter((c) => (only ? c.usable : true));
      out[tk] = {
        snapshots: t.snapshots,
        usableCells: t.usable_cells,
        totalCells: (t.cells || []).length,
        volTerciles: t.vol_index_terciles,
        cells,
        byTimeOfDay: (t.by_tod || []).filter((c) => (only ? c.usable : true)),
        signals: t.signals || null,
        // The next-session block, reconstructed to 2008. Same shape, different clock -- kept under its
        // own key so nothing downstream can quietly fold it into the intraday medians.
        daily: t.daily
          ? {
              source: t.daily.source,
              horizon: t.daily.horizon,
              scored: t.daily.scored,
              window: t.daily.window,
              minSessions: t.daily.min_sessions,
              usableCells: t.daily.usable_cells,
              cells: (t.daily.cells || []).filter((c) => (only ? c.usable : true)),
            }
          : null,
      };
    }
    if (!Object.keys(out).length) return { error: "unknown symbol" };
    return {
      window: snap.window, minN: snap.min_n, minSessions: snap.min_sessions,
      builtEt: snap.built_et, note: snap.note, tickers: out,
      // what the tape did on the days each macro print landed — the backward half of the calendar
      macroDays: snap.events || [],
    };
  }

  // NoVo recalling what IT said, rather than reconstructing it from the archive by similarity. A read
  // carries a date and a BIAS, so "what did I call this morning" has an exact answer, not a nearest match.
  async function get_recent_reads({ limit } = {}) {
    if (!r) return { error: "reads unavailable" };
    let snap = null;
    try { snap = await r.get("novo:base_rates"); } catch (_) { snap = null; }
    if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
    const reads = (snap && snap.reads) || [];
    if (!reads.length) return { reads: [], note: "no reads logged yet — logging began 2026-08-20" };
    const k = Math.min(Math.max(Number(limit) || 5, 1), 15);
    return { reads: reads.slice(0, k) };
  }

  async function get_track_record() {
    if (!r) return { error: "track record unavailable" };
    let snap = null;
    try { snap = await r.get("novo:track_record"); } catch (_) { snap = null; }
    if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
    if (!snap || !snap.tickers) return { error: "no track record published yet" };
    const out = {};
    for (const [tk, t] of Object.entries(snap.tickers)) {
      const e = t.expected_move || {}, f = t.flip_regime || {},
            g = t.gravity_pull || {}, w = t.wall_respect || {}, wb = t.wall_base_rate || {},
            ar = t.archive || {},
            sk = t.skew_signal || {}, sq = t.squeeze_bands || {}, ln = t.line_record || {};
      out[tk] = {
        expectedMove: e.sessions
          ? { inside: e.inside, outside: e.outside, sessions: e.sessions,
              ratePct: e.rate, baselinePct: e.baseline }
          : null,
        flipRegime: f.enough
          ? { holds: f.holds, ratio: f.ratio,
              positiveMedianHourPct: f.positive_median_pct, positiveN: f.positive_n,
              negativeMedianHourPct: f.negative_median_pct, negativeN: f.negative_n }
          : { enough: false, positiveN: f.positive_n || 0, negativeN: f.negative_n || 0 },
        // the two labels the dashboard prints every session, finally graded
        // Gravity DAMPENS, it does not attract. Price on gravity moves about half as far over the
        // next hour; price far from it does not get reeled back. Never describe it as a magnet.
        gravityPin: g.enough ? { measures: g.measures, pinRatio: g.pin_ratio, holds: g.holds,
                                 onGravityMovePct: g.near_median_move_pct, onGravityN: g.near_n,
                                 farMovePct: g.far_median_move_pct, farN: g.far_n,
                                 pullCloserRate: g.pull_closer_rate, pullN: g.pull_n } : null,
        wallRespect: w.enough ? { callHeldRate: w.call_wall_held_rate, putHeldRate: w.put_wall_held_rate, callN: w.call_n, putN: w.put_n } : null,
        // What a wall DOES once price reaches it, over the reconstructed archive back to 2008 --
        // a different question from wallRespect, which asks whether it contained the next hour.
        // Days price never came near the wall are excluded, so these are not "how often is the
        // wall right", they are "price is at the wall, now what". BACKFILL: never quote these
        // pooled with the live numbers, and say the window when citing them.
        // THE RECONSTRUCTED ARCHIVE -- the same claims asked of ~4,500 sessions back to 2008
        // instead of the few dozen NoVo has logged live. Dealer maps rebuilt from each session's
        // CLOSING chain and graded on the session after, so every cell is a forward test.
        //
        // Quoting rules, and they matter: this is a BACKTEST. Never pool it with the live numbers
        // beside it, never average the two, and always give the window and the n. The horizon
        // differs too -- live cells are measured on the next HOUR, these on the next SESSION's
        // range, so "1.59x further" and "1.03x further" are not in conflict, they are different
        // instruments. Say which one you are quoting.
        archive: ar.enough ? {
          from: ar.from, to: ar.to, horizon: ar.horizon, source: "reconstructed daily maps",
          expectedMove: ar.expected_move || null,
          flipRegime: ar.flip_regime || null,
          gravity: ar.gravity || null,
          skew: ar.skew || null,
          reading: "the flip and skew results are the strongest evidence NoVo has for its own thesis; " +
                   "gravity's dampening does NOT survive to the next session and should be stated as an " +
                   "intraday effect, not a daily one",
        } : null,
        wallBaseRate: wb.enough ? {
          call: wb.call, put: wb.put, from: wb.from, to: wb.to, source: "reconstructed daily maps",
          reading: "price GOES THROUGH a wall far more often than it is turned away by one",
        } : null,
        // Skew measures VOLATILITY, not direction. Index skew is positive almost always, so its level
        // is not a directional call — the tested claim is that skew steep FOR THIS TICKER precedes a
        // wider hour than skew that is flat for it. Never quote this as a bearish signal.
        skewSignal: sk.enough ? { measures: sk.measures, ratio: sk.ratio, holds: sk.holds,
                                  steepThreshold: sk.high_threshold, steepMedianMovePct: sk.high_median_move_pct, steepN: sk.high_n,
                                  flatThreshold: sk.low_threshold, flatMedianMovePct: sk.low_median_move_pct, flatN: sk.low_n } : null,
        squeezeBands: (sq.bands || []).filter((b) => b.usable),
        squeezeScaleMonotonic: sq.monotonic === undefined ? null : sq.monotonic,
        // The Line: direction and whether the level it broke actually held. Two different claims.
        lineRecord: ln.enough ? { directionRate: ln.direction_rate, levelHeldRate: ln.level_held_rate, n: ln.n }
                              : { enough: false, n: ln.n || 0, note: ln.note || "accruing" },
      };
    }
    const lr = snap.lean_record || {};
    // THE CRYPTO HALF OF THE SAME RECORD. The collector self-scores its claims (gamma pin,
    // funding extreme, OI quadrant, cost anomaly) exactly the way the engine scores the equity
    // ones. Additive: if the crypto rollup is missing, the equity record still serves whole.
    let cryptoRec = null;
    try {
      const ch = await _cryptoHist();
      if (ch && ch.base_rates && Object.keys(ch.base_rates).length) {
        cryptoRec = {
          baseRates: ch.base_rates,
          retired: ch.base_rates_retired || null,
          openClaims: ch.open_claims ?? null,
          note: "self-scored crypto claims, graded at their own horizons against the series each " +
                "claim was made on. n_cells (independent coin-days) is the denominator that " +
                "matters; a row with trustworthy:false is an early reading — give the cell count " +
                "and the caveat, never the percentage alone. Directional kinds report per " +
                "predicted side, each with market_baseline (the drift a rate has to beat). A " +
                "kind under `retired` was measured and taken out — say so if asked about it.",
        };
      }
    } catch (_) { cryptoRec = null; }
    return {
      tickers: out,
      crypto: cryptoRec,
      // the most public claim the product makes: the direction NoVo commits to on the open, graded
      // open-to-close. Only the Pre-Market Primer counts -- Mid-Day reads a session already half
      // resolved, the Closing Bell is a summary, and the Weekly takes a view on the week.
      //
      // This used to be `biasRecord`, and it was not a claim at all: the tag it scored was the
      // overnight gap (>= +0.15% BULLISH, <= -0.15% BEARISH, flat NEUTRAL). That rule is right
      // 50.9% of the time across 3,844 SPY gap days, so the 68.2% it once reported was luck with
      // a label on it. Renamed as well as rewired, deliberately -- a stale key here is how a
      // coin flip gets quoted in a chat answer as NoVo's own hit rate.
      leanRecord: lr.enough
        ? { correctRate: lr.correct_rate, n: lr.n, holds: lr.holds, scored: lr.scored,
            strength: lr.strength || null }
        : { enough: false, n: lr.n || 0, note: lr.note || "no lean scored yet" },
      // pulse graded FORWARD, against the next session — same-session would be circular
      pulseSignal: snap.pulse_signal || null,
      sessionsLogged: snap.sessions_logged || null,
      from: snap.from || null, to: snap.to || null,
      note: "my own log, self-reported and self-scored — not an independent audit, and not the " +
            "record of any trade. Always state the sample size alongside any rate from here.",
    };
  }

  // ── NoVo Crypto Market Map ──────────────────────────────────────────────────────────
  // Reads the same KV snapshot the gated crypto dashboard reads, published by the owner
  // box each pass. NoVo is the analyst for BOTH products, so adding these here makes it
  // crypto-capable in the Analyst dashboard and the Crypto dashboard at once - there is
  // no second assistant and no second knowledge base.
  //
  // NOTE ON ENTITLEMENT: this is NoVo's own knowledge, not a customer data feed. The
  // crypto MAP is gated at /api/crypto-map; what NoVo knows is not partitioned, because
  // NoVo is the house analyst rather than a per-seat entitlement.
  async function _cryptoSnap() {
    if (!r) return null;
    let snap = null;
    try { snap = await r.get("crypto:map:live"); } catch (_) { snap = null; }
    if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
    return (snap && snap.coins) ? snap : null;
  }

  async function _cryptoHist() {
    if (!r) return null;
    let h = null;
    try { h = await r.get("crypto:map:history"); } catch (_) { h = null; }
    if (typeof h === "string") { try { h = JSON.parse(h); } catch (_) { h = null; } }
    return (h && h.coins) ? h : null;
  }

  // ── the archive channel — the box answers, the store relays ─────────────────
  // Availability is honestly asymmetric: the LIVE layer is cloud-side and survives the box;
  // the raw archives ARE the box. A failure here returns an error the model is instructed
  // to state plainly rather than fill.
  const ARCHIVE_URL = String(process.env.ARCHIVE_URL || "").replace(/\/$/, "");
  const ARCHIVE_SECRET = process.env.ARCHIVE_QUERY_SECRET || "";

  async function _archiveFetch(path, init) {
    if (!ARCHIVE_URL || !ARCHIVE_SECRET) return { error: "the archive channel is not configured" };
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch(ARCHIVE_URL + path, {
        ...init,
        headers: { ...(init && init.headers), "x-archive-secret": ARCHIVE_SECRET },
        signal: ctl.signal,
      });
      clearTimeout(t);
      if (!r.ok) return { error: `archive answered ${r.status}` };
      return await r.json();
    } catch (_) {
      return { error: "the archive box is unreachable right now - the live layer is unaffected" };
    }
  }

  async function describe_archive({ db } = {}) {
    const k = db === "crypto" ? "crypto" : "dealer";
    return _archiveFetch(`/api/archive/catalog?db=${k}`, { method: "GET" });
  }

  async function query_archive({ db, sql, max_rows } = {}) {
    const k = db === "crypto" ? "crypto" : "dealer";
    return _archiveFetch("/api/archive/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ db: k, sql: String(sql || ""), max_rows }),
    });
  }

  async function get_chain_history({ symbol, address, network } = {}) {
    if (!r) return { error: "chain history unavailable" };
    let h = null;
    try { h = await r.get("crypto:map:chainhist"); } catch (_) { h = null; }
    if (typeof h === "string") { try { h = JSON.parse(h); } catch (_) { h = null; } }
    if (!h || !h.tokens) return { error: "no chain history published yet" };
    const base = { series_cols: h.series_cols, sweep_days: h.days, coverage: h.coverage,
                   note: h.note };
    const entries = Object.entries(h.tokens);
    let hits = entries;
    if (network) hits = hits.filter(([k]) => k.startsWith(String(network).toLowerCase() + ":"));
    if (address) {
      const q = String(address).trim();
      hits = hits.filter(([k]) => k.endsWith(":" + q));
    } else if (symbol) {
      const q = String(symbol).trim().toUpperCase();
      hits = hits.filter(([, v]) => String(v.symbol || "").toUpperCase() === q);
      if (!hits.length) {
        return { ...base, not_found: q, tracked: entries.length,
                 note2: "not in the rolled-up sweep - it holds the deepest ~200 tokens; " +
                        "a smaller token can be below the cut rather than nonexistent" };
      }
    }
    if (address || symbol) {
      const out = {};
      for (const [k, v] of hits.slice(0, 6)) out[k] = v;
      return { ...base, matches: hits.length, tokens: out };
    }
    // no filter: the sweep's shape plus the deepest tokens' latest day
    const top = hits
      .map(([k, v]) => ({ key: k, symbol: v.symbol, days_seen: v.days_seen,
                          latest: v.daily[v.daily.length - 1] }))
      .sort((a, b) => ((b.latest && b.latest[2]) || 0) - ((a.latest && a.latest[2]) || 0))
      .slice(0, 15);
    return { ...base, tracked: entries.length, deepest: top };
  }

  // The 11 SPDR sectors, one batch quote — the same universe api/heatmap.js draws.
  const SECTORS = [["XLK","Tech"],["XLF","Financials"],["XLV","Health care"],["XLY","Cons. discretionary"],
                   ["XLP","Cons. staples"],["XLE","Energy"],["XLI","Industrials"],["XLB","Materials"],
                   ["XLRE","Real estate"],["XLU","Utilities"],["XLC","Comm. services"]];

  async function get_market_breadth() {
    if (!r) return { error: "market internals unavailable" };
    let last = null, inputs = null;
    try { last = await r.get("mkt:pulse:last"); } catch (_) { last = null; }
    try { inputs = await r.get("mkt:pulse:inputs"); } catch (_) { inputs = null; }
    if (typeof last === "string") { try { last = JSON.parse(last); } catch (_) { last = null; } }
    if (typeof inputs === "string") { try { inputs = JSON.parse(inputs); } catch (_) { inputs = null; } }

    let sectors = null;
    try {
      const syms = SECTORS.map(([s]) => s).join(",");
      const resp = await get(`https://query1.finance.yahoo.com/v8/finance/spark?symbols=${syms}&range=1d&interval=15m`,
                             { "User-Agent": "Mozilla/5.0" });
      if (resp && resp.ok) {
        const j = await resp.json();
        sectors = [];
        for (const [sym, label] of SECTORS) {
          const s = j?.spark?.result?.find((x) => x.symbol === sym)?.response?.[0]?.meta ||
                    j?.[sym]?.[0]?.meta || null;
          const px = s?.regularMarketPrice, prev = s?.chartPreviousClose || s?.previousClose;
          if (px && prev) sectors.push({ sector: label, sym, changePct: Math.round((px / prev - 1) * 10000) / 100 });
        }
        sectors.sort((a, b) => b.changePct - a.changePct);
        if (!sectors.length) sectors = null;
      }
    } catch (_) { sectors = null; }

    if (!last && !inputs && !sectors) return { error: "no breadth data available right now" };
    return {
      pulse: last || null,
      breadthInputs: inputs || null,
      sectorsToday: sectors,
      note: "breadth and put/call are PARTICIPATION, never a direction call; sectors are the " +
            "day's move so far. Quote the as-of on anything dated.",
    };
  }

  async function get_vol_history({ series } = {}) {
    if (!r) return { error: "vol history unavailable" };
    let snap = null;
    try { snap = await r.get("novo:vol"); } catch (_) { snap = null; }
    if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (_) { snap = null; } }
    if (!snap || !snap.series) return { error: "no volatility history published yet" };
    // The monthly close arrays are chart food — hundreds of points per series that add nothing
    // to a percentile answer. The summary stats are the read.
    const strip = ({ monthly, ...rest } = {}) => rest;
    const note =
      "Daily closes. pct_all ranks the CURRENT level against the series' full history " +
      "(VIX since 1990); pct_2y against the last two years — quote both when they disagree. " +
      "last_date is the newest close, which on an active session is usually yesterday's.";
    const want = series ? String(series).trim().toUpperCase() : null;
    if (want) {
      const e = snap.series[want];
      if (!e) return { error: `no history for ${want}`, have: Object.keys(snap.series) };
      return { as_of: snap.as_of, series: { [want]: strip(e) },
               termStructure: snap.term_structure || null, note };
    }
    const out = {};
    for (const [k, v] of Object.entries(snap.series)) out[k] = strip(v);
    return { as_of: snap.as_of, series: out, termStructure: snap.term_structure || null, note };
  }

  // Same series list api/positioning.js serves the public page from — each name checked for a
  // 2026 report date, because the CFTC leaves renamed series in the dataset still answering.
  const COT_MARKETS = [
    ["S&P 500", "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE", "SPY"],
    ["Nasdaq 100", "NASDAQ MINI - CHICAGO MERCANTILE EXCHANGE", "QQQ"],
    ["Russell 2000", "RUSSELL E-MINI - CHICAGO MERCANTILE EXCHANGE", "IWM"],
    ["VIX", "VIX FUTURES - CBOE FUTURES EXCHANGE", null],
  ];

  async function get_futures_positioning() {
    const CFTC = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const one = async ([label, market, etf]) => {
      try {
        const url = `${CFTC}?$where=${encodeURIComponent(`market_and_exchange_names='${market}'`)}` +
                    `&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=6`;
        const resp = await get(url, { "User-Agent": "novo-options.trade" });
        if (!resp || !resp.ok) return null;
        const rows = await resp.json();
        if (!Array.isArray(rows) || !rows.length) return null;
        const pts = rows.map((x) => {
          const sl = num(x.noncomm_positions_long_all), ss = num(x.noncomm_positions_short_all);
          const cl = num(x.comm_positions_long_all), cs = num(x.comm_positions_short_all);
          return {
            date: x.report_date_as_yyyy_mm_dd ? String(x.report_date_as_yyyy_mm_dd).slice(0, 10) : null,
            openInterest: num(x.open_interest_all),
            specNet: sl != null && ss != null ? sl - ss : null,
            commNet: cl != null && cs != null ? cl - cs : null,
          };
        }).filter((x) => x.date).reverse();
        if (!pts.length) return null;
        const last = pts[pts.length - 1];
        const prev = pts.length > 1 ? pts[pts.length - 2] : null;
        // A renamed series goes quiet rather than erroring — drop anything stale instead of
        // publishing it as current. 45 days covers a holiday gap in a weekly release.
        const ageDays = (Date.now() - Date.parse(last.date + "T00:00:00Z")) / 86400000;
        if (!Number.isFinite(ageDays) || ageDays > 45) return null;
        return {
          market: label, etf, reportDate: last.date,
          specNet: last.specNet, commNet: last.commNet, openInterest: last.openInterest,
          specChangeWk: last.specNet != null && prev && prev.specNet != null
            ? last.specNet - prev.specNet : null,
          specNetTrend: pts.map((p) => [p.date, p.specNet]),
        };
      } catch (_) { return null; }
    };
    const markets = (await Promise.all(COT_MARKETS.map(one))).filter(Boolean);
    if (!markets.length) return { error: "CFTC is unreachable right now" };
    return {
      source: "CFTC Commitments of Traders",
      markets,
      note: "Weekly, released Friday for the prior TUESDAY — days old by design; always give " +
            "reportDate. spec = non-commercial (funds), comm = hedgers, in contracts. A crowded " +
            "net is fuel for a move the other way, never a direction call.",
    };
  }

  async function get_crypto_history({ coin } = {}) {
    const h = await _cryptoHist();
    if (!h) return { error: "the crypto history rollup has not been published yet" };
    const ageMin = h.received ? Math.round((Date.now() - h.received) / 60000) : null;
    const base = {
      asOfMinutesAgo: ageMin,
      baseRates: h.base_rates || {},
      openClaims: h.open_claims,
      coverage: h.coverage || {},
      note: "percentiles are the CURRENT value's rank within that series' own full history. " +
            "A null percentile means fewer than 8 samples - too thin to rank, and I should " +
            "say the sample is thin rather than quote a number. On baseRates, n_claims is NOT " +
            "the evidence: a claim fires every pass, so one coin in one session makes dozens " +
            "that all resolve together. n_cells (distinct coin-day) is the real denominator. " +
            "If trustworthy is false I must NOT quote the hit rate as a base rate - I give the " +
            "cell count and the caveat, and say it is an early reading.",
    };
    const code = String(coin || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) return { ...base, coinsCovered: Object.keys(h.coins).length };
    const c = h.coins[code];
    if (!c) {
      return { ...base, error: `no history for ${code}`,
               coinsCovered: Object.keys(h.coins).length };
    }
    return { coin: code, ...base, history: c };
  }

  async function get_crypto_map({ coin }) {
    const code = String(coin || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code) return { error: "name a coin, e.g. BTC" };
    const snap = await _cryptoSnap();
    if (!snap) return { error: "the crypto collector is not reporting right now" };
    const c = snap.coins[code];
    if (!c) {
      return { error: `${code} is not one of the coins Robinhood trades, so I have no map for it`,
               covered: Object.keys(snap.coins).slice(0, 12) };
    }
    const out = {
      coin: code, asOf: snap.as_of, band: c.band, confidence: c.confidence,
      panelsAvailable: c.panels, price: c.price,
      note: "panels are granted by measured inputs - if a panel is absent the data is not " +
            "there, and I should say so rather than estimate it.",
    };
    if (c.true_cost) {
      out.robinhoodCost = {
        roundTripPct: c.true_cost.round_trip_pct,
        buySpreadPct: c.true_cost.buy_spread_pct,
        sellSpreadPct: c.true_cost.sell_spread_pct,
        cheapnessRank: c.true_cost.cheapness_rank,
        note: "Robinhood's OWN disclosed markup, read back from its API. Nobody else publishes this.",
      };
    }
    if (c.gamma) {
      out.dealerGamma = {
        settlementBook: c.gamma.settle, expiry: c.gamma.expiry, spot: c.gamma.spot,
        netGex: c.gamma.net_gex, flipZone: c.gamma.flip_zone,
        callWall: c.gamma.call_wall, putWall: c.gamma.put_wall, chainOi: c.gamma.chain_oi,
        note: "Deribit. One contract is 1 coin, not 100. A flip more than ~12% from spot is " +
              "real but not actionable - say so rather than quoting it as a level.",
      };
      // EVERY book's headline (crypto-settled, OKX, and the US ETF book where one exists),
      // with max pain and the put/call OI ratio. Two venues disagreeing about the regime is
      // a signal the primary-book summary above cannot show. An ETF book is a DIFFERENT
      // instrument at a different price - never quote its walls under the coin's own price.
      if (Array.isArray(c.gamma.venues) && c.gamma.venues.length) {
        out.dealerGamma.allBooks = c.gamma.venues.map((v) => ({
          settle: v.settle, spot: v.spot, netGex: v.net_gex, flipZone: v.flip_zone,
          callWall: v.call_wall, putWall: v.put_wall, maxPain: v.max_pain,
          putCallOiRatio: v.pc_oi_ratio, chainOi: v.chain_oi,
        }));
      }
    }
    // DVOL - the crypto VIX, Deribit-published for BTC and ETH only. DVOL/20 is the implied
    // DAILY move, the cleanest expected-move read in this market.
    if (c.dvol) out.dvol = { value: c.dvol.value, impliedDailyMovePct: c.dvol.implied_daily_pct };
    // Near-the-money put-vs-call IV on the front book (strikes within 10% of spot) - the
    // crypto equivalent of the equity map's put/call skew. Positive skew_pts = puts bid.
    if (c.skew) {
      out.skew = { putIvPct: c.skew.put_iv_pct, callIvPct: c.skew.call_iv_pct,
                   skewPts: c.skew.skew_pts };
    }
    if (c.positioning) {
      out.leverage = {
        fundingByVenue: c.positioning.funding,
        openInterestByVenue: c.positioning.open_interest,
        totalOiUsd: c.positioning.total_oi_usd,
        note: "PER VENUE and never averaged - venues have different participants, and the " +
              "disagreement between them is itself the read.",
      };
    }
    if (c.readings && c.readings.length) out.myRecentReads = c.readings;
    return out;
  }

  async function get_crypto_breadth() {
    const snap = await _cryptoSnap();
    if (!snap) return { error: "the crypto collector is not reporting right now" };
    const b = snap.breadth || {};
    const h = snap.health || {};
    return {
      asOf: snap.as_of, coins: Object.keys(snap.coins).length,
      medianRoundTripPct: b.median_round_trip_pct,
      cheapestToTrade: b.cheapest, priciestToTrade: b.priciest,
      largestOpenInterest: b.largest_oi,
      liquidations24h: h.liquidations_24h || [],
      myBaseRates: h.base_rates || [],
      note: "cost figures are Robinhood's own disclosed markup. Liquidations are forced flow, " +
            "not positioning. Base rates are my own scored claims, self-reported - always " +
            "give the sample size with any rate.",
    };
  }

  return {
    get_chain_token,
    get_chain_alerts,
    get_dealer_levels, get_gamma_profile, get_session_history, search_journal,
    get_quote, get_economic_calendar, get_earnings_dates, get_track_record, search_news,
    get_base_rates, get_recent_reads, get_market_internals,
    get_vol_history, get_futures_positioning, get_market_breadth,
    get_crypto_map, get_crypto_breadth, get_crypto_history, get_chain_history,
    describe_archive, query_archive,
  };
}

module.exports = { declarations, makeExecutors, TICKERS };
