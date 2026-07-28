// Trending US tickers (Yahoo trending) with live price + change. PUBLIC data. CDN-cached 5m.
// v7/quote is 401 without a crumb now, so price/change come from the chart endpoint (same as api/quotes.js).

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
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
  try {
    let syms = [];
    try {
      const r = await fetch("https://query1.finance.yahoo.com/v1/finance/trending/US?count=15", {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const q = (await r.json())?.finance?.result?.[0]?.quotes || [];
      syms = q.map((x) => x.symbol).filter(Boolean).slice(0, 12);
    } catch { syms = []; }
    // Fallback to the most-watched names if trending is empty/blocked, so the section never renders bare.
    if (!syms.length) syms = ["SPY", "QQQ", "NVDA", "TSLA", "AAPL", "MSFT", "AMD", "META"];
    const out = (await Promise.all(syms.map(chartQuote))).filter(Boolean).slice(0, 8);
    res.status(200).json({ updated: Date.now(), stocks: out });
  } catch {
    res.status(200).json({ updated: Date.now(), stocks: [] });
  }
};
