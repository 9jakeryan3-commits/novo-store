// api/congress.js — congressional trade disclosures, read side.
//
// Serves what congress-ingest.js banked. No computation of a signal, no ranking by "conviction",
// no follow-the-smart-money framing: this is a disclosure feed and it is presented as one.
//
// ⚠ EVERY ROW CARRIES ITS DISCLOSURE LAG AND THE PAYLOAD CARRIES THE DISTRIBUTION.
// Measured over a 40-filing sample of the live 2026 index: median lag 13 days, p90 32 days, max
// 391. The STOCK Act allows 45. A reader who sees "Rep. X bought NVDA" without the lag beside it
// will read a five-week-old trade as news — so `lag_days` is on the row, `lag` percentiles are on
// the payload, and the UI is expected to show them. This is the one way this feature could
// mislead someone into a position, and it is handled in the data, not left to the front end.
//
// ⚠ `unreadable` IS PART OF THE ANSWER, NOT AN ERROR COUNT.
// ~12% of filings are scans of handwritten forms with no text layer. They are counted here so the
// feed can say what it cannot see. An absence in this data means "not disclosed electronically",
// never "did not trade".

const { kv } = require('./_kv.js');
const { lagDays } = require('./_lib/congress.js');

const MAX_ROWS = 400;

module.exports = async function handler(req, res) {
  const r = kv();
  res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
  if (!r) return res.status(503).json({ error: 'kv unavailable' });

  const nowYear = new Date().getUTCFullYear();
  const years = [nowYear, nowYear - 1];
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || '', 10) || 100, MAX_ROWS));
  const ticker = String(req.query.ticker || '').trim().toUpperCase();
  const side = String(req.query.side || '').trim().toLowerCase();
  const stocksOnly = req.query.stocks !== '0';

  let rows = [];
  let unreadable = 0;
  let meta = null;
  for (const y of years) {
    const raw = await r.lrange(`congress:tx:${y}`, -4000, -1).catch(() => []);
    for (const s of raw || []) {
      try { rows.push(typeof s === 'string' ? JSON.parse(s) : s); } catch (_) { /* skip */ }
    }
    unreadable += Number(await r.scard(`congress:unparsed:${y}`).catch(() => 0)) || 0;
    if (!meta) {
      const m = await r.get(`congress:meta:${y}`).catch(() => null);
      if (m) { try { meta = typeof m === 'string' ? JSON.parse(m) : m; } catch (_) { /* keep null */ } }
    }
  }

  rows.forEach((x) => { x.lag_days = lagDays(x); });

  // The lag distribution is computed over EVERYTHING held, before any filter, so a reader who
  // narrows to one ticker still sees the honest shape of the feed rather than a lag summary of
  // three rows.
  const lags = rows.map((x) => x.lag_days).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const at = (p) => (lags.length ? lags[Math.min(lags.length - 1, Math.floor(lags.length * p))] : null);
  const lag = lags.length
    ? { n: lags.length, median: at(0.5), p90: at(0.9), max: lags[lags.length - 1], statutory_limit: 45 }
    : null;

  let out = rows;
  if (stocksOnly) out = out.filter((x) => x.ticker && x.asset_code === 'ST');
  if (ticker) out = out.filter((x) => x.ticker === ticker);
  if (side === 'buy' || side === 'sell') out = out.filter((x) => x.type === side);

  // newest disclosure first - this is a filing feed, so it orders by when it became public
  out.sort((a, b) => String(b.notification_date || '').localeCompare(String(a.notification_date || ''))
                  || String(b.transaction_date || '').localeCompare(String(a.transaction_date || '')));

  const total = out.length;
  out = out.slice(0, limit);

  // A plain count of the names appearing most often in the window. Deliberately not called
  // "most bought" or given a rank score: the disclosed amount is a BAND, so the size of any of
  // these is unknown and summing them would invent a number nobody filed.
  const tally = {};
  for (const x of out) {
    if (!x.ticker) continue;
    const t = (tally[x.ticker] = tally[x.ticker] || { ticker: x.ticker, buys: 0, sells: 0, filings: 0 });
    if (x.type === 'buy') t.buys++; else if (x.type === 'sell') t.sells++;
    t.filings++;
  }
  const top = Object.values(tally).sort((a, b) => b.filings - a.filings).slice(0, 12);

  return res.status(200).json({
    source: 'Clerk of the U.S. House of Representatives — Periodic Transaction Reports',
    source_url: 'https://disclosures-clerk.house.gov/',
    chamber: 'house',
    disclaimer: 'Disclosures, not trades in real time. Members have up to 45 days to file under the STOCK Act, and amounts are disclosed as ranges, never exact figures.',
    lag,
    unreadable_filings: unreadable,
    unreadable_note: unreadable
      ? 'Filings submitted on paper and scanned. They have no text layer and cannot be read automatically, so they are absent from the rows below — absence here is not evidence a member did not trade.'
      : null,
    count: out.length,
    total_matching: total,
    top,
    rows: out,
    updated: meta ? meta.last_run : null,
    meta,
  });
};
