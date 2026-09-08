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

// ── TRADER PREDICTIONS (Jake, 2026-09-07): "if the user says a prediction of any kind to Dr.
// NoVo he logs it the same way and it gets scored inside the predictions tab. Definitely a cool
// almost paper trading feature."
//
// A MEMBER'S CALLS ARE THEIRS, AND THEY LIVE IN THEIR OWN BOOK. Not in pred:log with an owner
// column: NoVo's record is capped, so a busy member would evict his rows, and one bad filter
// anywhere would put a member's guess into the published track record. Separate keys make that
// mistake impossible rather than merely unlikely.
//
// Everything else is deliberately IDENTICAL: same row shape, same makePrediction validation, same
// _grade, same evaluator tick. One definition of "was this right" for everyone on the platform -
// a member is scored exactly as strictly as NoVo is, on the same numbers, at the same moment.
const UKEY = (h) => "pred:user:" + h;
const UINDEX = "pred:users";          // who currently has something open, so grading knows where to look
function _uhash(email) {
  return crypto.createHash("sha256").update(String(email || "").trim().toLowerCase())
    .digest("hex").slice(0, 24);
}
async function _uload(r, h) {
  let l = null;
  try { l = await r.get(UKEY(h)); } catch (_) { l = null; }
  if (typeof l === "string") { try { l = JSON.parse(l); } catch (_) { l = null; } }
  return Array.isArray(l) ? l : [];
}
async function _usave(r, h, list) {
  const open = list.filter((p) => p.status === "open");
  const done = list.filter((p) => p.status !== "open").slice(-200);
  await r.set(UKEY(h), JSON.stringify([...done, ...open]), { ex: 365 * 24 * 3600 });
  /* The index carries only members with something OPEN. A member who stops predicting stops
     being walked, and their graded history stays exactly where it is. */
  let idx = null;
  try { idx = await r.get(UINDEX); } catch (_) {}
  if (typeof idx === "string") { try { idx = JSON.parse(idx); } catch (_) { idx = null; } }
  idx = Array.isArray(idx) ? idx : [];
  const has = idx.includes(h);
  if (open.length && !has) idx.push(h);
  else if (!open.length && has) idx = idx.filter((x) => x !== h);
  else return;
  await r.set(UINDEX, JSON.stringify(idx.slice(-5000)), { ex: 365 * 24 * 3600 });
}
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
const SIDES = new Set(["up", "down", "buy", "sell", "touch", "flat"]);

// ── THE BTC NEUTRAL BAND, MEASURED ───────────────────────────────────────────────────────────
// Jake, 2026-09-07: "measure it its needs to be done now."
// A neutral call cannot be graded without a band - "how flat is flat" - and a band that is picked
// rather than measured turns NEUTRAL into whatever the picker wanted it to be. So it was measured,
// and the measurement lives here rather than in a commit message:
//
//   0.73%  = the 33.3rd percentile of |24h return| on BTC-USD daily closes
//   n      = 1,825 daily returns, 2021-09-08 to 2026-09-08 (five years)
//   at this band the outcomes split 33.4% flat / 33.9% up / 32.7% down
//
// THE PERCENTILE IS THE WHOLE POINT. At the 33.3rd, the three calls are equally hard: being right
// about "flat" is worth exactly what being right about "up" is worth. A wider band makes NEUTRAL
// the easy call and quietly inflates the record of anyone who leans on it; a narrower one punishes
// honest uncertainty. Re-measure if BTC's volatility regime shifts materially - and when it moves,
// the published number moves with it, because the band IS the published number.
const BTC_NEUTRAL_PCT = 0.73;
const BTC_NEUTRAL_PROV = "33.3rd pct of |24h return|, n=1825 daily closes, 2021-09-08..2026-09-08";

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
    /* THREE SOURCES, AND THE DIFFERENCE IS A GATE (Jake, 2026-09-07):
         "read"         a bias NoVo published in a read - visible to EVERY member, because the
                        read itself already is
         "novo"         a call he initiated himself off the data - comp seats only
         "conversation" a call he made when asked - comp seats only, and the tools that make one
                        are comp-gated server-side, so a non-comp seat cannot produce one at all
       The tab is open to everyone now; what varies is WHICH rows come back. */
    source: args.source === "read" ? "read" : args.source === "novo" ? "novo"
          : args.source === "user" ? "user" : "conversation",
    asset_class: args.asset_class === "crypto" ? "crypto" : "equity",
    symbol, kind,
    side: side || (kind === "close_at" || kind === "open_at" ? (value >= spot_at ? "up" : "down") : (kind === "level_touch" ? "touch" : null)),
    // Stamped on the row so a future re-measure cannot silently re-grade history.
    ...(side === "flat" ? { neutral_band_pct: BTC_NEUTRAL_PCT, band_prov: BTC_NEUTRAL_PROV } : {}),
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
  } else if (p.side === "flat") {
    /* A neutral is right when the move STAYS INSIDE the band - graded on the same tick as every
       other call, against a number measured before it was published. The band is read off the ROW,
       not off the constant: re-measuring must never re-grade calls made under the old one. */
    const bandPct = p.neutral_band_pct || BTC_NEUTRAL_PCT;
    const movePct = (moved / p.spot_at) * 100;
    out.hit = Math.abs(movePct) <= bandPct;
    out.move_pct = +movePct.toFixed(3);
    out.band_pct = bandPct;
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

  /* MEMBERS GRADE ON THE SAME TICK, through the same _grade. A separate schedule would mean a
     member's call and NoVo's identical call could resolve against different prices. */
  let uidx = null;
  try { uidx = await r.get(UINDEX); } catch (_) {}
  if (typeof uidx === "string") { try { uidx = JSON.parse(uidx); } catch (_) { uidx = null; } }
  for (const h of (Array.isArray(uidx) ? uidx : [])) {
    try {
      const mine = await _uload(r, h);
      let ch = 0;
      for (const p of mine) {
        if (p.status !== "open") continue;
        if (p.asset_class === "equity" && Date.now() >= p.horizon_utc && !isTradingDayEt(p.horizon_utc)) {
          p.status = "void";
          p.outcome = { reason: "horizon fell on a market holiday — nothing traded, nothing to grade",
                        graded_utc: Date.now() };
          ch++; continue;
        }
        const spot = getSpot(p);
        if (!isFinite(spot)) continue;
        if (p.kind === "level_touch") {
          const crossed = (p.spot_at < p.value && spot >= p.value) || (p.spot_at > p.value && spot <= p.value);
          if (crossed) { p.status = "graded"; p.outcome = { actual: spot, hit: true, graded_utc: now }; ch++; continue; }
          if (now >= p.horizon_utc) { p.status = "graded"; p.outcome = { actual: spot, hit: false, graded_utc: now }; ch++; }
          continue;
        }
        if (now >= p.horizon_utc) { p.status = "graded"; p.outcome = _grade(p, spot); ch++; }
      }
      if (ch) await _usave(r, h, mine);
    } catch (_) { /* one member's book must not stop the rest */ }
  }
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
/* A member's prediction goes through makePrediction for VALIDATION and then lands in their own
   book. Reusing the validator is the point: a member cannot log something NoVo would be refused
   for - no spot, no horizon, a horizon too short to be falsifiable - so the two records mean the
   same thing and can be compared without an asterisk. */
async function makeUserPrediction(email, args = {}) {
  const r = kv();
  if (!r) return { error: "predictions unavailable" };
  const h = _uhash(email);
  if (!h) return { error: "who?" };
  const mine = await _uload(r, h);
  if (mine.filter((p) => p.status === "open").length >= 20) {
    return { error: "you have 20 open calls already — let some resolve first" };
  }
  /* Validate through the shared path, then move the row into the member's book. The global log is
     restored byte-for-byte: a member's call must not touch NoVo's record even for an instant. */
  const before = await _load(r);
  const made = await makePrediction({ ...args, source: "user" });
  if (!made || !made.ok) { await _save(r, before); return made || { error: "refused" }; }
  const after = await _load(r);
  const row = after.find((p) => p.id === made.id);
  await _save(r, before);
  if (!row) return { error: "not recorded" };
  row.owner = h;
  mine.push(row);
  await _usave(r, h, mine);
  return { ok: true, id: row.id, watching: row.thesis || row.kind, runs_until: "its horizon" };
}

async function listUserPredictions(email, limit) {
  const r = kv();
  if (!r) return null;
  const mine = await _uload(r, _uhash(email));
  const graded = mine.filter((p) => p.status === "graded" && p.outcome);
  const hits = graded.filter((p) => p.outcome.hit).length;
  return {
    open: mine.filter((p) => p.status === "open").sort((a, b) => a.horizon_utc - b.horizon_utc),
    graded: graded.slice(-(limit || 40)).reverse(),
    overall: { n: graded.length, hits: hits,
               hit_rate: graded.length ? Math.round((hits / graded.length) * 1000) / 10 : null },
  };
}

async function listPredictions(limit, assetClass, readsOnly) {
  const r = kv();
  if (!r) return { error: "predictions unavailable" };
  let list = await _load(r);
  // PER DESK (Jake): "hes make crypto predictions at his crypto desk and equities on the equities
  // side." One log; each dashboard reads its own asset class of it.
  if (assetClass) list = list.filter((p) => p.asset_class === assetClass);
  /* THE SEAT FILTER, APPLIED HERE rather than in the page. A non-comp seat gets the reads and
     nothing else - filtering in the browser would ship his private calls to a client that was
     merely asked not to draw them. */
  if (readsOnly) list = list.filter((p) => p.source === "read");
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

// ── DR. NOVO'S ALERTS — the curated feed ─────────────────────────────────────────────────────
// Jake, 2026-09-07: the private crypto and equity alerts get a UI surface — "a curated list
// surfaced into the Alerts tab as Dr. NoVo's Alerts when edges are found we dont want those rapid
// fire hosing into that page we wont the good ones. thats why everything is graded."
// The GRADING IS THE CURATOR: nothing enters this feed unless the rule that fired it has proven
// out-of-sample edge at or above its own floor. The raw firehose stays where it is (the map's
// feed, the chat tools); this list is only what cleared the bar.
const FEED_KEY = "novo:alerts:feed";
async function appendNovoFire(entry) {
  const r = kv();
  if (!r) return;
  let l = null;
  try { l = await r.get(FEED_KEY); } catch (_) { l = null; }
  if (typeof l === "string") { try { l = JSON.parse(l); } catch (_) { l = null; } }
  l = Array.isArray(l) ? l : [];
  l.push({ ts: Date.now(), ...entry });
  try { await r.set(FEED_KEY, JSON.stringify(l.slice(-100)), { ex: 60 * 24 * 3600 }); } catch (_) {}
}
async function listNovoFires(assetClass, limit) {
  const r = kv();
  if (!r) return [];
  let l = null;
  try { l = await r.get(FEED_KEY); } catch (_) { l = null; }
  if (typeof l === "string") { try { l = JSON.parse(l); } catch (_) { l = null; } }
  l = Array.isArray(l) ? l : [];
  if (assetClass) l = l.filter((x) => x.asset_class === assetClass);
  return l.slice(-(limit || 25)).reverse();
}

// Chain tickets, curated by their own gate math: a kind enters only when its out-of-sample edge
// clears its own floor — the exact bar chain_alerts' ACT gate uses, computed from the levels the
// snapshot already publishes so this can never disagree with the lab.
async function curateChainFires(snap) {
  const r = kv();
  const a = snap && snap.alerts;
  if (!r || !a || !Array.isArray(a.open)) return { kept: 0 };
  const levels = a.levels || {};
  let kept = 0;
  for (const t of a.open) {
    try {
      if (!t || !t.kind) continue;
      const madeTs = Date.parse(t.ts_utc || "") || 0;
      if (!madeTs || Date.now() - madeTs > 12 * 60 * 1000) continue;
      const lv = levels[t.kind];
      const edge = lv && lv.oos_trig_target != null && lv.oos_base_target != null
        ? lv.oos_trig_target - lv.oos_base_target : null;
      const floor = lv && lv.edge_floor_pp != null ? lv.edge_floor_pp : 5;
      if (edge == null || !(edge >= floor)) continue;         // no proven edge, no surface
      const seenKey = "novofeed:seen:" + crypto.createHash("sha256")
        .update((t.asset_code || "") + "|" + t.kind + "|" + (t.ts_utc || ""))
        .digest("hex").slice(0, 24);
      let seen = null;
      try { seen = await r.get(seenKey); } catch (_) {}
      if (seen) continue;
      await appendNovoFire({
        asset_class: "crypto", symbol: String(t.asset_code || "").toUpperCase(),
        kind: t.kind, title: String(t.claim || (t.kind + " fired")).slice(0, 200),
        horizon_min: Number(t.horizon_min) || null,
        receipts: "oos edge +" + edge.toFixed(1) + "pp over its own floor " + floor,
      });
      try { await r.set(seenKey, "1", { ex: 7 * 24 * 3600 }); } catch (_) {}
      kept++;
    } catch (_) { /* one bad ticket must not stop the pass */ }
  }
  return { kept };
}

// ── NOVO'S EQUITY SELECTOR ───────────────────────────────────────────────────────────────────
// Jake, 2026-09-07: "it is his not the eyes making predictions he uses the eye as a tool but its
// novos predictions ... the eye gives live readings not predictions."
//
// The Eye reports that a forward-registered rule tripped, and hands over that rule's graded record
// beside the record of every rule on the book. NOVO decides here, and the decision is the same one
// he makes on the crypto side: a fire earns a call only when the rule behind it has beaten the
// book's own baseline by a real margin on a real denominator.
//
//   * >= 30 resolutions   -- a hit rate over a handful of resolutions is not a rate
//   * >= 5pp over base    -- the baseline is the empirical hit rate across ALL resolved equity
//                            signals, i.e. what "no particular rule" actually achieves here. A
//                            hit rate with no baseline flatters or slanders itself depending on
//                            which way the market happened to go.
//
// TWO DECISIONS, ONE BAR. Clearing it makes the fire one of Dr. NoVo's Alerts AND makes it a
// recorded prediction; failing it leaves the fire exactly where it was — in the private
// hash-chained equity record, chat-pull only, waiting to earn its way up. That is Jake's rule
// stated as code: "when an edge is found in those alerts it is approved for Dr. NoVo's Alerts ...
// as long as it holds an edge."
const EQ_MIN_RESOLUTIONS = 30;
const EQ_MIN_EDGE_PP = 5;
async function onEquityFire(fire) {
  const r = kv();
  if (!r || !fire || !fire.rule || !fire.symbol) return { surfaced: false, predicted: false };
  const rec = fire.record || {};
  const spot = Number(fire.spot_at);
  const hm = Number(fire.horizon_min) >= 5 ? Number(fire.horizon_min) : 60;
  const side = String(fire.direction || "").toLowerCase() === "up" ? "up" : "down";
  const n = Number(rec.resolutions) || 0;
  const hit = rec.hit_pct == null ? null : Number(rec.hit_pct);
  const base = rec.base_hit_pct == null ? null : Number(rec.base_hit_pct);
  const edge = (hit == null || base == null) ? null : hit - base;

  // One fire, one decision, ever — a predicate that stays true across passes must not become a
  // second call. The engine already holds a refire guard; this is the store's own, because two
  // publishers with one guard between them is a guard that stops existing the day one is replaced.
  const seenKey = "eqfire:seen:" + crypto.createHash("sha256")
    .update(fire.symbol + "|" + fire.rule + "|" + String(fire.spot_at) + "|" + String(fire.ts || ""))
    .digest("hex").slice(0, 24);
  try { if (await r.get(seenKey)) return { surfaced: false, predicted: false, dup: true }; } catch (_) {}

  const earned = n >= EQ_MIN_RESOLUTIONS && edge != null && edge >= EQ_MIN_EDGE_PP;
  if (!earned) {
    try { await r.set(seenKey, "1", { ex: 7 * 24 * 3600 }); } catch (_) {}
    // Not a failure — the ordinary state of a pre-registered rule that has not resolved enough
    // yet. It stays a private fire, which is where it already is.
    return { surfaced: false, predicted: false,
             why: n < EQ_MIN_RESOLUTIONS ? "only " + n + " resolutions" : "edge " + edge + "pp" };
  }

  const receipts = hit + "% over " + n + " resolutions vs " + base + "% across the book";
  let predicted = false;
  if (isFinite(spot) && spot > 0) {
    const out = await makePrediction({
      source: "novo", asset_class: "equity", symbol: fire.symbol, kind: "direction", side,
      spot_at: spot, horizon_min: hm,
      thesis: fire.symbol + " " + side + " within "
        + (hm >= 60 ? Math.round(hm / 60) + "h" : hm + "m") + " — " + (fire.reading || fire.rule),
      basis: fire.rule + " · " + receipts,
    });
    predicted = !!(out && out.ok);
  }
  await appendNovoFire({
    asset_class: "equity", symbol: fire.symbol, kind: fire.rule,
    title: fire.symbol + " " + side + " — " + (fire.reading || fire.rule),
    horizon_min: hm, receipts: receipts,
  });
  try { await r.set(seenKey, "1", { ex: 7 * 24 * 3600 }); } catch (_) {}
  return { surfaced: true, predicted: predicted, edge: edge };
}

// ── THE CRYPTO SELECTOR ──────────────────────────────────────────────────────────────────────
// Jake, 2026-09-07: "he is always watching the data flow the Eye and other alerts systems in
// crypto and all to make his own predictions when he sees a fitting trade or moment."
// Rides the snapshot the collector already pushes every ~5 minutes. "A fitting moment" is defined
// by the record, not by vibes: a new reading whose kind's base rate shows real edge over its own
// outcome distribution, on the honest denominator. Requirements, stated:
//   * n_cells >= 25   -- distinct coin-days, the denominator the census already fought for
//   * edge >= 5pp     -- hit_rate minus that side's own base share of outcomes
//   * the reading is fresh (< 12 min) and not already taken (KV seen-key, 7d)
// makePrediction's MAX_OPEN caps the flood; one reading = at most one prediction, ever.
async function selectCryptoPredictions(snap) {
  const r = kv();
  if (!r || !snap) return { made: 0 };
  const feed = Array.isArray(snap.feed) ? snap.feed : [];
  const rates = ((snap.health || {}).base_rates) || [];
  const byKind = {};
  for (const b of rates) byKind[b.kind] = b;
  let made = 0;
  for (const f of feed) {
    try {
      if (!f || !f.kind || (!f.asset_code && !f.asset)) continue;
      const sym = String(f.asset_code || f.asset || "").toUpperCase();
      const madeTs = Date.parse(f.ts_utc || "") || 0;
      if (!madeTs || Date.now() - madeTs > 12 * 60 * 1000) continue;   // stale = not a moment
      const rate = byKind[f.kind + (f.side ? "_" + f.side : "")] || byKind[f.kind];
      if (!rate || !(rate.n_cells >= 25) || rate.hit_rate == null) continue;
      const nUp = rate.n_up || 0, nDn = rate.n_down || 0;
      const total = nUp + nDn;
      if (!total) continue;
      const side = (rate.avg_move != null && rate.avg_move < 0) ? "down" : "up";
      const baseShare = (side === "up" ? nUp : nDn) / total * 100;
      const edge = rate.hit_rate - baseShare;
      if (!(edge >= 5)) continue;                                       // no edge, no call
      const seenKey = "pred:seen:" + crypto.createHash("sha256")
        .update(sym + "|" + f.kind + "|" + (f.ts_utc || "")).digest("hex").slice(0, 24);
      let seen = null;
      try { seen = await r.get(seenKey); } catch (_) {}
      if (seen) continue;
      const coin = (snap.coins || {})[sym];
      const spot = coin && Number(coin.price || (coin.true_cost && coin.true_cost.price));
      if (!isFinite(spot) || spot <= 0) continue;
      const hm = Number(f.horizon_min) >= 5 ? Number(f.horizon_min) : 240;
      const out = await makePrediction({
        source: "novo", asset_class: "crypto", symbol: sym, kind: "direction", side,
        spot_at: spot, horizon_min: hm,
        /* ⚠ THE CALL LEADS, THE READING FOLLOWS (Jake, 2026-09-07: "his prediction on not just the
           same raw alerts the crypto public already has... his predictions are direct calls").
           The public reading is descriptive — "funding is -4.7 sigma, shorts paying". Copying that
           verbatim made his prediction row read like the public alert wearing a new label. His
           thesis now states the directed, falsifiable claim first, in his own voice, with the
           reading as the why. */
        thesis: (sym + " " + side + " within " + (hm >= 60 ? Math.round(hm / 60) + "h" : hm + "m")
          + " — " + String(f.claim || (f.kind + " fired"))).slice(0, 200),
        basis: f.kind + " \u00b7 " + rate.hit_rate + "% over " + rate.n_cells
          + " coin-days vs " + baseShare.toFixed(1) + "% base",
      });
      if (out && out.ok) {
        made++;
        try { await r.set(seenKey, "1", { ex: 7 * 24 * 3600 }); } catch (_) {}
        // The same event, surfaced: a reading he turned into a call IS an edge found.
        try {
          await appendNovoFire({ asset_class: "crypto", symbol: sym, kind: f.kind,
            title: sym + " " + side + " within " + (hm >= 60 ? Math.round(hm / 60) + "h" : hm + "m"),
            horizon_min: hm,
            receipts: rate.hit_rate + "% over " + rate.n_cells + " coin-days vs "
              + baseShare.toFixed(1) + "% base" });
        } catch (_) {}
      }
    } catch (_) { /* one bad reading must not stop the pass */ }
  }
  return { made };
}

module.exports = { makePrediction, listPredictions, evaluate, selectCryptoPredictions,
                   makeUserPrediction, listUserPredictions,
                   BTC_NEUTRAL_PCT, BTC_NEUTRAL_PROV,
                   onEquityFire,
                   appendNovoFire, listNovoFires, curateChainFires,
                   evaluateEquityPredictions, evaluateCryptoPredictions };
