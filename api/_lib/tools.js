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
      "and never merged with the live figure beside it. " +
      "session — each with its sample size. Use for 'how often', 'does that actually hold', 'how accurate are you'. This is " +
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
];

// ── executors ──────────────────────────────────────────────────────────────────
// ctx supplies what only analyst-ask.js has: the loaded index and its embed/search pair.
function makeExecutors(ctx = {}) {
  const r = kv();

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
    return {
      tickers: out,
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

  return {
    get_dealer_levels, get_gamma_profile, get_session_history, search_journal,
    get_quote, get_economic_calendar, get_earnings_dates, get_track_record, search_news,
    get_base_rates, get_recent_reads,
  };
}

module.exports = { declarations, makeExecutors, TICKERS };
