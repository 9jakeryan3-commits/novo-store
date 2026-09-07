// api/_lib/predictions.js — NoVo Unleashed: real predictions, recorded the moment they are made,
// graded against the same published numbers everything else is graded on.
//
// Jake, 2026-09-07: "Under comp seats novo is unleashed novo will say buy now sell now novo will
// make predictions and act as a real prediction analyst ... the predictions stored and are graded
// just like the rest of the novo private comp seat alerts. Even if novo makes a prediction in
// conversation like i ask what do you think spy will close at today, he makes a real prediction of
// all his data that also gets saved stored and scored the moment he makes it."
//
// THE RECORD IS NOVO'S, NOT THE MEMBER'S. One global log — the same shape as the published track
// record: append-only in spirit (nothing here deletes a graded row), self-scored, and honest about
// being self-scored. Comp seats VIEW it; nobody edits it.
//
// GRADING, v1, stated plainly:
//   close_at     a point estimate. Graded at the first evaluation at/after the horizon: the error
//                (predicted vs actual, %) is the score that matters; `hit` is whether the DIRECTION
//                from the spot-at-prediction was right, because a point estimate smuggles a
//                directional call and the direction is the falsifiable half.
//   direction    up/down by the horizon. hit = sign of the move matched.
//   trade_call   buy/sell now, horizon required. Graded exactly like direction — a "buy now" IS
//                "up from here by then", said with intent.
//   level_touch  touches a level before the horizon. hit the moment it trades through; miss when
//                the horizon passes untouched. Checked on every publish, not just at expiry.
//
// Evaluation rides the pushes that already happen (equity live-state ~60s, crypto snapshot ~5min),
// exactly like reader alerts — no new clock, no new data source, nothing graded on numbers members
// cannot see.

const crypto = require("crypto");
const { kv } = require("./../_kv.js");

const KEY = "pred:log";
const MAX_KEPT = 400;          // graded history kept for the score; oldest graded rows fall off
const MAX_OPEN = 40;           // a runaway prompt cannot flood the record
const KINDS = new Set(["close_at", "open_at", "direction", "trade_call", "level_touch"]);

// ── THE EQUITY CALENDAR ──────────────────────────────────────────────────────────────────────
// The first real prediction (Jake, Labor Day 2026) was recorded with horizon "today_close" ON A
// MARKET HOLIDAY: at 16:00 the evaluator would have graded it against a spot frozen since Friday,
// actual == spot_at, and handed NoVo a free HIT on a market that never traded — a check that
// cannot fail, landed in the track record itself. Same family as the LIVE badge on Labor Day:
// a clock that knows hours but not days.
// Mirror of the engine's skills/market_calendar holiday set; extend annually. Half-day closes need
// no special case here: grading at 16:00 reads the last spot, which IS that day's close.
const MKT_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
function _etParts(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York",
    hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short" })
    .formatToParts(new Date(ms)).reduce((o, x) => (o[x.type] = x.value, o), {});
}
function _etDate(ms) { const p = _etParts(ms); return p.year + "-" + p.month + "-" + p.day; }
function isTradingDayEt(ms) {
  const p = _etParts(ms);
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  return !MKT_HOLIDAYS.has(p.year + "-" + p.month + "-" + p.day);
}
const SIDES = new Set(["up", "down", "buy", "sell", "touch"]);

async function _load(r) {
  let l = null;
  try { l = await r.get(KEY); } catch (_) { l = null; }
  if (typeof l === "string") { try { l = JSON.parse(l); } catch (_) { l = null; } }
  return Array.isArray(l) ? l : [];
}
async function _save(r, list) {
  // Open rows are never dropped by the cap — only graded history ages out.
  const open = list.filter((p) => p.status === "open");
  const graded = list.filter((p) => p.status !== "open").slice(-MAX_KEPT);
  await r.set(KEY, JSON.stringify([...graded, ...open]), { ex: 365 * 24 * 3600 });
}

// An ET wall-clock time on a given day, expressed in UTC by asking what offset ET carries then.
function _etWallUtc(dayMs, hh, mm) {
  const et = _etParts(dayMs);
  const asUtc = Date.UTC(+et.year, +et.month - 1, +et.day, hh, mm, 0);
  const offsetMin = (Date.UTC(+et.year, +et.month - 1, +et.day, +et.hour, +et.minute)
    - (Math.floor(dayMs / 60000) * 60000)) / 60000;
  return asUtc - offsetMin * 60000;
}
// Named horizons resolve to the NEXT SESSION THAT EXISTS. "today_close" on a holiday, a weekend,
// or after the bell means the next trading day's close — never a time no market trades at.
function resolveHorizon(name, nowMs) {
  const now = nowMs || Date.now();
  const DAY = 24 * 3600 * 1000;
  let day = now;
  const wantOpen = name === "tomorrow_open";
  const strictlyTomorrow = name === "tomorrow_open" || name === "tomorrow_close";
  if (strictlyTomorrow) day += DAY;
  for (let i = 0; i < 10; i++, day += DAY) {
    if (!isTradingDayEt(day)) continue;
    const t = _etWallUtc(day, wantOpen ? 9 : 16, wantOpen ? 30 : 0);
    if (t > now) return t;
  }
  return null;
}

async function makePrediction(args = {}) {
  const r = kv();
  if (!r) return { error: "predictions unavailable" };
  const kind = String(args.kind || "").trim();
  if (!KINDS.has(kind)) return { error: "kind must be close_at, direction, trade_call or level_touch" };
  const symbol = String(args.symbol || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!symbol) return { error: "symbol required" };
  const side = String(args.side || "").trim().toLowerCase();
  if ((kind === "direction" || kind === "trade_call") && !SIDES.has(side))
    return { error: "side must be up/down (direction) or buy/sell (trade_call)" };

  const value = Number(args.value);
  if ((kind === "close_at" || kind === "open_at" || kind === "level_touch") && !(isFinite(value) && value > 0))
    return { error: kind + " needs a numeric value" };

  const spot_at = Number(args.spot_at);
  if (!(isFinite(spot_at) && spot_at > 0))
    return { error: "spot_at required — the price on screen when the call was made. A prediction " +
                    "with no starting point cannot be graded." };

  // The horizon is WHEN THIS BECOMES FALSIFIABLE. Required, always.
  let horizon_utc = null;
  if (["today_close", "tomorrow_open", "tomorrow_close"].includes(args.horizon))
    horizon_utc = resolveHorizon(args.horizon);
  else if (isFinite(Number(args.horizon_min)) && Number(args.horizon_min) >= 5)
    horizon_utc = Date.now() + Number(args.horizon_min) * 60000;
  /* Up to a year (Jake: run "until the actual thing happening"). The horizon is still REQUIRED —
     that is what makes a prediction falsifiable, and the grade IS the thing happening — but its
     reach is the member's call, not a two-week ceiling. */
  if (!horizon_utc || horizon_utc > Date.now() + 366 * 24 * 3600 * 1000)
    return { error: "horizon must be today_close / tomorrow_open / tomorrow_close, or horizon_min (5 minutes to a year)" };

  const list = await _load(r);
  if (list.filter((p) => p.status === "open").length >= MAX_OPEN)
    return { error: "too many open predictions — let some resolve first" };

  const p = {
    id: crypto.randomBytes(4).toString("hex"),
    made_utc: Date.now(),
    source: args.source === "novo" ? "novo" : "conversation",
    asset_class: args.asset_class === "crypto" ? "crypto" : "equity",
    symbol, kind,
    side: side || (kind === "close_at" || kind === "open_at" ? (value >= spot_at ? "up" : "down") : (kind === "level_touch" ? "touch" : null)),
    value: isFinite(value) ? value : null,
    spot_at,
    horizon_utc,
    thesis: String(args.thesis || "").slice(0, 280) || null,
    basis: String(args.basis || "").slice(0, 200) || null,
    status: "open",
  };
  list.push(p);
  await _save(r, list);
  return { ok: true, id: p.id, recorded: p, note: "on the record — it grades itself at the horizon" };
}

// ── grading ──────────────────────────────────────────────────────────────────────────────────
function _grade(p, actual) {
  const dirUp = p.side === "up" || p.side === "buy";
  const moved = actual - p.spot_at;
  const out = { actual: actual, graded_utc: Date.now() };
  if (p.kind === "close_at" || p.kind === "open_at") {
    out.error_pct = p.value ? +(((actual - p.value) / p.value) * 100).toFixed(3) : null;
    out.hit = (p.value >= p.spot_at) === (moved >= 0);
  } else if (p.kind === "level_touch") {
    out.hit = false;      // set true only by the touch path
  } else {
    out.hit = dirUp ? moved > 0 : moved < 0;
  }
  return out;
}

async function evaluate(getSpot) {
  const r = kv();
  if (!r) return { graded: 0 };
  const list = await _load(r);
  const now = Date.now();
  let changed = 0;
  for (const p of list) {
    if (p.status !== "open") continue;
    /* ⚠ VOID, NOT GRADED, when an equity horizon fell on a day no market traded. This is the
       migration guard for rows recorded before the calendar existed — one is live right now,
       "today_close" stamped on Labor Day — and the permanent backstop for anything that slips
       past creation. Grading it would compare a frozen spot to itself and mint a free HIT; a
       record with free hits in it is not a record. Voided rows are kept, shown, and excluded
       from the score, with the reason on the row. */
    if (p.asset_class === "equity" && Date.now() >= p.horizon_utc && !isTradingDayEt(p.horizon_utc)) {
      p.status = "void";
      p.outcome = { reason: "horizon fell on a market holiday — nothing traded, nothing to grade",
                    graded_utc: Date.now() };
      changed++;
      continue;
    }
    const spot = getSpot(p);
    if (!isFinite(spot)) continue;
    if (p.kind === "level_touch") {
      const crossed = (p.spot_at < p.value && spot >= p.value) || (p.spot_at > p.value && spot <= p.value);
      if (crossed) { p.status = "graded"; p.outcome = { actual: spot, hit: true, graded_utc: now }; changed++; continue; }
      if (now >= p.horizon_utc) { p.status = "graded"; p.outcome = { actual: spot, hit: false, graded_utc: now }; changed++; }
      continue;
    }
    if (now >= p.horizon_utc) { p.status = "graded"; p.outcome = _grade(p, spot); changed++; }
  }
  if (changed) await _save(r, list);
  return { graded: changed };
}

async function evaluateEquityPredictions(state) {
  const byTk = {};
  for (const t of (state && state.indices) || []) {
    const s = Number(t.spot);
    if (isFinite(s)) byTk[String(t.ticker || "").toUpperCase()] = s;
  }
  return evaluate((p) => (p.asset_class === "equity" ? byTk[p.symbol] : NaN));
}
async function evaluateCryptoPredictions(snap) {
  const coins = (snap && snap.coins) || {};
  return evaluate((p) => {
    if (p.asset_class !== "crypto") return NaN;
    const c = coins[p.symbol];
    return c ? Number(c.price || (c.true_cost && c.true_cost.price)) : NaN;
  });
}

// ── the read, with the score attached ────────────────────────────────────────────────────────
async function listPredictions(limit) {
  const r = kv();
  if (!r) return { error: "predictions unavailable" };
  const list = await _load(r);
  const graded = list.filter((p) => p.status === "graded" && p.outcome);
  const by = {};
  for (const p of graded) {
    const k = p.kind;
    by[k] = by[k] || { n: 0, hits: 0, abs_err: [], };
    by[k].n++;
    if (p.outcome.hit) by[k].hits++;
    if (p.outcome.error_pct != null) by[k].abs_err.push(Math.abs(p.outcome.error_pct));
  }
  const score = {};
  for (const k of Object.keys(by)) {
    score[k] = { n: by[k].n, hits: by[k].hits,
      hit_rate: +((by[k].hits / by[k].n) * 100).toFixed(1),
      avg_abs_error_pct: by[k].abs_err.length
        ? +(by[k].abs_err.reduce((a, b) => a + b, 0) / by[k].abs_err.length).toFixed(3) : null };
  }
  const overall = graded.length
    ? { n: graded.length, hits: graded.filter((p) => p.outcome.hit).length,
        hit_rate: +((graded.filter((p) => p.outcome.hit).length / graded.length) * 100).toFixed(1) }
    : { n: 0, hits: 0, hit_rate: null };
  return {
    open: list.filter((p) => p.status === "open").sort((a, b) => a.horizon_utc - b.horizon_utc),
    graded: graded.slice(-(limit || 40)).reverse(),
    void: list.filter((p) => p.status === "void").slice(-10).reverse(),
    score, overall,
  };
}

module.exports = { makePrediction, listPredictions, evaluate,
                   evaluateEquityPredictions, evaluateCryptoPredictions };
