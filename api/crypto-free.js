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
  // Price, 24h change and an 8-point sparkline. All three are free on every exchange in
  // the world, so they are free here - and one call to this endpoint is what drives the
  // live crypto strip on /crypto. The spark is downsampled to the 8 points the strip's
  // polyline draws; the full series stays behind the paywall with the rest of the history.
  const list = Object.entries(snap.coins).map(([code, c]) => {
    // `tradable` has to ride along or the filter below silently passes every coin -- which is
    // exactly what happened: the count read 91 on a sentence about what a broker charges.
    const row = { coin: code, band: c.band, price: c.price, tradable: c.tradable !== false };
    if (c.chg && c.chg.d1 != null) row.chg24h = c.chg.d1;
    const sp = c.spark;
    if (Array.isArray(sp) && sp.length >= 8) {
      const step = (sp.length - 1) / 7;
      row.spark = Array.from({ length: 8 }, (_, i) => sp[Math.round(i * step)]);
    }
    return row;
  });
  return res.status(200).json({
    as_of: snap.as_of,
    // Rows in the crypto corpus, reported by the collector that owns it (publish.py build_snapshot).
    // Exposed here so the ENGINE can read it: since the 2026-09-03 cutover the two run in separate
    // containers, so the engine's old _cnt("../Novo-crypto/data/novo_crypto.db") counts a path that
    // does not exist over there and silently returned 0 -- taking ~6.5M rows off the public
    // data-point total on /ai with nothing announcing it. Not a secret: it is a count of how much
    // data exists, exactly like /api/datapoints itself.
    corpus_rows: (snap.corpus_rows == null ? null : snap.corpus_rows),
    // The count used by the "all N coins" copy, which is specifically about COST TO TRADE -- a
    // figure read back from a broker's disclosed markup, so it exists only for coins that broker
    // lists. It is NOT the size of the map: the map is this plus every options-book coin without a
    // retail listing, plus the on-chain surface. Reporting the full count here would have rewritten
    // those cost claims into something false about a coin you cannot buy at retail.
    coins: list.filter(function (c) { return c.tradable !== false; }).length,
    mapped: list.length,
    // How many carry a real options book, so the "six cryptos" claim stops being hand-typed.
    books: list.filter(function (c) { return c.band === 'A'; }).length,
    // Coins with a book OR leverage positioning: band A + band B. A THIRD number near 90 and
    // not interchangeable with the other two -- it includes TRX (Deribit book, no retail
    // listing) and excludes USDG (band C stablecoin, neither), which is the opposite membership
    // to `coins`. They both read 90 today by coincidence; any copy saying "a book or leverage
    // positioning" must read this one or it will start counting a coin that has neither.
    bands: list.filter(function (c) { return c.band === 'A' || c.band === 'B'; }).length,
    list,
    // COUNT ONLY, no rows. The on-chain half is part of the subscription like everything else
    // here; what is free is knowing how much of it there is. The build reads this to keep the
    // marketing count honest instead of it being typed once and going stale.
    // `chain` IS THE EXACT LIVE COUNT AND MUST STAY THAT. coin-count.js writes it into the page
    // verbatim for a live reader, and it has to equal what the dashboard draws -- reconciling
    // those two was the whole point of that code, and serving anything else here silently
    // un-fixes it (it did, for one deploy: the hero read 144 against a dashboard showing 194).
    chain: Array.isArray(snap.chain) ? snap.chain.length : 0,
    // The SMOOTHED figure, ONLY for the build-time copy that floors to a fifty. The live count
    // crosses those band edges constantly -- 131-234 across one day, 62 band flips with nothing
    // real behind them -- and a trailing minimum over clean collector passes can only
    // under-claim, so an "N+ tokens" claim holds at every moment of its window. Anything that
    // prints an EXACT number must read `chain`; only a floored claim should read this.
    chain_smoothed: typeof snap.chain_count === 'number'
      ? snap.chain_count : (Array.isArray(snap.chain) ? snap.chain.length : 0),
    chain_networks: Array.isArray(snap.chain)
      ? [...new Set(snap.chain.map((t) => t.network))].length : 0,
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
