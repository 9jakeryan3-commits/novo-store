// "Today's movers" — a curated universe of recognizable, high-volume names ranked by the
// biggest absolute % move today. PUBLIC data. CDN-cached 5m.
// (Replaces Yahoo's /v1/finance/trending, whose search-spike ranking surfaced obscure names
//  that read as random on a public page — Jake, 2026-07-28.)
// v7/quote is 401 without a crumb now, so price/change come from the chart endpoint (same as api/quotes.js).

// Widely-followed, liquid tickers. Ranked live by today's move — never a static list.
const UNIVERSE = [
  "SPY", "QQQ", "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "AMD",
  "NFLX", "AVGO", "COIN", "PLTR", "MU", "INTC", "MARA", "SOFI", "F", "BAC",
  "DIS", "UBER", "SMCI", "BABA",
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
      name: m.shortName || m.longName || sym,
      price: Math.round(price * 100) / 100,
      chg: Math.round(((price - prev) / prev) * 10000) / 100,
    };
  } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate, s-maxage=300, stale-while-revalidate=900");
  try {
    const quotes = (await Promise.all(UNIVERSE.map(chartQuote))).filter(Boolean);
    // Biggest absolute movers today, top 8.
    quotes.sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
    const out = quotes.slice(0, 8);
    res.status(200).json({ updated: Date.now(), stocks: out });
  } catch {
    res.status(200).json({ updated: Date.now(), stocks: [] });
  }
};
