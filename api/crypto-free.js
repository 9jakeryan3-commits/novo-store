// api/crypto-free.js - the PUBLIC crypto read.
//
// House rule: give away what the market already gives away, sell what the market sells.
// So this endpoint was drawn from what competitors actually publish for free, checked
// rather than assumed:
//
//   FREE ELSEWHERE, therefore free here
//     * funding rates, open interest, 24h liquidations   - CoinGlass free tier, Coinalyze, Velo
//     * BTC/ETH gamma SUMMARY off the public Deribit API - cryptogamma.io publishes this free
//     * spot price                                        - every exchange API
//
//   PAID ELSEWHERE (or nowhere), therefore sold
//     * history of any of it        - CoinGlass locks 6/12/24-month; Laevitas gives 1 week
//     * gamma BY STRIKE, walls, flip - GammaFlip charges $39
//     * gamma on SOL/XRP/AVAX/HYPE   - GammaFlip charges; AVAX and HYPE nobody has at all
//     * the 89-coin breadth board    - CoinGlass locks "all coins"
//     * Robinhood's disclosed markup - exists nowhere at any price
//     * scored claims and base rates - exists nowhere
//     * NoVo                         - the AI tier starts at $149 elsewhere
//
// NOTE the equity map's "the map stays gated" rule deliberately does NOT apply here. That
// rule exists because OPRA options data is licensed. Deribit's is free and public, and a
// free BTC gamma dashboard already exists, so gating a BTC gamma summary would be charging
// for something the market hands out.

const { kv } = require("./_kv");

// Gamma summary is free only where a free equivalent already exists publicly.
const FREE_GAMMA = new Set(["BTC", "ETH"]);

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const r = kv();
  if (!r) return res.status(503).json({ error: "store unavailable" });

  let raw = null;
  try { raw = await r.get("crypto:map:live"); } catch (_) { raw = null; }
  if (!raw) return res.status(503).json({ error: "no live snapshot" });
  let snap = raw;
  if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch { snap = null; } }
  if (!snap || !snap.coins) return res.status(503).json({ error: "snapshot unreadable" });

  const wanted = String((req.query && req.query.coin) || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  function pub(code, c) {
    const out = {
      coin: code, band: c.band, price: c.price,
      // current snapshot only - no series, because history is what this market charges for
      funding: (c.positioning && c.positioning.funding) || [],
      openInterest: (c.positioning && c.positioning.open_interest) || [],
      totalOiUsd: (c.positioning && c.positioning.total_oi_usd) || null,
    };
    // 24h liquidations. This endpoint has always PROMISED these in its note and never
    // returned them, because until the OKX feed landed the table was empty. Totals only:
    // the free tier is the current picture, and the history is the subscription.
    const liq = ((snap.health && snap.health.liquidations_24h) || []).filter(x => x.asset_code === code);
    if (liq.length) {
      let longUsd = 0, shortUsd = 0;
      for (const x of liq) {
        if (x.side === "long") longUsd += x.usd || 0; else shortUsd += x.usd || 0;
      }
      out.liquidations24h = {
        longsForcedOut: Math.round(longUsd),
        shortsForcedOut: Math.round(shortUsd),
        venues: Array.from(new Set(liq.map(x => x.venue))),
      };
    }
    if (c.gamma && FREE_GAMMA.has(code)) {
      // The headline number only. Strikes, walls and the flip are the paid layer.
      out.gammaSummary = {
        settlementBook: c.gamma.settle,
        expiry: c.gamma.expiry,
        spot: c.gamma.spot,
        netGex: c.gamma.net_gex,
        regime: c.gamma.net_gex >= 0 ? "positive - dealers dampen moves"
                                     : "negative - dealers amplify moves",
      };
    }
    return out;
  }

  if (wanted) {
    const c = snap.coins[wanted];
    if (!c) return res.status(404).json({ error: `${wanted} is not one of the coins Robinhood trades` });
    return res.status(200).json({
      as_of: snap.as_of, ...pub(wanted, c),
      paid: paidTeaser(wanted, c),
    });
  }

  // The full-universe listing stays deliberately thin: codes, band and price. The
  // cross-sectional read - cheapest to trade, largest OI, breadth - is the paid product,
  // the same way CoinGlass locks "all coins".
  const list = Object.entries(snap.coins).map(([code, c]) => ({
    coin: code, band: c.band, price: c.price,
  }));
  return res.status(200).json({
    as_of: snap.as_of, coins: list.length, list,
    note: "Current funding, open interest and 24h liquidations are free per coin. " +
          "Gamma by strike, walls, the flip zone, cost-to-trade, history and NoVo are the subscription.",
  });
};

// What this coin has behind the paywall - named, never valued. Tells a visitor what they
// are missing without leaking any of it.
function paidTeaser(code, c) {
  const has = [];
  if (c.gamma) has.push("gamma by strike, call and put walls, flip zone");
  if (c.true_cost) has.push("what a round trip actually costs you on Robinhood");
  if (c.panels && c.panels.indexOf("oi_quadrant") >= 0) has.push("the price/open-interest regime read");
  has.push("history and percentiles");
  has.push("NoVo, who reads this map and the equity dealer map");
  return has;
}
