// Upcoming MAJOR US macro events (Fed, CPI, jobs, GDP, PCE, ISM, ...) from Nasdaq's free economic-calendar API.
// PUBLIC data, no key. Dynamic (real release dates), so it never ships stale/wrong hardcoded dates. Cached 6h.

const MAJOR = /\b(fed|fomc|interest rate|cpi|inflation|nonfarm|payroll|employment|unemployment|jobless|gdp|pce|retail sales|ism|consumer confidence|michigan|durable goods|ppi|trade balance)\b/i;
const isUS = (c) => /united states|^us$|^u\.s\.?$/i.test(String(c || "").trim());
const clean = (v) => {
  const s = String(v == null ? "" : v).replace(/&nbsp;/g, "").trim();
  return s || null;
};
const ymd = (d) => d.toISOString().slice(0, 10);

// Nasdaq's free economic-calendar API buckets US events one calendar DAY LATE: its date=X response holds the
// events that actually occur on X-1 in ET (a timezone-bucketing quirk — the `gmt` field even carries the ET
// release time, e.g. "14:00" for the 2pm FOMC, not a GMT time). Verified 2026-07-29 against three
// independently-scheduled anchors: CB Consumer Confidence (real Tue 7/28 -> bucket 7/29), the FOMC decision
// (real Wed 7/29 -> bucket 7/30) and US GDP advance (real Thu 7/30 -> bucket 7/31). So to get real ET date D's
// events we query the bucket D+1 and tag them with D. (If Nasdaq ever fixes the offset, drop the +1 in the loop.)
async function forRealDate(realDs, queryDs) {
  try {
    const r = await fetch(`https://api.nasdaq.com/api/calendar/economicevents?date=${queryDs}`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!r.ok) return [];
    const rows = (await r.json())?.data?.rows || [];
    return rows
      .filter((x) => isUS(x.country) && MAJOR.test(x.eventName || ""))
      .map((x) => ({
        date: realDs,            // the REAL ET date = Nasdaq's late bucket (queryDs) minus one day
        time: clean(x.gmt),      // Nasdaq mislabels this "gmt"; it is actually the ET release time
        event: String(x.eventName || "").trim(),
        consensus: clean(x.consensus),
        previous: clean(x.previous),
      }));
  } catch { return []; }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=43200");
  try {
    const now = new Date();
    const days = [];   // [realDs, queryDs] — queryDs = realDs + 1 (Nasdaq's day-late bucket; see forRealDate)
    for (let i = 0; i < 18 && days.length < 12; i++) {
      const d = new Date(now.getTime() + i * 86400000);
      const wd = d.getUTCDay();
      if (wd >= 1 && wd <= 5) days.push([ymd(d), ymd(new Date(d.getTime() + 86400000))]); // weekdays only (by REAL date)
    }
    const all = (await Promise.all(days.map(([realDs, queryDs]) => forRealDate(realDs, queryDs)))).flat();
    const seen = new Set();
    const out = [];
    for (const e of all) {
      const k = e.date + "|" + e.event;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    out.sort((a, b) => (a.date === b.date ? (a.time || "").localeCompare(b.time || "") : a.date.localeCompare(b.date)));
    res.status(200).json({ updated: Date.now(), events: out.slice(0, 8) });
  } catch {
    res.status(200).json({ updated: Date.now(), events: [] });
  }
};
