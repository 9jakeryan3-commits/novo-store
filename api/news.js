/* api/news.js — the market wire, public.
 *
 * Jake, 2026-09-12: "I want to add a News Outlet to the site… and the wire should be all market
 * news, not what a couple tickers have going on today."
 *
 * WHAT THIS IS. One pooled, deduplicated market wire — the feeder polls a breadth set (the index
 * ETFs, the mega-caps that move the tape, the sector and rates proxies, BTC/ETH) and merges them,
 * because the same wire story files under a dozen symbols and a per-ticker list reads like twelve
 * copies of the market. Members see the same wire with the publisher's preview text; this public
 * door serves the HEADLINE, the PUBLISHER and the AGE only.
 *
 * ⚠ WHY THE PUBLIC DOOR IS THINNER THAN THE MEMBER ONE, deliberately. A headline with its
 * publisher and its timestamp is an index — the standard, attributed treatment. Republishing a
 * vendor's article bodies on an open page is a different act with a different licence behind it,
 * and this data reaches us through Jake's own broker connection rather than a syndication deal.
 * So: attribution on every row, no body text, no vendor logos, and the page says where the wire
 * comes from. ⚠ THE FEED CARRIES NO ARTICLE URL (verified in the phase-0 capture: the item fields
 * are id/title/publisher/preview_text/content/published_at/source_type), so we CANNOT link a
 * reader back to the publisher. That is a real limit on how far this surface should ever go —
 * name it rather than quietly building a destination on top of someone else's reporting.
 *
 * ⚠ THE FEED HAS NO GENRE TAG. `source_type` is the vendor slug, not wire-vs-PR-vs-opinion, so
 * nothing here may sort, badge or imply "analysis" versus "news". The byline is the only signal
 * and it ships on every row.
 */
const { kv } = require('./_kv.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Two minutes: the feeder writes hourly, so this is about collapsing bursts, not freshness.
  res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=120, stale-while-revalidate=600');
  const r = kv();
  if (!r) return res.status(200).json({ ok: false, note: 'unavailable' });

  let raw = null;
  try { raw = await r.get('rh:news:MARKET'); } catch (_) { raw = null; }
  let j = null;
  try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { j = null; }
  const arts = (j && j.data && Array.isArray(j.data.articles)) ? j.data.articles : [];

  if (!arts.length) {
    // An empty wire says WHY. "No news" and "the feeder has not run" are different facts and a
    // reader must not read the second as the first.
    return res.status(200).json({
      ok: true, count: 0, items: [],
      note: 'The wire has not refreshed yet. This is an empty read, not a quiet market.',
    });
  }

  const limit = Math.max(1, Math.min(parseInt(req.query.limit || '', 10) || 40, 60));
  const items = arts.slice(0, limit).map((a) => ({
    title: a.title,
    publisher: a.publisher,            // the attribution IS the fact — never dropped
    published_at: a.published_at,
    symbols: Array.isArray(a.symbols) ? a.symbols.slice(0, 6) : undefined,
  }));

  return res.status(200).json({
    ok: true,
    count: items.length,
    items,
    as_of: (j && j.as_of) || null,
    received: (j && j.received) || null,
    symbols_polled: (j && j.data && j.data.symbols_polled) || null,
    more_in_window: (j && j.data && j.data.dropped) || 0,
    note: 'Headlines as filed by the publisher, newest first, pooled across the market and '
        + 'de-duplicated. Attribution and timing are shown on every row; this feed carries no '
        + 'genre tag, so nothing here is sorted or labelled as analysis versus reporting.',
  });
};
