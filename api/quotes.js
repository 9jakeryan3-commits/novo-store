// Live markets quotes for the site-wide ticker. Fetches Yahoo Finance server-side (no API key),
// returns { "SPY": {price, chg}, ... } keyed by the ticker's display names. CDN-cached 60s.
// Best-effort: any symbol that fails is omitted, and the client keeps its last/static value.

const SYMBOLS = [
  ["SPY", "SPY"], ["VIX", "^VIX"], ["S&P 500", "^GSPC"], ["Nasdaq", "^IXIC"],
  ["Russell", "^RUT"], ["Gold", "GC=F"], ["BTC", "BTC-USD"], ["Crude", "CL=F"],
];

function fmt(name, p) {
  if (["S&P 500", "Nasdaq", "Russell", "BTC"].includes(name))
    return Math.round(p).toLocaleString("en-US");
  if (name === "Gold")
    return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return p.toFixed(2);
}

async function one(name, sym) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    const m = j?.chart?.result?.[0]?.meta;
    if (!m) return null;
    const price = m.regularMarketPrice;
    const prev = m.chartPreviousClose ?? m.previousClose;
    if (price == null || prev == null || !prev) return null;
    return { name, price: fmt(name, price), chg: Math.round(((price - prev) / prev) * 10000) / 100 };
  } catch { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  const results = await Promise.all(SYMBOLS.map(([n, s]) => one(n, s)));
  const out = {};
  for (const q of results) if (q) out[q.name] = { price: q.price, chg: q.chg };
  res.status(200).json(out);
};
