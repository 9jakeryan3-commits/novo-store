// api/positioning.js — weekly futures positioning from the CFTC's Commitments of Traders.
//
// PUBLIC DOMAIN. The CFTC's own web policy states its data may be freely distributed and copied,
// which makes this the one genuinely licence-free market dataset on the site — unlike the Yahoo
// and Cboe pulls, which are accepted risk rather than permitted redisplay.
//
// Why it belongs on NoVo: the dealer map reads OPTIONS positioning intraday. COT reads FUTURES
// positioning weekly — who is long and short the index itself, split into speculators
// (non-commercial) and hedgers (commercial). Different instrument, different clock, same question.
// It is a genuine complement rather than a repeat, and no dealer-gamma vendor publishes it.
//
// COT is released Friday afternoon for the prior Tuesday, so it is always days old by design.
// The page says so; there is nothing to hide about a dataset whose lag is statutory.

const CFTC = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";

// CFTC renames these series over the years and leaves the retired names in the dataset still
// answering queries — the obvious "E-MINI S&P 500 STOCK INDEX" stopped updating in Feb 2022 and
// "E-MINI NASDAQ 100 STOCK INDEX" in 1999. Each name below was checked for a 2026 report date.
const MARKETS = [
  ["S&P 500", "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE", "SPY"],
  ["Nasdaq 100", "NASDAQ MINI - CHICAGO MERCANTILE EXCHANGE", "QQQ"],
  ["Russell 2000", "RUSSELL E-MINI - CHICAGO MERCANTILE EXCHANGE", "IWM"],
  ["VIX", "VIX FUTURES - CBOE FUTURES EXCHANGE", null],
];

// A renamed series goes quiet rather than erroring, so anything staler than this is dropped
// instead of published as current. Releases are weekly; 45 days covers a holiday gap.
const MAX_STALE_DAYS = 45;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

async function series(marketName, weeks = 12) {
  const url = `${CFTC}?$where=${encodeURIComponent(`market_and_exchange_names='${marketName}'`)}` +
              `&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${weeks}`;
  const r = await fetch(url, { headers: { "User-Agent": "novo-options.trade" } });
  if (!r.ok) return null;
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows.map((x) => {
    const specL = num(x.noncomm_positions_long_all), specS = num(x.noncomm_positions_short_all);
    const commL = num(x.comm_positions_long_all), commS = num(x.comm_positions_short_all);
    return {
      date: x.report_date_as_yyyy_mm_dd ? String(x.report_date_as_yyyy_mm_dd).slice(0, 10) : null,
      openInterest: num(x.open_interest_all),
      specNet: specL != null && specS != null ? specL - specS : null,
      commNet: commL != null && commS != null ? commL - commS : null,
    };
  }).filter((x) => x.date).reverse();   // oldest first, so a chart reads left to right
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  // Weekly data — cache hard. A miss costs four upstream calls; a hit costs nothing.
  res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
  try {
    const out = [];
    for (const [label, market, etf] of MARKETS) {
      let points = null;
      try { points = await series(market); } catch (_) { points = null; }
      if (!points || !points.length) continue;
      const last = points[points.length - 1];
      const prev = points.length > 1 ? points[points.length - 2] : null;
      const ageDays = (Date.now() - Date.parse(last.date + "T00:00:00Z")) / 86400000;
      if (!Number.isFinite(ageDays) || ageDays > MAX_STALE_DAYS) continue;
      out.push({
        label, etf, asof: last.date,
        specNet: last.specNet, commNet: last.commNet, openInterest: last.openInterest,
        specChange: last.specNet != null && prev && prev.specNet != null ? last.specNet - prev.specNet : null,
        points,
      });
    }
    if (!out.length) return res.status(200).json({ ok: false, note: "CFTC unavailable", markets: [] });
    return res.status(200).json({ ok: true, source: "CFTC Commitments of Traders", updated: Date.now(), markets: out });
  } catch (e) {
    return res.status(200).json({ ok: false, note: "CFTC unavailable", markets: [] });
  }
};
