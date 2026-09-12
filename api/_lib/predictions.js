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
const { bump } = require("./funnel.js");

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
/* ── RETENTION ────────────────────────────────────────────────────────────────────────────────
   Jake, 2026-09-09: "we keep ALL, thats what makes this whole thing work, we cannot delete useful
   data none, at all anyway, thats imperative ... or we change it to The Analyst's Score a rolling
   400 would make sense a little more but still need to keep all good data."

   So both, and they are different things:
     pred:log          the WORKING SET — every open row, plus the last MAX_KEPT graded. This is the
                       rolling window: recent form. Bounded so a hot key stays small and fast.
     pred:arch:YYYY-MM every graded row, appended once at the moment it is graded. NO TTL, NEVER
                       trimmed. This is the data itself and it is never deleted.
     pred:tally        running totals per source, incremented once per graded row. NO TTL. This is
                       what an all-time score reads: O(1), and it cannot drift out of the window.

   ⚠ THE TALLY IS INCREMENTED AT THE GRADING TRANSITION, not when a row falls off the cap. That is
   what makes it exactly-once: a row becomes graded exactly once, whereas "about to be trimmed" is
   a condition that can be evaluated twice for the same row across two saves.

   ⚠ THE WORKING SET CARRIES A ONE-YEAR TTL (see _save) and always has. It is refreshed on every
   save, so it only bites after a full year of silence — but it is a second deletion path on top of
   the cap, and it is exactly why the archive and the tally below are written with NO expiry. */
const ARCH = (ms) => "pred:arch:" + new Date(ms).toISOString().slice(0, 7);
const TALLY = "pred:tally";

/* Called once, at the moment a row stops being open. Failures here must never cost the grading
   pass: the row is already graded in the working set, and a lost archive append is recoverable
   from that; a thrown exception here would abort the whole evaluate() and lose the grade too. */
async function _remember(r, p) {
  if (!r || !p) return;
  try {
    const src = (p.source === "user" || p.source === "engine") ? p.source : (p.source || "conversation");
    const hit = p.outcome && typeof p.outcome.hit === "boolean" ? p.outcome.hit : null;
    await r.rpush(ARCH(Date.now()), JSON.stringify(p));       // no TTL: this is the record
    if (hit === null) {
      await r.hincrby(TALLY, "ungraded:" + src, 1);
      return;
    }
    await r.hincrby(TALLY, "n:" + src, 1);
    if (hit) await r.hincrby(TALLY, "hit:" + src, 1);
  } catch (_) { /* never break a grading pass over bookkeeping */ }
}

const MAX_KEPT = 400;          // the ROLLING WINDOW only. Nothing is lost: see _remember above.
const MAX_OPEN = 40;           // a runaway prompt cannot flood the record
/* The equity universe the evaluator can actually price: evaluateEquityPredictions reads spots out
   of the published state's `indices`, which the engine builds for these three. Same set alerts.js
   enforces (alerts.js:32) — one answer to "what can this platform grade", not two. */
const EQ_RESOLVABLE = new Set(["SPY", "QQQ", "IWM"]);
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
  /* EXTENDED to 2029 on 2026-09-08. The table ended 2027-12-24; from 2028-01-17 an unlisted
     holiday would have resolved a "today_close" onto a closed market, graded against a frozen
     spot, and appended a free HIT to an APPEND-ONLY record -- the exact bug the comment above
     describes. Dates generated from _clock.js holidays(), which is rule-based, then validated:
     its observed() emits an impossible "2028-01-00" for a Saturday New Year (string-decrement,
     no date normalisation) and that entry was rejected. NYSE does not close when Jan 1 falls
     on a Saturday, so the omission is correct -- reached by rejecting a bad string, not by the
     rule. predictions-check.js now FAILS when this table drops under ~18 months of runway. */
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
  "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
  "2029-01-01", "2029-01-15", "2029-02-19", "2029-03-30", "2029-05-28", "2029-06-19",
  "2029-07-04", "2029-09-03", "2029-11-22", "2029-12-25",
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

  /* ── RESOLVABILITY AT CAPTURE, NOT AT GRADE ────────────────────────────────────────────────
     Jake, 2026-09-11: "he doesnt necessarily deny any prediction, the catcher should just not
     catch a prediction unless its data backed."

     ⚠ THIS IS NOT CENSORSHIP AND IT IS NOT NEW DOCTRINE. Dr. NoVo may still SAY anything he
     likes about FOMC, a merger, or a ticker we do not price — the gate decides only what enters
     the graded BOOK. forecast.js:100 already states the rule in those words ("a forecast that
     cannot be machine-graded later never enters the ledger"), and alerts.js:155 already enforces
     exactly this at entry. It had simply never been applied here.

     ⚠ WHAT IT PREVENTS, CONCRETELY. The evaluator prices equity off state.indices and crypto off
     the snapshot's coin map; anything else hits `if (!isFinite(spot)) continue` on every tick
     FOREVER — there is no timeout, no force-resolve and no reaper in this file. Since MAX_OPEN
     caps the book at 40 open rows, forty ungradeable predictions permanently block every real one.
     An unresolvable row is not a harmless row.

     ⚠ UNKNOWN ≠ UNRESOLVABLE. When the snapshot cannot be read we do NOT reject: a KV hiccup must
     not silently stop Dr. NoVo recording. Same shape as alerts.js — reject only on a map we
     actually hold. */
  const assetClass = args.asset_class === "crypto" ? "crypto" : "equity";
  if (assetClass === "equity") {
    if (!EQ_RESOLVABLE.has(symbol)) {
      return { error: symbol + " cannot be graded automatically — the equity record prices "
        + [...EQ_RESOLVABLE].join(", ") + " only. Say it freely; it just is not recorded." };
    }
  } else {
    let snap = null;
    try {
      snap = await r.get("crypto:map:live");
      if (typeof snap === "string") snap = JSON.parse(snap);
    } catch (_) { snap = null; }
    if (snap && snap.coins && !snap.coins[symbol]) {
      return { error: symbol + " is not on the coin map, so nothing can grade it later. "
        + "Say it freely; it just is not recorded." };
    }
  }
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

  /* ── AN EQUITY CALL MUST EXPIRE ON A DAY THE MARKET TRADES ──────────────────────────────────
     Jake, 2026-09-11: "Dr. NoVo shouldn't make a prediction that cant be scored ... he has all
     the data why would he make an unreal prediction."

     Exactly so, and this is the door it used to come through. A NAMED horizon already walks
     forward to the next real session (resolveHorizon), and the tool says so. horizon_min did not:
     its description was "minutes from now (5 to 20160)" and said nothing about a calendar, so a
     window landing on a Saturday or a holiday was a perfectly reasonable thing to ask for. There
     is no print at such a horizon, only the last one — grading against it compares a frozen price
     to itself and mints a free hit.

     Refused rather than quietly moved: silently re-dating his call would put a claim on the record
     he did not make, which is the same defect as grading it wrong. The next real close is named in
     the message so he can restate it as the call he actually means. */
  if ((args.asset_class === "crypto" ? "crypto" : "equity") === "equity" && !isTradingDayEt(horizon_utc)) {
    const next = resolveHorizon("tomorrow_close", horizon_utc);
    return { error: "that horizon lands when the market is shut, so nothing could grade it. "
      + "The next close is " + (next ? new Date(next).toISOString() : "the next session")
      + " — state the window you actually mean, or use a named horizon." };
  }

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

/* ── A TOUCH IS A PROPERTY OF THE PATH, NOT OF A SAMPLE ────────────────────────────────────
   Jake, 2026-09-08: "SPY touches 768 -> MISS ... ACTUAL 768.8" while the session low was 767.52.
   The call was right and the record said it was wrong.

   The old check compared the CURRENT spot on each publish and, at the horizon, wrote whatever
   spot happened to be at that instant as "ACTUAL". Two things follow, and both are wrong:

     1. A touch that happens BETWEEN polls is never seen. The evaluator runs on the publish tick;
        price does not. Anything that dips through the level and recovers inside the gap is graded
        a miss - and on 2026-09-08 the engine was down for eight hours, so the gap was the whole
        overnight session.
     2. The number printed as ACTUAL is a sampled instant with no relationship to the claim. For
        "does it reach 768", the only number that can support or refute it is the FURTHEST the
        price actually got. 768.8 was neither the extreme nor evidence of anything.

   So the row now carries its own running extreme, updated from every spot this evaluator has
   ever seen, and the verdict reads off that. ACTUAL becomes the extreme in the direction of the
   claim: on a hit it is where it got to, on a miss it is how close it came - which is auditable
   either way. Still poll-bound (nothing here sees between two ticks), but a running extreme
   cannot un-see a touch it has already observed, and the old one could. */
function _touchStep(p, spot, now) {
  const up = p.spot_at < p.value;                 // reaching UP to the level, or DOWN to it
  if (!isFinite(p.path_hi) || spot > p.path_hi) p.path_hi = spot;
  if (!isFinite(p.path_lo) || spot < p.path_lo) p.path_lo = spot;
  const reach = up ? p.path_hi : p.path_lo;       // the furthest it has come toward the level
  const reached = up ? (reach >= p.value) : (reach <= p.value);
  if (reached) {
    p.status = "graded";
    p.outcome = { actual: reach, hit: true, graded_utc: now, basis: "session extreme" };
    return true;
  }
  if (now >= p.horizon_utc) {
    p.status = "graded";
    p.outcome = { actual: reach, hit: false, graded_utc: now, basis: "session extreme",
                  missed_by: +Math.abs(reach - p.value).toFixed(2) };
    return true;
  }
  return false;                                   // still open, extreme carried on the row
}

async function evaluate(getSpot) {
  const r = kv();
  if (!r) return { graded: 0 };
  const list = await _load(r);
  const now = Date.now();
  let changed = 0;
  for (const p of list) {
    if (p.status !== "open") continue;
    /* ⚠ AN EQUITY HORIZON ON A CLOSED MARKET ROLLS FORWARD. IT IS NOT VOIDED, AND IT IS NEVER
       GRADED WHERE IT LANDED.
       Jake, 2026-09-11: "'voided' is not a feature ... remove it." It is gone as a status — but
       the hazard it was covering is real and stays covered, because the alternative is worse than
       either: grading a holiday horizon compares a frozen spot to itself and mints a FREE HIT, and
       a record with free hits in it is not a record.
       resolveHorizon already refuses to put a NAMED horizon on a non-trading day, so only a
       horizon_min call can land here (a Friday afternoon +4320m, say). Rolling it to the next
       session's close is strictly better than voiding: the call still gets a real grade against a
       real print, nothing is excused, and there is no third bucket in the score. */
    if (p.asset_class === "equity" && Date.now() >= p.horizon_utc && !isTradingDayEt(p.horizon_utc)) {
      const nextClose = resolveHorizon("tomorrow_close", p.horizon_utc);
      if (nextClose && nextClose > p.horizon_utc) {
        p.horizon_utc = nextClose;
        p.rolled = (p.rolled || 0) + 1;
        changed++;
        continue;                      // still open; it grades at the next real close
      }
    }
    const spot = getSpot(p);
    if (!isFinite(spot)) continue;
    if (p.kind === "level_touch") {
      if (_touchStep(p, spot, now)) changed++;
      continue;
    }
    if (now >= p.horizon_utc) {
      p.status = "graded"; p.outcome = _grade(p, spot);
      await _remember(r, p);   // the permanent record, written once, at the transition
      changed++;
    }
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
        /* Members are scored exactly as strictly as NoVo is, on the same rule — so their
           holiday-horizon calls roll forward too, rather than being quietly excused. */
        if (p.asset_class === "equity" && Date.now() >= p.horizon_utc && !isTradingDayEt(p.horizon_utc)) {
          const nc = resolveHorizon("tomorrow_close", p.horizon_utc);
          if (nc && nc > p.horizon_utc) { p.horizon_utc = nc; p.rolled = (p.rolled || 0) + 1; ch++; continue; }
        }
        const spot = getSpot(p);
        if (!isFinite(spot)) continue;
        if (p.kind === "level_touch") {
          if (_touchStep(p, spot, now)) ch++;
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

/* ⚠ FILTERED PER DESK, BECAUSE THE PANEL BESIDE IT ALREADY IS.
   Temi, 2026-09-11, measured the crypto map's Predictions tab showing five EQUITY tickers and no
   crypto at all: "SPY closes at 770 ... QQQ closes at 720 → MISS ...". Not a leak — they are the
   member's own calls — but listPredictions() filters NOVO's book by asset_class while this one
   returned everything, so a single panel filtered one book and not the other. The crypto desk
   showed his crypto calls and the member's equity ones side by side.
   A member's calls still live in ONE book; this only decides which desk displays them, exactly as
   it already works for his. */
async function listUserPredictions(email, limit, assetClass) {
  const r = kv();
  if (!r) return null;
  let mine = await _uload(r, _uhash(email));
  if (assetClass) mine = mine.filter((p) => p.asset_class === assetClass);
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
    score, overall,
  };
}

// ── MARKET ALERTS — the curated feed ─────────────────────────────────────────────────────────
// Jake, 2026-09-07: the private crypto and equity alerts get a UI surface — "a curated list
// surfaced into the Alerts tab as Dr. NoVo's Alerts when edges are found we dont want those rapid
// fire hosing into that page we wont the good ones. thats why everything is graded."
// ⚠ RENAMED to Market Alerts on 09-12 — the quote above is kept verbatim as the origin of the
// FEED, not of its name. These are the engine's edge-cleared fires; Dr. NoVo reads them, he does
// not make them. See _lib/alert-record.js for the ruling.
// The GRADING IS THE CURATOR: nothing enters this feed unless the rule that fired it has proven
// out-of-sample edge at or above its own floor. The raw firehose stays where it is (the map's
// feed, the chat tools); this list is only what cleared the bar.
const FEED_KEY = "novo:alerts:feed";
/* Every fire that reaches this function has cleared the edge gate and is being shown to comp
   seats — that is Jake's "released comp seat alerts" stage, counted at the moment of release
   rather than inferred later from a list length. */
async function appendNovoFire(entry, grade) {
  try { await bump("released", 1); } catch (_) {}
  /* THE FIRE IS ALSO RECORDED AS A GRADEABLE MARKET ALERT. The feed row below stays exactly what
     it was — prose for the panel — while the numbers the engines grade against go to the alert
     book. Best-effort: a bookkeeping failure must never cost a seat its alert.
     ⚠ THIS BOOK IS THE ENGINE'S, NOT DR. NoVo'S (Jake, 2026-09-12, superseding his 09-11 "graded
     alone as an alert not a prediction" framing). Every entry reaching this function cleared the
     edge gate above — arithmetic on the engine's own base-rate table, no model call — so it scores
     on the engine's side. Anything Dr. NoVo originates is a PREDICTION and is already in pred:log
     under his grade; there is no third category between them. See _lib/alert-record.js. */
  try {
    await require("./alert-record.js").recordRelease(Object.assign({}, entry, grade || {}));
  } catch (_) {}
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
/* The actions that carry a measured claim. WATCH is deliberately absent: chain_alerts.py defines
   it as "no measurable edge", so it can never belong in a feed headed "edge-cleared only". MOVE
   stays - it is not directional, but "both sides are elevated" IS a measurement, and it says so
   in its own words rather than dressing a coin flip as a call. */
const ACTIONABLE = new Set(["BUY", "AVOID", "MOVE"]);

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
      /* ⚠ A "WATCH" IS NOT AN EDGE-CLEARED ALERT, AND THE FEED IS LABELLED "EDGE-CLEARED ONLY".
         chain_alerts.py:25-29 defines the four actions, and it could not be plainer:
           BUY    reaching target beats reaching stop AND beats the baseline
           AVOID  the reverse
           MOVE   both sides elevated, no directional winner - "something is coming, I do not
                  know which way", said plainly because a coin flip presented as a call is the
                  most expensive kind of wrong
           WATCH  "when there is no measurable edge: tracked and graded the same, NEVER presented
                  as something to put money on"
         Jake's screenshots, 2026-09-09: twenty-odd tickets in ten minutes under "DR. NOVO'S
         ALERTS - EDGE-CLEARED ONLY", most of them WATCH rows whose own text ends "so I am not
         calling it" - with an edge receipt stapled underneath. The header asserted exactly what
         the body denied. WATCH is tracked and graded elsewhere; it does not belong here. */
      const action = String(t.action || "").toUpperCase();
      if (!ACTIONABLE.has(action)) continue;

      const lv = levels[t.kind];
      const edge = lv && lv.oos_trig_target != null && lv.oos_base_target != null
        ? lv.oos_trig_target - lv.oos_base_target : null;
      const floor = lv && lv.edge_floor_pp != null ? lv.edge_floor_pp : 5;
      if (edge == null || !(edge >= floor)) continue;         // no proven edge, no surface

      /* ── PROVE IT OR STOP: THE RULE'S OWN RELEASED ALERTS GET A VOTE ────────────────────────
         Jake, 2026-09-11: "<100 alerts, <10 released comp seat alerts ... anything else and the
         system/Dr. NoVo is fire hosing and not getting anywhere." Measured that day: 513 released
         over three days — 43/day against a bar of 10 — and EVERY ONE of them from a single rule,
         chain_pump_buyers, whose released alerts came back 21 win / 26 loss.

         The gate above only ever asked the ENGINE's question: does this rule's POPULATION show
         out-of-sample edge. It never asked the one that matters to a seat: did the tickets we
         actually put in front of him work. Those are different questions and here they disagreed.

         So a kind releases freely until its released alerts have decided enough to speak for
         themselves, and after that it has to be winning. MIN_DECISIVE is the same 30 the rest of
         this file uses for "enough to mean something", and the bar is 50% because a BUY that wins
         less than half its decided tickets is not an edge-cleared alert, whatever the population
         says. A rule silenced here is not retired: it keeps being graded by the engine, and it
         starts releasing again the moment its own record clears the bar. */
      const STANDING_MIN_DECISIVE = 30;
      const STANDING_MIN_RATE = 50;
      try {
        const st = await require("./alert-record.js").ruleStanding(t.kind);
        if (st.decisive >= STANDING_MIN_DECISIVE && st.hitRate != null
            && st.hitRate < STANDING_MIN_RATE) {
          continue;   // its own released alerts say no
        }
      } catch (_) { /* no record yet, or KV down: fall through to the engine's edge alone */ }
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
        /* ⚠ SAY WHAT WAS ACTUALLY MEASURED. `edge` comes from levels[t.kind] - it is the
           KIND's out-of-sample record, not this ticket's. The old wording, "oos edge +15.0pp
           over its own floor 5", printed identically under every ticket and read as though DESK
           and RPEPE had each been measured at +15pp. Nothing was measured about either. Name the
           kind so the receipt is a true sentence. */
        receipts: t.kind + ": +" + edge.toFixed(1) + "pp out-of-sample over its floor of "
          + floor + "pp (the rule's record, not this ticket's)",
      }, {
        /* The join key and the barriers, carried as NUMBERS. The claim string above says the same
           thing in prose, and prose spanning $80,000 to $0.0000000004 cannot be parsed back. */
        eng_ts: t.ts_utc, eng_code: t.asset_code, action: action,
        entry_px: t.entry != null ? t.entry : t.spot,
        target_px: t.target_px, stop_px: t.stop_px,
        target_pct: t.target_pct, stop_pct: t.stop_pct, deadline: t.deadline,
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
// ONE DECISION, ONE BAR. Clearing it makes the fire a MARKET ALERT; failing it leaves the fire
// exactly where it was — in the private hash-chained equity record, chat-pull only, waiting to
// earn its way up. That is Jake's rule stated as code: "when an edge is found in those alerts it
// is approved for [Market Alerts] ... as long as it holds an edge" — the bracket is the 09-12
// rename; the sentence is his, from 09-07.
//
// ⚠ THIS SAID "TWO DECISIONS" AND MINTED A PREDICTION TOO. It no longer does: `onEquityFire` sets
// `predicted = false` and writes only the alert. An engine fire clearing an arithmetic edge gate
// is the ENGINE's claim, and recording it as Dr. NoVo's prediction credited him with work he did
// not do — exactly the redundancy Jake named on 09-12 ("the alerts he brings forward is redundant
// with predictions"). The behaviour was already right; this comment was still describing the old
// shape, which is how the next reader re-introduces it.
const EQ_MIN_RESOLUTIONS = 30;
const EQ_MIN_EDGE_PP = 5;
async function onEquityFire(fire) {
  const r = kv();
  if (!r || !fire || !fire.rule || !fire.symbol) return { surfaced: false, predicted: false };
  const rec = fire.record || {};
  const spot = Number(fire.spot_at);
  const hm = Number(fire.horizon_min) >= 5 ? Number(fire.horizon_min) : 60;
  /* Same fallback shape as the crypto path had: anything that is not literally "up" became a
     DOWN call, including a missing field. The engine constrains it today
     (equity_signals: CHECK(direction IN ('up','down'))), so this has never fired -- but a guard
     that only holds because a different repo has a CHECK constraint is not a guard. Reject
     instead of defaulting. */
  const dirRaw = String(fire.direction || "").trim().toLowerCase();
  if (dirRaw !== "up" && dirRaw !== "down") {
    return { surfaced: false, predicted: false, why: "no direction on the fire" };
  }
  const side = dirRaw;
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
  /* Same correction as the crypto gate above: this promotes an earned alert, it does not
     author a prediction for him. See _lib/novo-calls.js for the calls that are actually his. */
  const predicted = false;
  await appendNovoFire({
    asset_class: "equity", symbol: fire.symbol, kind: fire.rule,
    title: fire.symbol + " " + side + " — " + (fire.reading || fire.rule),
    horizon_min: hm, receipts: receipts,
  }, {
    /* eng_ts is whatever the engine sent; today's eye_fire payload carries none, so the equity
       join falls back to (ticker, rule) + time proximity. See joinEquityResolutions. */
    eng_ts: fire.ts_utc || null, eng_code: fire.symbol,
    direction: side, entry_px: isFinite(spot) ? spot : null,
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
/* Kinds whose CLAIM is not directional. A base rate can still be computed for them -- and should
   be, on their own terms -- but they must never be turned into an up/down call.
   cost_anomaly: the claim is that a wide round trip is transient (signals.py:503). */
const NO_DIRECTION = new Set(["cost_anomaly"]);

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
      /* ⚠ NO DIRECTION IN THE SIGNAL MEANS NO CALL. This line used to read
             const side = (rate.avg_move != null && rate.avg_move < 0) ? "down" : "up";
         so a NULL avg_move silently became a bullish call. Measured 2026-09-09: 94 of 94 graded
         alerts were "up", every one from cost_anomaly, hitting 34%. That is not an analyst with a
         bullish lean, it is a constant.

         cost_anomaly has no directional content to begin with. signals.py:503 states its claim:
         "an unusually wide round trip is TRANSIENT, so it is right when the cost comes back in."
         That is a spread claim. Forcing it into a direction prediction and grading it as one is
         the grading fault Jake's rule covers: "if something doesnt make sense grading or cant get
         even a decent score its grading is pulled."

         So: the side must be EARNED from a signed avg_move. Absent or flat, the fire stays a
         public reading and makes no prediction. NO_DIRECTION lists kinds that can never earn one
         regardless of what the base rate reports. */
      if (NO_DIRECTION.has(f.kind)) continue;
      if (rate.avg_move == null || !isFinite(Number(rate.avg_move)) || Number(rate.avg_move) === 0) continue;
      const side = Number(rate.avg_move) < 0 ? "down" : "up";
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
      /* ⚠ THE GATE PROMOTES AN ALERT. IT DOES NOT MAKE A PREDICTION IN HIS NAME.
         Jake, 2026-09-09, on the gate: "correct here no issue" — promoting an edge-cleared alert
         to the comp-seat feed is exactly right. What was wrong is that the same gate also wrote a
         `source:"novo"` prediction row, which the crypto map then rendered as
         "DR. NOVO'S CALLS · SELF-INITIATED" with the signal's own claim string as his thesis.
         predictions.js has never contained a model call. 95 graded rows, every one "up", every one
         cost_anomaly, 33.7% — a threshold cannot have a bad week, it has a number.
         His own calls now come from _lib/novo-calls.js, where he actually reads the book. */
      await appendNovoFire({ asset_class: "crypto", symbol: sym, kind: f.kind,
        title: sym + " " + side + " within " + (hm >= 60 ? Math.round(hm / 60) + "h" : hm + "m"),
        horizon_min: hm,
        receipts: rate.hit_rate + "% over " + rate.n_cells + " coin-days vs "
          + baseShare.toFixed(1) + "% base" });
      made++;
      try { await r.set(seenKey, "1", { ex: 7 * 24 * 3600 }); } catch (_) {}
    } catch (_) { /* one bad reading must not stop the pass */ }
  }
  return { made };
}


/* ── NOVO'S OWN RECORD ─────────────────────────────────────────────────────────────────────────
   Jake, 2026-09-09: "every alert, prediction, report bias, audit bias, convo prediction every
   single thing everything that comes from Dr. novo and gets graded must be included in the all
   time grade. not engine math scores. Dr. novo scores."

   This GRADES NOTHING. Every row it counts was already graded by _grade() at its horizon and
   carries `hit` true/false. This only tallies them, so the owner dashboard can show the record
   that already exists rather than a second opinion of it.

   SOURCES ARE KEPT APART, because they are different acts and Jake names them separately:
     novo          a call he initiated off the data — the alerts
     read          a call the catcher pulled out of a published report
     conversation  a call he made when asked
   `user` is EXCLUDED: those are the member's own predictions, not his. Counting them would put
   other people's calls in his grade.

   ⚠ THE HISTORY ROLLS. _save() keeps only the last MAX_KEPT (400) graded rows, so this is "his
   record as far back as storage goes", not literally all-time. `capped` says so, and the caller
   is expected to surface it rather than let the number silently claim more than it has. */
/* THE RULE A PREDICTION CAME FROM, or nothing. The `rule` cut exists to show WHICH SIGNAL is
   losing, which only works if rows sharing a rule share a bucket.
   It read `basis.split(" · ")[0].slice(0, 40)` on EVERY row. That is right for the signal
   selector, which writes "<rule> · <receipts>" — and wrong for every other source, because
   nothing else writes that shape: novo-calls lets the model supply free prose, read-predictions
   writes "caught in <title>", the digest writes "the 09:25 digest", and the chat writes whatever
   it likes. A free-text basis has no " · ", so the split returns the whole sentence and the slice
   makes a 40-character prose fragment into a bucket key — one bucket per prediction, forever, so
   the cut can never aggregate and the dimension is decoration.
   Seen live 2026-09-11 on build 568711e3: rule = "SPY spot 764.90 sits above flip 761.79 i".
   A conversation prediction has no rule that fired it. The honest key is NONE — bump() already
   drops null, so an unruled row simply does not enter the dimension. */
function ruleOf(basis) {
  const s = String(basis || "");
  if (!s.includes(" · ")) return null;          // no rule/receipts shape, so no rule
  const rule = s.split(" · ")[0].trim();
  return rule ? rule.slice(0, 40) : null;
}

async function novoRecord() {
  const r = kv();
  // kv() returns null when the store is not configured. listPredictions guards this; so must we,
  // or a missing KV throws inside _load and the whole ops payload 500s over a panel.
  if (!r) return { error: "predictions unavailable", by_source: {}, overall: null, window: null, open: 0, counted: 0, capped: MAX_KEPT };

  /* ALL-TIME comes from the TALLY, not from the log. The log is a rolling window by design, so
     counting it would silently mean "the last 400 and drifting" -- the exact thing Jake called
     out. The tally is incremented once per graded row and never trimmed. */
  let tally = null;
  try { tally = await r.hgetall(TALLY); } catch (_) { tally = null; }

  /* ONE-TIME SEED. The tally starts empty and only accrues from the moment it shipped, so every
     row graded BEFORE that would be missing from an "all-time" number — history we already have,
     dropped on the floor, which is the one thing Jake said must never happen. Seed it once from
     the working set, then flag it so a second call cannot double-count.
     The flag is claimed with SETNX BEFORE the increments: two lambdas can run this concurrently,
     and claiming after would let both pass the check and tally the same rows twice. */
  if (!tally || !Object.keys(tally).length) {
    let claimed = false;
    try { claimed = !!(await r.setnx(TALLY + ":seeded", String(Date.now()))); } catch (_) { claimed = false; }
    if (claimed) {
      try {
        for (const p of await _load(r)) {
          if (!p || p.status === "open") continue;
          const src = (p.source === "user" || p.source === "engine") ? p.source : (p.source || "conversation");
          const h = p.outcome && typeof p.outcome.hit === "boolean" ? p.outcome.hit : null;
          if (h === null) { await r.hincrby(TALLY, "ungraded:" + src, 1); continue; }
          await r.hincrby(TALLY, "n:" + src, 1);
          if (h) await r.hincrby(TALLY, "hit:" + src, 1);
        }
        tally = await r.hgetall(TALLY);
      } catch (_) { /* leave the tally as-is; the window still renders */ }
    }
  }
  const by_source = {};
  let n = 0, hit = 0, ungraded = 0;
  for (const k of Object.keys(tally || {})) {
    const v = Number(tally[k]); if (!Number.isFinite(v)) continue;
    const [what, src] = k.split(":");
    // "user" = the member's own calls. "engine" = rows the edge gate minted before
    // 2026-09-09; re-attributed, kept, and out of his grade. Neither is Dr. NoVo.
    if (src === "user" || src === "engine") continue;
    const t = (by_source[src] = by_source[src] || { n: 0, hit: 0, ungraded: 0, rate: null });
    if (what === "n") { t.n += v; n += v; }
    else if (what === "hit") { t.hit += v; hit += v; }
    else if (what === "ungraded") { t.ungraded += v; ungraded += v; }
  }
  for (const k of Object.keys(by_source)) {
    const t = by_source[k];
    t.rate = t.n ? +((100 * t.hit) / t.n).toFixed(1) : null;
  }

  /* THE ROLLING WINDOW — "The Analyst's Score", recent form. Read off the working set.
     ⚠ THE GRADE LIVES ON p.outcome.hit, NOT p.hit. evaluate() writes `p.outcome = _grade(...)`.
     The first version of this function read p.hit, which is undefined on every row, so it would
     have counted zero and reported a confident empty record. Caught by reading evaluate() rather
     than assuming the shape. */
  const list = await _load(r);
  const win = { n: 0, hit: 0, rate: null, by_source: {} };
  let open = 0;
  for (const p of list) {
    if (!p || p.source === "user" || p.source === "engine") continue;
    if (p.status === "open") { open++; continue; }
    const h = p.outcome && typeof p.outcome.hit === "boolean" ? p.outcome.hit : null;
    if (h === null) continue;
    const src = p.source || "conversation";
    const t = (win.by_source[src] = win.by_source[src] || { n: 0, hit: 0, rate: null });
    t.n++; win.n++; if (h) { t.hit++; win.hit++; }
  }
  for (const k of Object.keys(win.by_source)) {
    const t = win.by_source[k]; t.rate = t.n ? +((100 * t.hit) / t.n).toFixed(1) : null;
  }
  win.rate = win.n ? +((100 * win.hit) / win.n).toFixed(1) : null;

  /* ── DIAGNOSTICS ──────────────────────────────────────────────────────────────────────────
     Jake, 2026-09-09: "everything is scored so Dr. NoVo can get better ... we give him
     everything he needs to be the greatest, that is our job."
     A single rate says he is wrong; it cannot say WHERE. These cuts can: a record that is fine
     on one side and awful on the other is a sign or threshold fault, not a skill problem, and
     the two need completely different fixes. Cut by side, kind, symbol, horizon and rule. */
  const cut = {};
  const bump = (dim, key, hitv) => {
    if (key === null || key === undefined || key === "") return;
    const d = (cut[dim] = cut[dim] || {});
    const t = (d[key] = d[key] || { n: 0, hit: 0, rate: null });
    t.n++; if (hitv) t.hit++;
  };
  for (const p of list) {
    if (!p || p.source === "user" || p.source === "engine") continue;
    if (p.status === "open") continue;
    const h = p.outcome && typeof p.outcome.hit === "boolean" ? p.outcome.hit : null;
    if (h === null) continue;
    bump("side", p.side, h);
    bump("kind", p.kind, h);
    bump("symbol", p.symbol, h);
    bump("source_side", (p.source || "?") + ":" + (p.side || "?"), h);
    const mins = p.horizon_utc && p.made_utc ? Math.round((p.horizon_utc - p.made_utc) / 60000) : null;
    bump("horizon", mins === null ? null : mins <= 60 ? "<=60m" : mins <= 240 ? "1-4h" : mins <= 1440 ? "4-24h" : ">24h", h);
    // the rule that fired it, off the basis string the selector writes: "<rule> · <receipts>"
    bump("rule", ruleOf(p.basis), h);
  }
  for (const dim of Object.keys(cut)) {
    for (const k of Object.keys(cut[dim])) {
      const t = cut[dim][k]; t.rate = t.n ? +((100 * t.hit) / t.n).toFixed(1) : null;
    }
  }

  return {
    by_source,                                   // ALL-TIME, from the permanent tally
    overall: n ? { n, hit, rate: +((100 * hit) / n).toFixed(1) } : null,
    ungraded,
    window: { ...win, size: MAX_KEPT },          // recent form, from the rolling working set
    cut,                                         // where he is losing, not just that he is
    open,
    counted: n,
    capped: MAX_KEPT,
    tallied: !!tally && Object.keys(tally).length > 0,
  };
}

module.exports = { novoRecord, ruleOf, makePrediction, listPredictions, evaluate, selectCryptoPredictions,
                   makeUserPrediction, listUserPredictions,
                   BTC_NEUTRAL_PCT, BTC_NEUTRAL_PROV,
                   onEquityFire,
                   appendNovoFire, listNovoFires, curateChainFires,
                   evaluateEquityPredictions, evaluateCryptoPredictions };
