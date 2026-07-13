// Live markets quotes for the site-wide ticker. Fetches Yahoo Finance server-side (no API key),
// returns { "SPY": {price, chg}, ... } keyed by the ticker's display names. CDN-cached 60s.
// Best-effort: any symbol that fails is omitted, and the client keeps its last/static value.

// Equity indices use their E-mini FUTURES (ES/NQ/YM/RTY) so they update ~24/5 (Sun 6pm → Fri 5pm ET) instead
// of freezing at the 4pm cash close. Gold/Crude are already futures (24/5); BTC is 24/7; Dollar (ICE index)
// trades extended hours; 10Y stays the cash yield (no clean 24/5 yield on Yahoo). Nasdaq futures = the
// Nasdaq-100 (NQ), so it reads higher than the cash Composite — expected.
const SYMBOLS = [
  ["SPY", "SPY"], ["VIX", "^VIX"], ["S&P 500", "ES=F"], ["Nasdaq", "NQ=F"],
  ["Russell", "RTY=F"], ["Gold", "GC=F"], ["BTC", "BTC-USD"], ["Crude", "CL=F"],
  ["Dow", "YM=F"], ["Dollar", "DX-Y.NYB"], ["10Y", "^TNX"],
];

function fmt(name, p) {
  if (["S&P 500", "Nasdaq", "Russell", "BTC", "Dow"].includes(name))
    return Math.round(p).toLocaleString("en-US");
  if (name === "Gold")
    return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (name === "10Y")
    return p.toFixed(2) + "%";   // ^TNX is the 10-year yield in percent (e.g. 4.57%)
  return p.toFixed(2);
}

async function one(name, sym) {
  try {
    // range=5d (not 1d): a 1d range mis-reports chartPreviousClose == regularMarketPrice for FUTURES
    // (GC=F / CL=F) → their change zeroed out. Derive the prior close from the daily-closes array instead.
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const m = res?.meta;
    if (!m || m.regularMarketPrice == null) return null;
    const rmp = m.regularMarketPrice;
    // Live price, extended-hours aware: during pre/after-hours a CASH instrument's regularMarketPrice freezes at
    // the last regular close, so it drifts stale while the 24/5 futures keep moving (SPY reading green while the
    // S&P future is red). Use the pre/post-market print when the regular session is closed. Futures report
    // marketState 'REGULAR' around the clock, so this is a no-op for them.
    const st = m.marketState;
    let price = rmp;
    if ((st === "PRE" || st === "PREPRE") && m.preMarketPrice != null) price = m.preMarketPrice;
    else if ((st === "POST" || st === "POSTPOST" || st === "CLOSED") && m.postMarketPrice != null) price = m.postMarketPrice;
    const closes = (res?.indicators?.quote?.[0]?.close || []).filter(c => c != null);
    // Prior settled close: referenced to the DAILY bar (rmp), independent of the extended-hours price above. If
    // the last daily bar is essentially the regular price, the settled prior close is the bar before it;
    // otherwise the live tick isn't in the array yet, so the last daily close IS the prior close.
    let prev = null;
    if (closes.length >= 2) {
      const last = closes[closes.length - 1];
      prev = (Math.abs(last - rmp) / rmp < 0.0005) ? closes[closes.length - 2] : last;
    }
    if (prev == null) prev = m.chartPreviousClose ?? m.previousClose;
    if (prev == null || !prev) return null;
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
