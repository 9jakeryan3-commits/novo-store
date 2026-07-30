// PUBLIC market-data feed for /market-data — PUBLIC / public-derived data ONLY. Deliberately carries NO
// proprietary dealer-map data (net GEX, gamma flip, walls, flow, The Line, analogues): those stay behind the
// Analyst/Trader paywall. This function computes, entirely from public sources:
//   • per-index FEAR gauges  — VIX (S&P), VXN (Nasdaq), RVX (Russell): current value + trailing-1y percentile
//   • NoVo MARKET PULSE      — a 0-100 sentiment score from PUBLIC inputs only (vol percentiles + S&P momentum),
//                              independent of the paid engine so a single number can't be traded off
//   • FEAR HISTORY           — VIX now / yesterday / 1wk / 1mo (percentile + label)
// Vol history/quotes come from CBOE's free delayed CDN (Yahoo delisted ^RVX); S&P momentum from Yahoo ES=F.
// CDN-cached 5 min (the vol quotes are ~15-min delayed anyway).

const { kv } = require("./_kv");

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

// S&P momentum vs its 125-day moving average (CNN's "market momentum" method), 0-100. Being near a range HIGH
// isn't greed by itself — distance above/below the trend is. ±10% from the MA maps to 100/0; at the MA = 50.
// (Sitting at the top of the range but only ~4% above a rising MA is mildly extended, not extreme greed.)
async function spMomentum() {
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/ES=F?interval=1d&range=1y";
    const res = (await jget(url))?.chart?.result?.[0];
    const closes = (res?.indicators?.quote?.[0]?.close || []).filter((c) => c != null);
    const cur = res?.meta?.regularMarketPrice || closes[closes.length - 1];
    if (!cur || closes.length < 30) return null;
    const tail = closes.slice(-125);
    const ma = tail.reduce((a, b) => a + b, 0) / tail.length;
    if (!(ma > 0)) return 50;
    const devPct = (cur / ma - 1) * 100;
    return Math.max(0, Math.min(100, Math.round(50 + (devPct / 10) * 50)));
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

    // NoVo's OWN internals, published by the engine (breadth from the ~50-stock leader basket + SPY put/call).
    // These are the very factors CNN uses that aren't free elsewhere — NoVo has them from its own feed. Folded in
    // when fresh (<30m); absent (engine offline) → the gauge falls back to vol + momentum. Aggregate sentiment
    // only, never the dealer map.
    let breadth = null, putcall = null;
    try {
      const r = kv();
      if (r) {
        let p = await r.get("mkt:pulse:inputs");
        if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
        if (p && Date.now() - (p.ts || 0) < 1800000) {
          if (typeof p.breadth === "number") breadth = p.breadth;   // 0-100, 50 = neutral (higher = more advancers)
          if (typeof p.putcall === "number") putcall = p.putcall;   // SPY put/call ratio
        }
      }
    } catch {}
    // FREEZE (like VIX/skew): breadth comes from the live leader basket and its key lapses after the close, while
    // put/call is recomputed off-hours — so a factor could vanish and the gauge would drop from 4 tiles to 3.
    // Fall back to the last-known value (pulse-ingest holds it 26h) for whichever input the current publish is
    // missing, so all four factors always show (frozen at the last session's read off-hours).
    if (breadth == null || putcall == null) {
      try {
        const r = kv();
        if (r) {
          let last = await r.get("mkt:pulse:last");
          if (typeof last === "string") { try { last = JSON.parse(last); } catch { last = null; } }
          if (last && typeof last === "object") {
            if (breadth == null && typeof last.breadth === "number") breadth = last.breadth;
            if (putcall == null && typeof last.putcall === "number") putcall = last.putcall;
          }
        }
      } catch {}
    }

    // Each factor is a 0-100 GREED score. volatility = inverted VIX/VXN/RVX percentile (the fear anchor, multi-
    // index catches Nasdaq/Russell fear a VIX-only gauge misses). put/call: >1 = defensive (fear) → lower score.
    const volPcts = [vix, vxn, rvx].filter(Boolean).map((f) => f.pct);
    const avgVol = volPcts.length ? volPcts.reduce((a, b) => a + b, 0) / volPcts.length : null;
    const volScore = avgVol != null ? Math.round(100 - avgVol) : null;
    const pcScore = putcall != null ? Math.max(0, Math.min(100, Math.round(50 - (putcall - 1.0) * 80))) : null;

    // Weights lean toward the FEAR anchors (volatility + put/call) over the trend-followers (momentum + breadth),
    // so a market holding above trend while vol is bid + options are defensive reads Neutral/Fear, not Greed.
    const factors = [];
    if (volScore != null) factors.push({ key: "volatility", score: volScore, w: 0.35 });
    if (pcScore != null) factors.push({ key: "putcall", score: pcScore, w: 0.25 });
    if (breadth != null) factors.push({ key: "breadth", score: Math.round(breadth), w: 0.20 });
    if (mom != null) factors.push({ key: "momentum", score: mom, w: 0.20 });
    let pulse = null;
    if (factors.length) {
      const tw = factors.reduce((a, f) => a + f.w, 0);
      pulse = Math.round(factors.reduce((a, f) => a + f.score * f.w, 0) / tw);
    }
    const flabel = (k, s) =>
      k === "volatility" ? (s < 35 ? "elevated" : s < 60 ? "normal" : "calm")
      : k === "momentum" ? (s < 35 ? "below trend" : s < 60 ? "at trend" : "above trend")
      : k === "breadth" ? (s < 40 ? "weak" : s < 60 ? "mixed" : "strong")
      : (s < 40 ? "defensive" : s < 60 ? "balanced" : "call-heavy");
    const factorsOut = factors.map((f) => ({ key: f.key, score: f.score, label: flabel(f.key, f.score) }));

    // Fear history from the VIX 1y closes: now / yesterday / ~1wk / ~1mo, each ranked in the same window.
    const hist = {};
    if (vixC.length) {
      const at = (idxFromEnd) => {
        const i = vixC.length - 1 - idxFromEnd;
        if (i < 0) return null;
        const v = vixC[i], p = pctRank(vixC, v);
        return { value: Math.round(v * 10) / 10, pct: p, tag: volTag(p) };
      };
      // (A4.1) CBOE hasn't posted today's close during the live session / early after-hours, so vixC's last row is
      // still YESTERDAY. Detect that (live VIX differs from the last posted close) and shift the offsets back one so
      // 'yesterday' isn't 2 sessions ago. Once today's close posts (last row ≈ live), use the normal offsets.
      const _lastClose = Math.round(vixC[vixC.length - 1] * 10) / 10;
      const _todayPosted = vix && Math.abs((vix.value || 0) - _lastClose) < 0.1;
      const _off = _todayPosted ? 0 : -1;
      hist.now = vix ? { value: vix.value, pct: vix.pct, tag: vix.tag } : at(0);
      hist.yesterday = at(1 + _off);
      hist.week = at(5 + _off);
      hist.month = at(21 + _off);
    }

    res.status(200).json({
      updated: Date.now(),
      pulse: pulse == null ? null : { score: pulse, label: pulseLabel(pulse) },
      factors: factorsOut,
      fear: { SPY: vix, QQQ: vxn, IWM: rvx },
      momentum: mom,
      history: hist,
    });
  } catch (e) {
    res.status(200).json({ updated: Date.now(), pulse: null, fear: {}, error: "unavailable" });
  }
};
