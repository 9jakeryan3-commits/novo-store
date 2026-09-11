// api/_lib/alert-record.js — Dr. NoVo's ALERTS, graded as alerts.
//
// Jake, 2026-09-11: "alerts are Dr. NoVo saying 'buy now' and should be graded alone as an alert
// not a prediction." And: "Dr. NoVo gives both equities and crypto alerts ... alerts are comp only,
// im the only comp, owner dashboard score tracking."
//
// THIS IS THE SIBLING OF pred:log, NOT A BRANCH OF IT. An alert and a prediction are different
// claims and must never share a denominator: a prediction is a forward statement about an outcome,
// an alert is an instruction to act. Folding them together would produce one hit rate that answers
// neither question. Same retention doctrine as predictions.js, same exactly-once tally, separate
// keys — so a filter bug cannot leak one book into the other's score.
//
// ⚠ THIS MODULE DOES NOT GRADE. IT RECORDS AND IT JOINS.
// Both engines already grade. Novo-crypto walks every ticket's price path off rh_quotes and writes
// target/stop/flat into readings; NoVo-Pulse resolves every equity signal into
// equity_signal_resolutions with hit/miss/flat/no_data. novo-store has no price path for a Solana
// micro-cap and no intraday bar history for a ticker — a second grader here would be two publishers
// with one guard between them (the failure predictions.js:656 already warns about) and the two
// would disagree the first day either changed. The engines stay the ONLY graders; this file joins
// their verdicts onto the alerts we actually released.
//
// ⚠ THE TWO ASSET CLASSES ARE GRADED ON DIFFERENT QUESTIONS, AND THAT IS NOT A BUG.
//   crypto  a BARRIER RACE. The ticket carries entry, target_px, stop_px and a deadline; the
//           engine records which barrier was touched first (chain_alerts.py:341).
//   equity  a DIRECTIONAL CALL. The fire carries direction and spot_at only — no target, no stop —
//           and the engine grades |move| against a ±5bp dead band on the close at the horizon
//           (equity_signals.py:262-267).
// Normalising both to win / loss / flat is therefore a deliberate lossy step, taken so one
// scoreboard can exist. The engine's own word is kept on every row beside the normalised one, and
// the per-class breakdown is published, so nobody ever has to take the merged number on faith.
//
// ⚠ RELEASED = SETTLED + OPEN + UNRESOLVED, AND THE SCOREBOARD PRINTS ALL THREE.
// Both engines publish resolutions through a WINDOW (crypto: recent LIMIT 40; equity:
// recent_resolved LIMIT 20). If resolutions outrun the publish cadence, some released alerts will
// never be SEEN resolving. A scoreboard built only from the ones we caught would be
// survivorship-biased upward — a hit rate that can only report successes, the dominant defect
// class on this system. So `released` is counted at release and settled + open + unresolved must
// reconcile against it. If they do not, the scoreboard says so rather than printing a prettier
// number.

const crypto = require("crypto");
const { kv } = require("./../_kv.js");

const KEY = "alert:log";                                                     // working set
const ARCH = (ms) => "alert:arch:" + new Date(ms).toISOString().slice(0, 7); // no TTL, never trimmed
const TALLY = "alert:tally";                                                 // no TTL, O(1) all-time
const MAX_KEPT = 400;
const WORKING_TTL_S = 365 * 24 * 3600;

/* Grace after the deadline before an alert is written off as unresolved. The engine resolves on
   its own pass and the snapshot has to make one more trip, so "past deadline" is not yet "never
   coming". Generous on purpose: writing off a live alert understates the record, and a late
   verdict is still a real verdict. */
const GRACE_MIN = 90;

/* ── THE ENGINES' VOCABULARIES, NORMALISED IN EXACTLY ONE PLACE ──────────────────────────────
   Mapped here and nowhere else, so the two records can never drift into disagreeing about what
   "a win" means.

   ⚠ no_data IS NOT flat. The equity resolver emits no_data when it had no bars to grade against
   (equity_signals.py CHECK constraint). That is the engine saying "I could not answer", which is
   the same thing as unresolved — whereas flat is the engine saying "I answered: nothing happened".
   Collapsing them would quietly convert a measurement failure into a real, countable outcome. */
const NORM = {
  crypto: { target: "win", stop: "loss", flat: "flat", no_data: "unresolved" },
  equity: { hit: "win", miss: "loss", flat: "flat", no_data: "unresolved" },
};
function normalize(assetClass, raw) {
  const m = NORM[assetClass === "crypto" ? "crypto" : "equity"];
  return m[String(raw || "").toLowerCase()] || null;
}

async function _load(r) {
  let l = null;
  try { l = await r.get(KEY); } catch (_) { l = null; }
  if (typeof l === "string") { try { l = JSON.parse(l); } catch (_) { l = null; } }
  return Array.isArray(l) ? l : [];
}

async function _save(r, list) {
  const open = list.filter((a) => a.status === "open");
  const done = list.filter((a) => a.status !== "open").slice(-MAX_KEPT);
  await r.set(KEY, JSON.stringify([...done, ...open]), { ex: WORKING_TTL_S });
}

/* THE JOIN KEYS ARE THE ENGINES' OWN ROW IDENTITIES, NOT OURS.
   crypto  chain_alerts.feed() selects open and resolved tickets from the SAME readings table — a
           row keeps its ts_utc when resolved_utc is stamped and it moves from `open` to `recent`.
           curateChainFires already hashes exactly (asset_code, kind, ts_utc) for its release
           dedupe, which is what proves the triple stable in practice rather than in theory: if it
           drifted, alerts would be re-released, and they are not.
   equity  equity_signals.feed() publishes recent_resolved as
           (ticker, rule, direction, fired=s.ts_utc, horizon_min, outcome, ...) — with NO signal
           id. So (ticker, rule, fired) names the signal and horizon_min selects which of its
           resolutions this is. */
/* ⚠ KEYED ON THE ENGINE'S RAW asset_code, NEVER THE DISPLAY SYMBOL.
   curateChainFires stores symbol as asset_code.toUpperCase() for display, and a chain ticket's
   asset_code is "network:address" where the address is base58 — which is CASE-SENSITIVE. Uppercasing
   it is lossy, so two distinct tokens can collapse onto one id. The display string stays on the row
   for reading; the join uses the bytes the engine actually has. */
function alertId(assetClass, engCode, kind, engTs) {
  return crypto.createHash("sha256")
    .update(String(assetClass) + "|" + String(engCode) + "|" + String(kind) + "|" + String(engTs))
    .digest("hex").slice(0, 24);
}

/* Called ONCE, at the moment a row stops being open. Exactly-once by construction: a row becomes
   settled exactly once, whereas "about to be trimmed from the working set" is a condition that can
   be true twice across two saves. Same reasoning as predictions.js _remember, and the same swallow:
   a lost archive append is recoverable from the working set, but a throw here would abort the whole
   join and lose the grade as well. */
async function _settle(r, a) {
  if (!r || !a) return;
  try {
    await r.rpush(ARCH(Date.now()), JSON.stringify(a));      // no TTL: this is the record
    const cls = a.asset_class === "crypto" ? "crypto" : "equity";
    const kind = String(a.kind || "unknown").slice(0, 60).replace(/:/g, "_");
    const inc = async (k) => { try { await r.hincrby(TALLY, k, 1); } catch (_) {} };

    await inc("settled");
    await inc("settled:" + cls);

    if (a.status === "unresolved") {
      /* NOT A MISS. Either the verdict never reached us, or the engine itself returned no_data.
         Counting it as a loss would punish the alert for our plumbing; counting it as a win is
         obviously worse. It is its own bucket, printed beside the rate and never inside it. */
      await inc("unresolved");
      await inc("unresolved:" + cls);
      return;
    }

    /* THE DENOMINATOR IS DECISIVE OUTCOMES, AND flat IS NOT ONE.
       chain_alerts.py learned this the expensive way — see its header: chain_rug_risk read 93.9%
       "correct" over 66 resolutions, 58 of which were flat. That is a rate over 8 real decisions
       wearing a denominator of 66. A claim that touched no barrier, or moved less than the dead
       band, decided nothing. It is counted, named, and kept OUT of the hit rate. */
    const o = a.outcome;                                     // already normalised at join time
    if (o === "win") { await inc("win"); await inc("win:" + cls); await inc("k:" + kind + ":win"); }
    else if (o === "loss") { await inc("loss"); await inc("loss:" + cls); await inc("k:" + kind + ":loss"); }
    else { await inc("flat"); await inc("flat:" + cls); await inc("k:" + kind + ":flat"); }

    if (o === "win" || o === "loss") {
      await inc("decisive"); await inc("decisive:" + cls); await inc("k:" + kind + ":decisive");
    }
  } catch (_) { /* the grade is already in the working set; never let bookkeeping cost it */ }
}

/**
 * Record an alert at the moment it is RELEASED to a comp seat.
 *
 * Called from appendNovoFire — the single chokepoint every released alert passes through, equity
 * and crypto alike. Recording anywhere else would grade one asset class and silently miss the other.
 *
 * ⚠ THE NUMBERS ARE THE POINT. The feed row stores the alert as PROSE ("BUY DRAFT at $0.0017...
 * Target $0.0019 (+14.7%), stop ..."). Prose cannot be graded without parsing it back out, and a
 * regex over a money-formatted string spanning $80,000 to $0.0000000004 is a bug with a delay fuse.
 * The structured entry / target / stop / deadline are carried here as numbers.
 */
async function recordRelease(entry) {
  try {
    const r = kv();
    if (!r || !entry) return null;
    const assetClass = entry.asset_class === "crypto" ? "crypto" : "equity";
    const engTs = entry.eng_ts || entry.ts_utc || null;
    /* the engine's own code, unmodified; falls back to symbol only when the caller has nothing else */
    const engCode = entry.eng_code != null ? String(entry.eng_code) : String(entry.symbol || "");

    /* No engine timestamp means no join key: this alert could never be matched to its verdict, so
       it would sit open until the grace expired and then be written off as unresolved, quietly
       dragging the reconciliation down. Record it as unjoinable and COUNT that, rather than mint
       an id that cannot match anything and call the book complete. */
    const joinable = !!engTs;
    const id = joinable
      ? alertId(assetClass, engCode, entry.kind, engTs)
      : "nojoin:" + crypto.randomBytes(8).toString("hex");

    const list = await _load(r);
    if (joinable && list.some((a) => a.id === id)) return id;   // one release, one row, ever

    const num = (v) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
    const row = {
      id, joinable,
      ts: Date.now(),
      eng_ts: engTs,
      asset_class: assetClass,
      eng_code: engCode,
      symbol: String(entry.symbol || "").slice(0, 40),
      kind: String(entry.kind || "").slice(0, 60),
      action: String(entry.action || "").toUpperCase().slice(0, 12) || null,
      direction: entry.direction ? String(entry.direction).toLowerCase().slice(0, 8) : null,
      entry_px: num(entry.entry_px != null ? entry.entry_px : entry.entry),
      target_px: num(entry.target_px),
      stop_px: num(entry.stop_px),
      target_pct: num(entry.target_pct),
      stop_pct: num(entry.stop_pct),
      deadline: entry.deadline || null,
      /* ⚠ EQUITY: THE ADVERTISED HORIZON IS THE ONE THIS ALERT IS GRADED AT.
         An Eye fire registers three horizons (15/30/60) and therefore produces THREE resolution
         rows, while the alert shown to the seat advertises only hmax. Joining without pinning the
         horizon would grade one alert three times and triple its weight in the denominator. */
      horizon_min: num(entry.horizon_min),
      title: String(entry.title || "").slice(0, 240),
      receipts: String(entry.receipts || "").slice(0, 240),
      status: "open",
      result_raw: null, outcome: null, outcome_pct: null, move_bp: null, graded_ts: null,
    };

    list.push(row);
    await _save(r, list);

    /* RELEASED IS COUNTED AT RELEASE, not inferred later from a list length — the same reasoning
       appendNovoFire already applies to its own funnel counter. This is the number every other
       number in the scoreboard has to reconcile against. */
    try {
      await r.hincrby(TALLY, "released", 1);
      await r.hincrby(TALLY, "released:" + assetClass, 1);
      if (!joinable) await r.hincrby(TALLY, "unjoinable:" + assetClass, 1);
    } catch (_) {}
    return id;
  } catch (_) { return null; }   // bookkeeping must never cost a subscriber their alert
}

/* Shared tail for both joins: stamp the row, save once, settle each. */
async function _applyGrades(r, list, settled) {
  if (!settled.length) return;
  await _save(r, list);
  for (const a of settled) await _settle(r, a);
}

/**
 * CRYPTO join — stamp engine verdicts from a published snapshot's `alerts.recent`.
 *
 * @param {Array} recent rows of {ts_utc, asset_code, kind, outcome, correct, result, resolved_utc}
 *
 * Idempotent: the same snapshot arriving twice stamps nothing the second time, because a row only
 * transitions out of `open` once. That matters — the snapshot is pushed on a cadence and `recent`
 * is a WINDOW, so one resolved ticket legitimately appears in many consecutive snapshots.
 */
async function joinCryptoResolutions(recent) {
  const out = { matched: 0, already: 0, seen: 0 };
  try {
    const r = kv();
    if (!r || !Array.isArray(recent) || !recent.length) return out;
    const list = await _load(r);
    const byId = new Map();
    for (const a of list) if (a.status === "open" && a.asset_class === "crypto") byId.set(a.id, a);
    if (!byId.size) return out;

    const settled = [];
    for (const row of recent) {
      try {
        if (!row || !row.kind) continue;
        out.seen++;
        const id = alertId("crypto", String(row.asset_code || ""), row.kind, row.ts_utc);
        const a = byId.get(id);
        if (!a) continue;                        // a ticket the engine graded that we never released
        if (a.status !== "open") { out.already++; continue; }

        /* The engine's own word, carried through unchanged and kept beside the normalised one.
           Not recomputed here — recomputing is how two records start disagreeing. */
        a.result_raw = row.result || null;
        a.outcome = normalize("crypto", row.result);
        a.outcome_pct = (row.outcome == null || !isFinite(Number(row.outcome))) ? null : Number(row.outcome);
        a.graded_ts = Date.parse(row.resolved_utc || "") || Date.now();
        a.status = a.outcome === "unresolved" || a.outcome == null ? "unresolved" : "graded";
        settled.push(a);
        out.matched++;
      } catch (_) { /* one bad row must not stop the pass */ }
    }
    await _applyGrades(r, list, settled);
    return out;
  } catch (_) { return out; }
}

/**
 * EQUITY join — stamp verdicts from an equity feed's `recent_resolved`.
 *
 * @param {Array} recent rows of {ticker, rule, direction, fired, horizon_min, outcome, move_bp, ...}
 *
 * ⚠ PINNED TO THE ADVERTISED HORIZON. One fire resolves at 15, 30 and 60 minutes; the alert
 * advertised hmax. Only the resolution whose horizon_min matches what the seat was shown is
 * allowed to grade it — otherwise a single alert is graded three times, its weight in the
 * denominator triples, and the 15-minute verdict silently decides a 60-minute call.
 */
async function joinEquityResolutions(recent) {
  const out = { matched: 0, already: 0, seen: 0, horizon_skipped: 0 };
  try {
    const r = kv();
    if (!r || !Array.isArray(recent) || !recent.length) return out;
    const list = await _load(r);
    const byId = new Map();
    for (const a of list) if (a.status === "open" && a.asset_class === "equity") byId.set(a.id, a);
    if (!byId.size) return out;

    /* ⚠ THE EQUITY FIRE ARRIVES WITHOUT THE ENGINE'S OWN TIMESTAMP.
       eye_monitor's eye_fire payload is symbol/rule/direction/spot_at/horizon_min/reading/record —
       it writes ts_utc into its OWN row and does not send it. So an exact key match is only
       possible if a future engine build starts sending it (handled first, below).

       Until then the match is (ticker, rule) plus TIME PROXIMITY: the engine stamps ts_utc and
       POSTs in the same pass, so the store's receipt time trails it by seconds. Closest-wins
       inside a tolerance, never first-wins — if the same rule fires twice on one ticker, first-wins
       would attach the verdict to whichever row happened to be earlier in the list. */
    const FUZZ_MS = 10 * 60000;
    const openRows = [...byId.values()];
    function findFuzzy(row) {
      const tk = String(row.ticker || "").toUpperCase();
      const fired = Date.parse(row.fired || "") || 0;
      if (!fired) return null;
      let best = null, bestGap = Infinity;
      for (const a of openRows) {
        if (a.status !== "open") continue;
        if (String(a.symbol || "").toUpperCase() !== tk) continue;
        if (String(a.kind || "") !== String(row.rule || "")) continue;
        const gap = Math.abs(a.ts - fired);
        if (gap < bestGap) { bestGap = gap; best = a; }
      }
      return bestGap <= FUZZ_MS ? best : null;
    }

    const settled = [];
    for (const row of recent) {
      try {
        if (!row || !row.rule || !row.fired) continue;
        out.seen++;
        const id = alertId("equity", String(row.ticker || "").toUpperCase(), row.rule, row.fired);
        const a = byId.get(id) || findFuzzy(row);
        if (!a) continue;
        if (a.status !== "open") { out.already++; continue; }
        if (a.horizon_min != null && Number(row.horizon_min) !== Number(a.horizon_min)) {
          out.horizon_skipped++; continue;       // a different horizon's verdict on the same fire
        }

        a.result_raw = row.outcome || null;
        a.outcome = normalize("equity", row.outcome);
        a.move_bp = (row.move_bp == null || !isFinite(Number(row.move_bp))) ? null : Number(row.move_bp);
        a.outcome_pct = (row.move_pct == null || !isFinite(Number(row.move_pct))) ? null : Number(row.move_pct);
        a.graded_ts = Date.now();
        a.status = a.outcome === "unresolved" || a.outcome == null ? "unresolved" : "graded";
        settled.push(a);
        out.matched++;
      } catch (_) { /* one bad row must not stop the pass */ }
    }
    await _applyGrades(r, list, settled);
    return out;
  } catch (_) { return out; }
}

/**
 * Close out alerts whose deadline (plus grace) passed without a verdict ever arriving.
 *
 * ⚠ THIS IS THE HONESTY PASS AND IT IS NOT OPTIONAL. Without it, an alert whose resolution fell
 * outside the engine's published window would sit `open` forever: invisible, uncounted, and
 * excluded from a hit rate it might well have hurt. Writing it off explicitly keeps `released`
 * reconciled and puts the cost of a plumbing gap somewhere it can be seen.
 */
async function reconcile() {
  const out = { unresolved: 0, open: 0 };
  try {
    const r = kv();
    if (!r) return out;
    const list = await _load(r);
    const now = Date.now();
    const dead = [];
    for (const a of list) {
      if (a.status !== "open") continue;
      const dl = a.deadline ? Date.parse(a.deadline)
        : (a.horizon_min ? a.ts + a.horizon_min * 60000 : null);
      if (dl && now > dl + GRACE_MIN * 60000) {
        a.status = "unresolved"; a.graded_ts = now; dead.push(a);
      } else out.open++;
    }
    await _applyGrades(r, list, dead);
    out.unresolved = dead.length;
    return out;
  } catch (_) { return out; }
}

/**
 * The scoreboard, for the Owner Dashboard. O(1) off the tally, so it cannot drift out of the
 * working set's window the way a rate recomputed from the last 400 rows would.
 */
async function scoreboard() {
  try {
    const r = kv();
    if (!r) return null;
    let t = {};
    try { t = (await r.hgetall(TALLY)) || {}; } catch (_) { t = {}; }
    const n = (k) => Number(t[k] || 0);

    const released = n("released");
    const settled = n("settled");
    const unresolved = n("unresolved");
    const decisive = n("decisive");
    const win = n("win");
    const loss = n("loss");
    const flat = n("flat");

    const list = await _load(r);
    const open = list.filter((a) => a.status === "open").length;

    /* THE RECONCILIATION IS PUBLISHED, NOT ASSERTED. If these do not add up, alerts are being lost
       and the rate above is not trustworthy — so the gap is printed rather than absorbed. */
    const gap = released - (settled + open);

    const per = {};
    for (const k of Object.keys(t)) {
      const m = /^k:(.+):(win|loss|flat|decisive)$/.exec(k);
      if (!m) continue;
      (per[m[1]] = per[m[1]] || { win: 0, loss: 0, flat: 0, decisive: 0 })[m[2]] = Number(t[k]);
    }
    const by_rule = Object.entries(per).map(([kind, v]) => ({
      kind, ...v,
      hit_rate_pct: v.decisive ? +(100 * v.win / v.decisive).toFixed(1) : null,
    })).sort((a, b) => b.decisive - a.decisive);

    const cls = (c) => ({
      released: n("released:" + c), decisive: n("decisive:" + c),
      win: n("win:" + c), loss: n("loss:" + c), flat: n("flat:" + c),
      unresolved: n("unresolved:" + c), unjoinable: n("unjoinable:" + c),
      hit_rate_pct: n("decisive:" + c) ? +(100 * n("win:" + c) / n("decisive:" + c)).toFixed(1) : null,
    });

    return {
      released, settled, open, unresolved,
      /* DECISIVE IS THE DENOMINATOR. flat decided nothing; unresolved never reported. Both are
         printed, neither is inside the rate. */
      decisive, win, loss, flat,
      hit_rate_pct: decisive ? +(100 * win / decisive).toFixed(1) : null,
      hit_rate_basis: "wins vs losses only — flat (" + flat + ") and unresolved (" + unresolved
        + ") are excluded from the rate and shown beside it",
      unresolved_rate_pct: settled ? +(100 * unresolved / settled).toFixed(1) : null,
      /* ⚠ THE MERGED RATE SPANS TWO DIFFERENT QUESTIONS (a crypto barrier race and an equity
         ±5bp directional call). It is published because Jake asked for one score; the per-class
         split is published beside it because that is the number that actually means something. */
      by_class: { crypto: cls("crypto"), equity: cls("equity") },
      by_rule,
      reconciled: gap === 0,
      reconcile_gap: gap,
    };
  } catch (_) { return null; }
}

/**
 * How a rule's RELEASED alerts have actually done. The feedback the release gate never had.
 *
 * ⚠ THIS IS THE RULE'S OWN RECORD, NOT THE ENGINE'S. The engine's edge number says how the rule's
 * POPULATION behaves; this says how the tickets we actually put in front of the seat behaved.
 * Those can disagree, and on 2026-09-11 they did: chain_pump_buyers cleared its out-of-sample floor
 * and released 43 alerts a day, and those alerts came back 21-26.
 *
 * Returns { decisive, win, hitRate } — hitRate null until anything has decided.
 */
async function ruleStanding(kind) {
  try {
    const r = kv();
    if (!r || !kind) return { decisive: 0, win: 0, hitRate: null };
    const k = String(kind).slice(0, 60).replace(/:/g, "_");
    let t = {};
    try { t = (await r.hgetall(TALLY)) || {}; } catch (_) { t = {}; }
    const dec = Number(t["k:" + k + ":decisive"] || 0);
    const win = Number(t["k:" + k + ":win"] || 0);
    return { decisive: dec, win, hitRate: dec ? +(100 * win / dec).toFixed(1) : null };
  } catch (_) { return { decisive: 0, win: 0, hitRate: null }; }
}

module.exports = {
  recordRelease, ruleStanding, joinCryptoResolutions, joinEquityResolutions, reconcile, scoreboard,
  alertId, normalize, KEY, TALLY,
};
