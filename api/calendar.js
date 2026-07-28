// Upcoming MAJOR US macro events (Fed, CPI, jobs, GDP, PCE, ISM, ...) from Nasdaq's free economic-calendar API.
// PUBLIC data, no key. Dynamic (real release dates), so it never ships stale/wrong hardcoded dates. Cached 6h.

const MAJOR = /\b(fed|fomc|interest rate|cpi|inflation|nonfarm|payroll|employment|unemployment|jobless|gdp|pce|retail sales|ism|consumer confidence|michigan|durable goods|ppi|trade balance)\b/i;
const isUS = (c) => /united states|^us$|^u\.s\.?$/i.test(String(c || "").trim());
const clean = (v) => {
  const s = String(v == null ? "" : v).replace(/&nbsp;/g, "").trim();
  return s || null;
};
const ymd = (d) => d.toISOString().slice(0, 10);

async function forDate(ds) {
  try {
    const r = await fetch(`https://api.nasdaq.com/api/calendar/economicevents?date=${ds}`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!r.ok) return [];
    const rows = (await r.json())?.data?.rows || [];
    return rows
      .filter((x) => isUS(x.country) && MAJOR.test(x.eventName || ""))
      .map((x) => ({
        date: ds,
        time: clean(x.gmt),
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
    const days = [];
    for (let i = 0; i < 18 && days.length < 12; i++) {
      const d = new Date(now.getTime() + i * 86400000);
      const wd = d.getUTCDay();
      if (wd >= 1 && wd <= 5) days.push(ymd(d)); // weekdays only
    }
    const all = (await Promise.all(days.map(forDate))).flat();
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
