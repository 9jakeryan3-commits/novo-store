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
  const member = String(req.query.member || '').trim().toLowerCase();   // substring, case-insensitive
  const sort = String(req.query.sort || '').trim().toLowerCase();       // '' (newest) | 'lag'

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
  /* ⚠ SOME FILINGS CARRY A NEGATIVE LAG, AND THAT IS THE SOURCE, NOT THE PARSER.
     Rep. Adrian Smith's PTR reads "P 07/31/2026 07/13/2026" — notified eighteen days BEFORE the
     transaction it discloses. Verified against the PDF text itself rather than assumed. The dates
     stay exactly as filed, because silently repairing a member's disclosure would be inventing a
     record; but they are excluded from the distribution, where a negative would drag the median
     and make "min" meaningless. */
  const lags = rows.map((x) => x.lag_days)
    .filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const inconsistent = rows.filter((x) => Number.isFinite(x.lag_days) && x.lag_days < 0).length;
  const at = (p) => (lags.length ? lags[Math.min(lags.length - 1, Math.floor(lags.length * p))] : null);
  const lag = lags.length
    ? { n: lags.length, median: at(0.5), p90: at(0.9), max: lags[lags.length - 1],
        statutory_limit: 45, dates_inconsistent: inconsistent }
    : null;

  // The by-member tally is built from the same pre-slice, pre-member-filter set the ticker tally
  // uses, so "who is filing most" describes the whole window rather than the current search — a
  // reader searching one member still sees the honest field they are searching within. Counts
  // FILINGS, never dollars, for the same reason `top` does: the amount is a band.
  let memberBase = rows;
  if (stocksOnly) memberBase = memberBase.filter((x) => x.ticker && x.asset_code === 'ST');
  if (side === 'buy' || side === 'sell') memberBase = memberBase.filter((x) => x.type === side);
  const mtally = {};
  for (const x of memberBase) {
    const name = x.member || 'Unknown';
    const m = (mtally[name] = mtally[name] || { member: name, state_district: x.state_district || null,
      buys: 0, sells: 0, filings: 0, tickers: new Set() });
    if (x.type === 'buy') m.buys++; else if (x.type === 'sell') m.sells++;
    m.filings++;
    if (x.ticker) m.tickers.add(x.ticker);
  }
  const members = Object.values(mtally)
    .map((m) => ({ member: m.member, state_district: m.state_district,
      buys: m.buys, sells: m.sells, filings: m.filings, names: m.tickers.size }))
    .sort((a, b) => b.filings - a.filings).slice(0, 20);

  let out = rows;
  if (stocksOnly) out = out.filter((x) => x.ticker && x.asset_code === 'ST');
  if (ticker) out = out.filter((x) => x.ticker === ticker);
  if (side === 'buy' || side === 'sell') out = out.filter((x) => x.type === side);
  if (member) out = out.filter((x) => String(x.member || '').toLowerCase().includes(member));

  if (sort === 'lag') {
    // Slowest disclosures first — the rows most likely to be misread as news. A null lag (a
    // filing whose dates we could not pair) sorts LAST rather than pretending to be 0.
    out.sort((a, b) => (Number.isFinite(b.lag_days) ? b.lag_days : -Infinity)
                     - (Number.isFinite(a.lag_days) ? a.lag_days : -Infinity));
  } else {
    // newest disclosure first - this is a filing feed, so it orders by when it became public
    out.sort((a, b) => String(b.notification_date || '').localeCompare(String(a.notification_date || ''))
                    || String(b.transaction_date || '').localeCompare(String(a.transaction_date || '')));
  }

  const total = out.length;
  /* ⚠ THE TALLY IS COMPUTED BEFORE THE SLICE. Computing it after meant the "top names" strip
     described only the rows on the current page — ask for 4 rows and every ticker showed "1
     filing", which is a true statement about the page and a false one about the data. */
  const forTally = out;
  out = out.slice(0, limit);

  // A plain count of the names appearing most often in the window. Deliberately not called
  // "most bought" or given a rank score: the disclosed amount is a BAND, so the size of any of
  // these is unknown and summing them would invent a number nobody filed.
  const tally = {};
  for (const x of forTally) {
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
    // ⚠ THIS SENTENCE USED TO SAY "never exact figures" AND THAT WAS FALSE. Most members file a
    // range; some file a precise amount, and one of them is why the parser broke. Correct code with
    // wrong copy still ships a wrong claim.
    disclaimer: 'Disclosures, not trades in real time. Members have up to 45 days to file under the STOCK Act, and amounts are usually disclosed as ranges rather than exact figures.',
    lag,
    unreadable_filings: unreadable,
    unreadable_note: unreadable
      ? 'Filings submitted on paper and scanned. They have no text layer and cannot be read automatically, so they are absent from the rows below — absence here is not evidence a member did not trade.'
      : null,
    count: out.length,
    total_matching: total,
    top,
    members,
    rows: out,
    updated: meta ? meta.last_run : null,
    meta,
  });
};
