// PUBLIC market-data feed for /market-data — PUBLIC / public-derived data ONLY. Deliberately carries NO
// proprietary dealer-map data (net GEX, gamma flip, walls, flow, The Line, analogues): those stay behind the
// Analyst/Trader paywall. This function computes, entirely from public sources:
//   • per-index FEAR gauges  — VIX (S&P), VXN (Nasdaq), RVX (Russell): current value + trailing-1y percentile
//   • NoVo MARKET PULSE      — a 0-100 sentiment score from PUBLIC inputs only (vol percentiles + S&P momentum),
//                              independent of the paid engine so a single number can't be traded off
//   • FEAR HISTORY           — VIX now / yesterday / 1wk / 1mo (percentile + label)
// Vol history/quotes come from CBOE's free delayed CDN (Yahoo delisted ^RVX); S&P momentum from Yahoo ES=F.
// CDN-cached 5 min (the vol quotes are ~15-min delayed anyway).

const CBOE_HIST = (s) => `https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/_${s}.json`;
const CBOE_QUOTE = (s) => `https://cdn.cboe.com/api/global/delayed_quotes/quotes/_${s}.json`;

async function jget(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// trailing ~1y daily closes (last 252) for a CBOE vol index
async function volCloses(sym) {
  try {
    const rows = (await jget(CBOE_HIST(sym)))?.data || [];
    const cl = [];
    for (const row of rows.slice(-260)) {
      const v = parseFloat(row?.close);
      if (v > 0) cl.push(v);
    }
    return cl.slice(-252);
  } catch { return []; }
}

async function volCurrent(sym) {
  try {
    const d = (await jget(CBOE_QUOTE(sym)))?.data || {};
    return parseFloat(d.current_price || d.close || 0) || 0;
  } catch { return 0; }
}

const pctRank = (arr, v) => (arr.length ? Math.round((100 * arr.filter((c) => c <= v).length) / arr.length) : null);
const volTag = (p) => (p == null ? "" : p <= 15 ? "very low" : p <= 35 ? "low" : p <= 65 ? "normal" : p <= 85 ? "elevated" : "high");

async function fearFor(sym, closes) {
  const cur = await volCurrent(sym);
  if (!cur || !closes.length) return null;
  const pct = pctRank(closes, cur);
  return { sym, value: Math.round(cur * 10) / 10, pct, tag: volTag(pct) };
}

// S&P momentum, 0-100 = where today's ES sits in its trailing-120-session range (higher = greedier)
async function spMomentum() {
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/ES=F?interval=1d&range=1y";
    const res = (await jget(url))?.chart?.result?.[0];
    const closes = (res?.indicators?.quote?.[0]?.close || []).filter((c) => c != null);
    const cur = res?.meta?.regularMarketPrice || closes[closes.length - 1];
    if (!cur || closes.length < 30) return null;
    const win = closes.slice(-120);
    const lo = Math.min(...win), hi = Math.max(...win);
    if (hi <= lo) return 50;
    return Math.max(0, Math.min(100, Math.round(((cur - lo) / (hi - lo)) * 100)));
  } catch { return null; }
}

const pulseLabel = (p) =>
  p == null ? "—" : p < 25 ? "Extreme Fear" : p < 45 ? "Fear" : p < 55 ? "Neutral" : p < 75 ? "Greed" : "Extreme Greed";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
  try {
    const [vixC, vxnC, rvxC] = await Promise.all([volCloses("VIX"), volCloses("VXN"), volCloses("RVX")]);
    const [vix, vxn, rvx, mom] = await Promise.all([
      fearFor("VIX", vixC), fearFor("VXN", vxnC), fearFor("RVX", rvxC), spMomentum(),
    ]);

    // NoVo Market Pulse: 50% inverted average vol percentile (fear) + 50% S&P momentum. Public inputs only.
    const volPcts = [vix, vxn, rvx].filter(Boolean).map((f) => f.pct);
    const avgVol = volPcts.length ? volPcts.reduce((a, b) => a + b, 0) / volPcts.length : null;
    let pulse = null;
    if (avgVol != null && mom != null) pulse = Math.round(0.5 * (100 - avgVol) + 0.5 * mom);
    else if (avgVol != null) pulse = Math.round(100 - avgVol);
    else if (mom != null) pulse = mom;

    // Fear history from the VIX 1y closes: now / yesterday / ~1wk / ~1mo, each ranked in the same window.
    const hist = {};
    if (vixC.length) {
      const at = (idxFromEnd) => {
        const i = vixC.length - 1 - idxFromEnd;
        if (i < 0) return null;
        const v = vixC[i], p = pctRank(vixC, v);
        return { value: Math.round(v * 10) / 10, pct: p, tag: volTag(p) };
      };
      hist.now = vix ? { value: vix.value, pct: vix.pct, tag: vix.tag } : at(0);
      hist.yesterday = at(1);
      hist.week = at(5);
      hist.month = at(21);
    }

    res.status(200).json({
      updated: Date.now(),
      pulse: pulse == null ? null : { score: pulse, label: pulseLabel(pulse) },
      fear: { SPY: vix, QQQ: vxn, IWM: rvx },
      momentum: mom,
      history: hist,
    });
  } catch (e) {
    res.status(200).json({ updated: Date.now(), pulse: null, fear: {}, error: "unavailable" });
  }
};
