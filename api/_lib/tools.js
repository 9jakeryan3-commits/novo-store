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
      "The CURRENT live dealer positioning read for one ticker: spot, gamma flip, call wall, put wall, net GEX, " +
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
      "Strike-by-strike dealer gamma for one ticker, sampled every few minutes through today's session. Use for " +
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
      "What NoVo has actually logged across past sessions for one ticker, and how many sessions that covers. Use " +
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
      "Semantic search over NoVo's own writing: 1,000+ Journal articles on mechanics, plus NoVo's own logged " +
      "market observations. Use for 'why does X happen', 'what does Y mean', 'what have you seen like this'. Call " +
      "again with a refined query if the first results miss.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        source: {
          type: "string", enum: ["journal", "memory", "any"],
          description: "Mechanics articles (journal), NoVo's own observations (memory), or both (any, default).",
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
        kind: h.s === "memory" ? "NoVo's own read" : "Journal",
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

  return {
    get_dealer_levels, get_gamma_profile, get_session_history, search_journal,
    get_quote, get_economic_calendar, get_earnings_dates, search_news,
  };
}

module.exports = { declarations, makeExecutors, TICKERS };
