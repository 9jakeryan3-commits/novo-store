// api/heatmap.js — the free market heatmap for /market-data.
//
// PUBLIC data only, same rule as api/market-pulse.js: no dealer map, no net GEX, no walls, no flow.
// Eleven SPDR sectors, each with four liquid, recognizable names, priced off the same Yahoo chart
// endpoint api/quotes.js and api/trending.js already use (v7/quote is 401 without a crumb).
//
// Best-effort per symbol: anything that fails is omitted rather than failing the grid, so one bad
// ticker can never blank the section. CDN-cached 5 min — this is a day-move view, not a tape.

const SECTORS = [
  ["Technology",       "XLK",  ["NVDA", "AAPL", "MSFT", "AVGO"]],
  ["Communications",   "XLC",  ["GOOGL", "META", "NFLX", "DIS"]],
  ["Consumer Disc.",   "XLY",  ["AMZN", "TSLA", "HD", "MCD"]],
  ["Financials",       "XLF",  ["JPM", "BAC", "GS", "WFC"]],
  ["Health Care",      "XLV",  ["LLY", "UNH", "JNJ", "ABBV"]],
  ["Energy",           "XLE",  ["XOM", "CVX", "COP", "SLB"]],
  ["Industrials",      "XLI",  ["GE", "CAT", "BA", "UBER"]],
  ["Consumer Staples", "XLP",  ["WMT", "COST", "PG", "KO"]],
  ["Utilities",        "XLU",  ["NEE", "SO", "DUK", "CEG"]],
  ["Real Estate",      "XLRE", ["PLD", "AMT", "SPG", "O"]],
  ["Materials",        "XLB",  ["LIN", "FCX", "NEM", "SHW"]],
];

async function chartQuote(sym) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const res = (await r.json())?.chart?.result?.[0];
    const m = res?.meta;
    if (!m || m.regularMarketPrice == null) return null;
    const price = m.regularMarketPrice;
    // Same prior-close derivation as api/quotes.js: a 1d range mis-reports chartPreviousClose for some
    // symbols, so walk the daily closes and skip the one that IS today's price.
    const closes = (res?.indicators?.quote?.[0]?.close || []).filter((c) => c != null);
    let prev = null;
    if (closes.length >= 2) {
      const last = closes[closes.length - 1];
      prev = Math.abs(last - price) / price < 0.0005 ? closes[closes.length - 2] : last;
    }
    if (prev == null) prev = m.chartPreviousClose ?? m.previousClose;
    if (!prev) return null;
    return {
      sym,
      price: Math.round(price * 100) / 100,
      chg: Math.round(((price - prev) / prev) * 10000) / 100,
    };
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  try {
    const symbols = [];
    for (const [, etf, names] of SECTORS) { symbols.push(etf); symbols.push(...names); }
    const quotes = await Promise.all(symbols.map(chartQuote));
    const by = {};
    quotes.filter(Boolean).forEach((q) => { by[q.sym] = q; });

    const sectors = SECTORS.map(([label, etf, names]) => {
      const head = by[etf];
      const kids = names.map((n) => by[n]).filter(Boolean);
      if (!head && !kids.length) return null;
      return {
        label,
        etf,
        chg: head ? head.chg : Math.round((kids.reduce((a, k) => a + k.chg, 0) / kids.length) * 100) / 100,
        stocks: kids,
      };
    }).filter(Boolean);

    // Strongest sector first — the grid reads as a ranking, not an alphabet.
    sectors.sort((a, b) => b.chg - a.chg);
    res.status(200).json({ updated: Date.now(), sectors });
  } catch {
    res.status(200).json({ updated: Date.now(), sectors: [] });
  }
};
