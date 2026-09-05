// api/_lib/forecast.js — THE forecast contract, in exactly one place.
//
// WHY THIS FILE EXISTS. The log_forecast executor (tools.js) and the fallback capture's gate
// (analyst-ask.js validForecast) shipped as two hand-copied implementations of one rule set,
// because the executor lives inside makeExecutors' closure. That is the third instance of the
// mirrored-twin class on this codebase (MIN_EFFECT_R across two repos; _subGrantsAnalyst in two
// files), and the class fails SILENTLY: someone extends one copy, the other drifts, and the two
// doors into the calibration ledger start enforcing different rules — inconsistent gatekeeping
// quietly corrupting the exact record everything else exists to protect. One exported truth,
// both doors import it, the suite exercises THIS file.
//
// ── HORIZON V2 (Jake: "both should be in now", 2026-09-05) ──────────────────────────────────
// v1 could only anchor a horizon FROM NOW, so the most natural analyst claims — "holds an hour
// into Tuesday's open", voiced on a weekend — were unloggable (or worse, mis-anchored against a
// closed market, as the first live capture proved). `anchor` fixes it:
//   anchor: "now"       (default) — resolves at asked_at + horizon_min          (v1 semantics)
//   anchor: "next_open"           — resolves at the NEXT session open strictly after asked_at,
//                                   plus horizon_min. "An hour into Tuesday's open", asked on
//                                   Saturday of Labor Day weekend, resolves Tue 10:30 ET.
// VOCABULARY NOTE: this anchor naming is shared with the engine's equities-signal resolver by
// agreement with Overwatch (their mirror case: a signal fired at 3:45pm with a thin EOD window).
// Extend the vocabulary here first, ping there second — never invent a second dialect.

const BUCKETS = [55, 65, 75, 85, 95];
const TICKERS = ["SPY", "QQQ", "IWM"];
const METRICS = ["spot_above", "spot_below"];
const ANCHORS = ["now", "next_open"];

// ⚠ TWINNED ACROSS LANGUAGES with NoVo-Pulse/skills/market_calendar.py — JS cannot import it.
// This is the minimal store-side copy: full-closure NYSE holidays only. Half-days need no entry:
// a horizon landing after an early close finds no hist sample and grades CENSORED, which is the
// honest answer anyway. Extend annually, and update BOTH files when the calendar changes.
const NYSE_HOLIDAYS = new Set([
  "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

function _etParts(ms) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const p = {};
  for (const { type, value } of f.formatToParts(ms)) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, dow: p.weekday };
}

const _etDateStr = (y, m, d) => y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");

function _isTradingDay(y, m, d, dow) {
  return dow !== "Sat" && dow !== "Sun" && !NYSE_HOLIDAYS.has(_etDateStr(y, m, d));
}

// 9:30 ET on a given ET calendar day, as UTC ms — found by trying both offsets (EDT/EST) and
// keeping the one that round-trips, so DST is handled by the Intl database, not by us.
function _openMsForEtDay(y, m, d) {
  for (const off of [4, 5]) {
    const ms = Date.UTC(y, m - 1, d, 9 + off, 30);
    const p = _etParts(ms);
    if (p.y === y && p.m === m && p.d === d && p.hh === 9 && p.mm === 30) return ms;
  }
  return null;
}

/** The next 9:30-ET session open STRICTLY AFTER `ms` (skips weekends + holidays). Null if the
 *  calendar table has run out — callers treat null as unresolvable, never guess. */
function nextSessionOpen(ms) {
  let probe = ms;
  for (let i = 0; i < 14; i++) {
    const p = _etParts(probe);
    const open = _openMsForEtDay(p.y, p.m, p.d);
    if (open !== null && open > ms && _isTradingDay(p.y, p.m, p.d, p.dow)) return open;
    probe += 24 * 3600 * 1000;
  }
  return null;
}

/** When a stored claim resolves, in UTC ms — the ONE place anchor semantics are interpreted.
 *  Both the grader and any future resolver call this; nobody re-derives it. */
function resolveAt(claim) {
  const base = claim.anchor === "next_open" ? nextSessionOpen(claim.asked_at) : claim.asked_at;
  if (base === null) return null;
  return base + claim.horizon_min * 60000;
}

/**
 * THE validation. A forecast that cannot be machine-graded later never enters the ledger
 * (resolvability at capture, not at grade). Returns the canonical row, or null.
 */
function validateForecast(c) {
  if (!c || typeof c !== "object") return null;
  const tk = String(c.ticker || "").toUpperCase();
  const conf = Number(c.confidence);
  const lvl = Number(c.level);
  const hz = Math.round(Number(c.horizon_min));
  const anchor = c.anchor === undefined || c.anchor === null || c.anchor === "" ? "now" : String(c.anchor);
  if (!TICKERS.includes(tk)) return null;
  if (!BUCKETS.includes(conf)) return null;
  if (!METRICS.includes(c.metric)) return null;
  if (!ANCHORS.includes(anchor)) return null;
  if (!isFinite(lvl) || lvl <= 0) return null;
  // now: 30-390 min from this moment. next_open: 5-390 min into that session (5, not 0 — the
  // first level promotion of a session lands minutes after the bell, and a horizon at the exact
  // open would grade against nothing).
  if (!isFinite(hz)) return null;
  if (anchor === "now" && (hz < 30 || hz > 390)) return null;
  if (anchor === "next_open" && (hz < 5 || hz > 390)) return null;
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    asked_at: Date.now(), claim: String(c.claim || "").slice(0, 200),
    confidence: conf, ticker: tk, metric: c.metric, level: lvl, horizon_min: hz, anchor,
  };
}

module.exports = { validateForecast, resolveAt, nextSessionOpen, BUCKETS, TICKERS, METRICS, ANCHORS, NYSE_HOLIDAYS };
