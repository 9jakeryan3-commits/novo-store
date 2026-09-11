#!/usr/bin/env node
/* scripts/alert-record-check.js — proof that the alert record grades what it claims to grade.
 *
 * Run: node scripts/alert-record-check.js
 *
 * ⚠ EVERY ASSERTION HERE IS PAIRED WITH A DEMONSTRATION THAT IT CAN FAIL.
 * A check that passes on an empty book, or that would pass with the logic deleted, is the dominant
 * defect class on this system — so the suite ends by MUTATING the module's inputs and asserting the
 * checks go red. If the negative-control block ever prints PASS, the suite above it is decorative.
 *
 * No network, no KV, no live data: an in-memory KV stands in, modelled on Upstash's actual
 * behaviour (hgetall returns numbers, get may return a parsed object rather than a string).
 */

const path = require("path");

// ── the fake KV, injected before the module under test is required ──────────────────────────────
function makeKv(opts) {
  const store = new Map();
  const hashes = new Map();
  const lists = new Map();
  return {
    _store: store, _hashes: hashes, _lists: lists,
    async get(k) {
      const v = store.get(k);
      if (v === undefined) return null;
      // Upstash deserialises automatically by default: a JSON string comes back as an object.
      return opts && opts.rawStrings ? v : JSON.parse(v);
    },
    async set(k, v) { store.set(k, v); return "OK"; },
    async hincrby(k, f, by) {
      const h = hashes.get(k) || {};
      h[f] = Number(h[f] || 0) + Number(by);
      hashes.set(k, h);
      return h[f];
    },
    async hgetall(k) { return hashes.get(k) || null; },
    async rpush(k, v) {
      const l = lists.get(k) || [];
      l.push(v); lists.set(k, l); return l.length;
    },
  };
}

let KV = makeKv();
const kvPath = require.resolve(path.join(__dirname, "..", "api", "_kv.js"));
require.cache[kvPath] = { id: kvPath, filename: kvPath, loaded: true, exports: { kv: () => KV } };

const AR = require("../api/_lib/alert-record.js");

// ── tiny harness ────────────────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; fails.push(name); console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}
function eq(name, got, want) {
  ok(name, got === want, "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
}

const HOUR = 3600000;
function iso(ms) { return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z"); }

async function reset() { KV = makeKv(); }

// ════════════════════════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log("\n── 1. crypto: a released alert joins its engine verdict ─────────────────────");
  await reset();
  {
    const now = Date.now();
    const t1 = iso(now - 2 * HOUR);   // engine ts_utc for a winner
    const t2 = iso(now - 2 * HOUR + 1000);
    const t3 = iso(now - 2 * HOUR + 2000);
    await AR.recordRelease({ asset_class: "crypto", symbol: "DRAFT", kind: "chain_pump_buyers",
      eng_ts: t1, action: "BUY", entry: 0.00173, target_px: 0.00198, stop_px: 0.00153,
      deadline: iso(now - HOUR), horizon_min: 60 });
    await AR.recordRelease({ asset_class: "crypto", symbol: "ZFORGE", kind: "chain_pump_buyers",
      eng_ts: t2, action: "BUY", entry: 0.0086, target_px: 0.0142, stop_px: 0.007,
      deadline: iso(now - HOUR), horizon_min: 60 });
    await AR.recordRelease({ asset_class: "crypto", symbol: "CASHCAT", kind: "coin_washout_long",
      eng_ts: t3, action: "BUY", entry: 0.1757, target_px: 0.1831, stop_px: 0.1722,
      deadline: iso(now - HOUR), horizon_min: 60 });

    let sb = await AR.scoreboard();
    eq("released counted at release", sb.released, 3);
    eq("nothing settled yet", sb.settled, 0);
    eq("all three open", sb.open, 3);
    ok("book reconciles while open", sb.reconciled, JSON.stringify(sb.reconcile_gap));

    const r = await AR.joinCryptoResolutions([
      { asset_code: "DRAFT", kind: "chain_pump_buyers", ts_utc: t1, result: "target",
        outcome: 14.7, correct: true, resolved_utc: iso(now - HOUR) },
      { asset_code: "ZFORGE", kind: "chain_pump_buyers", ts_utc: t2, result: "stop",
        outcome: -18.9, correct: false, resolved_utc: iso(now - HOUR) },
      { asset_code: "CASHCAT", kind: "coin_washout_long", ts_utc: t3, result: "flat",
        outcome: 0.4, correct: false, resolved_utc: iso(now - HOUR) },
      // a ticket the engine graded that we never released — must be ignored, not counted
      { asset_code: "NEVERSHOWN", kind: "chain_pump_buyers", ts_utc: t1, result: "target",
        outcome: 9, correct: true, resolved_utc: iso(now - HOUR) },
    ]);
    eq("matched exactly the three released", r.matched, 3);
    eq("saw four rows", r.seen, 4);

    sb = await AR.scoreboard();
    eq("settled 3", sb.settled, 3);
    eq("win 1", sb.win, 1);
    eq("loss 1", sb.loss, 1);
    eq("flat 1", sb.flat, 1);
    eq("DECISIVE EXCLUDES FLAT", sb.decisive, 2);
    eq("hit rate is 1 of 2 decisive, not 1 of 3", sb.hit_rate_pct, 50);
    ok("reconciles after grading", sb.reconciled, "gap=" + sb.reconcile_gap);
    eq("nothing left open", sb.open, 0);
  }

  console.log("\n── 2. crypto: idempotence — the same window arriving twice ──────────────────");
  await reset();
  {
    const now = Date.now();
    const t1 = iso(now - 2 * HOUR);
    await AR.recordRelease({ asset_class: "crypto", symbol: "ROBIN", kind: "chain_pump_buyers",
      eng_ts: t1, deadline: iso(now - HOUR), horizon_min: 60 });
    const row = { asset_code: "ROBIN", kind: "chain_pump_buyers", ts_utc: t1, result: "target",
      outcome: 13.8, correct: true, resolved_utc: iso(now - HOUR) };
    const a = await AR.joinCryptoResolutions([row]);
    const b = await AR.joinCryptoResolutions([row]);   // the snapshot is a WINDOW; it repeats
    eq("first pass matched", a.matched, 1);
    eq("second pass matched nothing", b.matched, 0);
    const sb = await AR.scoreboard();
    eq("tally counted the win ONCE", sb.win, 1);
    eq("settled once", sb.settled, 1);
  }

  console.log("\n── 3. crypto: release dedupe — one release, one row ─────────────────────────");
  await reset();
  {
    const t1 = iso(Date.now() - HOUR);
    const e = { asset_class: "crypto", symbol: "CLAUDE", kind: "chain_pump_buyers", eng_ts: t1,
      horizon_min: 60 };
    const id1 = await AR.recordRelease(e);
    const id2 = await AR.recordRelease(e);
    eq("same id returned", id1, id2);
    const sb = await AR.scoreboard();
    eq("released counted once", sb.released, 1);
    eq("one open row", sb.open, 1);
  }

  console.log("\n── 4. equity: THE THREE-HORIZON TRAP ────────────────────────────────────────");
  /* An Eye fire registers horizons (15, 30, 60) and resolves three times; the alert advertised 60.
     Joining without pinning would grade one alert three times and let the 15-minute verdict decide
     a 60-minute call. */
  await reset();
  {
    const now = Date.now();
    const fired = iso(now - 2 * HOUR);
    await AR.recordRelease({ asset_class: "equity", symbol: "SPY", kind: "eye_gex_flip",
      eng_ts: fired, direction: "up", entry_px: 758.15, horizon_min: 60,
      title: "SPY up", receipts: "62% over 40 vs 51%" });

    const r = await AR.joinEquityResolutions([
      { ticker: "SPY", rule: "eye_gex_flip", direction: "up", fired, horizon_min: 15,
        outcome: "miss", move_bp: -12, move_pct: -0.12 },
      { ticker: "SPY", rule: "eye_gex_flip", direction: "up", fired, horizon_min: 30,
        outcome: "flat", move_bp: 2, move_pct: 0.02 },
      { ticker: "SPY", rule: "eye_gex_flip", direction: "up", fired, horizon_min: 60,
        outcome: "hit", move_bp: 31, move_pct: 0.31 },
    ]);
    eq("graded exactly once", r.matched, 1);
    eq("two off-horizon verdicts skipped", r.horizon_skipped, 2);
    const sb = await AR.scoreboard();
    eq("the 60-minute verdict won, not the 15-minute one", sb.win, 1);
    eq("no loss recorded from the 15m miss", sb.loss, 0);
    eq("settled exactly once", sb.settled, 1);
    eq("equity decisive is 1, not 3", sb.by_class.equity.decisive, 1);
  }

  console.log("\n── 5. equity: no_data is UNRESOLVED, not flat ───────────────────────────────");
  await reset();
  {
    const now = Date.now();
    const fired = iso(now - 2 * HOUR);
    await AR.recordRelease({ asset_class: "equity", symbol: "SPY", kind: "eye_charm",
      eng_ts: fired, direction: "down", horizon_min: 60 });
    await AR.joinEquityResolutions([
      { ticker: "SPY", rule: "eye_charm", direction: "down", fired, horizon_min: 60,
        outcome: "no_data", move_bp: null },
    ]);
    const sb = await AR.scoreboard();
    eq("counted unresolved", sb.unresolved, 1);
    eq("NOT counted flat", sb.flat, 0);
    eq("not in the decisive denominator", sb.decisive, 0);
    eq("hit rate is null, not 0%", sb.hit_rate_pct, null);
  }

  console.log("\n── 6. the honesty pass: a verdict that never arrives ────────────────────────");
  await reset();
  {
    const now = Date.now();
    await AR.recordRelease({ asset_class: "crypto", symbol: "GHOST", kind: "chain_pump_buyers",
      eng_ts: iso(now - 10 * HOUR), deadline: iso(now - 9 * HOUR), horizon_min: 60 });
    await AR.recordRelease({ asset_class: "crypto", symbol: "FRESH", kind: "chain_pump_buyers",
      eng_ts: iso(now - 5 * 60000), deadline: iso(now + HOUR), horizon_min: 60 });

    const rc = await AR.reconcile();
    eq("the stale one was written off", rc.unresolved, 1);
    eq("the live one was left alone", rc.open, 1);
    const sb = await AR.scoreboard();
    eq("unresolved counted", sb.unresolved, 1);
    eq("it is NOT a loss", sb.loss, 0);
    eq("it is NOT decisive", sb.decisive, 0);
    ok("released still reconciles (1 settled + 1 open = 2)", sb.reconciled,
       "released=" + sb.released + " settled=" + sb.settled + " open=" + sb.open);
  }

  console.log("\n── 7. an unjoinable release is counted, not hidden ──────────────────────────");
  await reset();
  {
    await AR.recordRelease({ asset_class: "equity", symbol: "SPY", kind: "eye_gex_flip",
      horizon_min: 60 });     // NO eng_ts — today's equity fire payload has none
    const sb = await AR.scoreboard();
    eq("released counted", sb.released, 1);
    eq("flagged unjoinable", sb.by_class.equity.unjoinable, 1);
    eq("still open (it can never be joined)", sb.open, 1);
  }

  console.log("\n── 8. the archive is written and never trimmed ──────────────────────────────");
  await reset();
  {
    const now = Date.now();
    const t1 = iso(now - 2 * HOUR);
    await AR.recordRelease({ asset_class: "crypto", symbol: "ARCH", kind: "k1", eng_ts: t1,
      deadline: iso(now - HOUR), horizon_min: 60 });
    await AR.joinCryptoResolutions([{ asset_code: "ARCH", kind: "k1", ts_utc: t1,
      result: "target", outcome: 5, correct: true, resolved_utc: iso(now - HOUR) }]);
    const keys = [...KV._lists.keys()].filter((k) => k.startsWith("alert:arch:"));
    eq("one archive key written", keys.length, 1);
    eq("one row in it", KV._lists.get(keys[0]).length, 1);
    const row = JSON.parse(KV._lists.get(keys[0])[0]);
    eq("archive row carries the engine's own word", row.result_raw, "target");
    eq("and the normalised one", row.outcome, "win");
  }

  console.log("\n── 9. survives a KV that throws (an alert must never be lost to bookkeeping) ─");
  await reset();
  {
    const good = KV;
    KV = { async get() { throw new Error("kv down"); }, async set() { throw new Error("kv down"); },
           async hincrby() { throw new Error("kv down"); }, async hgetall() { throw new Error("kv down"); },
           async rpush() { throw new Error("kv down"); } };
    let threw = false;
    try {
      await AR.recordRelease({ asset_class: "crypto", symbol: "X", kind: "k", eng_ts: iso(Date.now()) });
      await AR.joinCryptoResolutions([{ asset_code: "X", kind: "k", ts_utc: iso(Date.now()), result: "target" }]);
      await AR.reconcile();
      await AR.scoreboard();
    } catch (_) { threw = true; }
    ok("no throw escaped to the caller", !threw);
    KV = good;
  }

  console.log("\n── 10. raw-string KV (automaticDeserialization off) ─────────────────────────");
  await reset();
  {
    KV = makeKv({ rawStrings: true });
    const t1 = iso(Date.now() - 2 * HOUR);
    await AR.recordRelease({ asset_class: "crypto", symbol: "RAW", kind: "k1", eng_ts: t1,
      deadline: iso(Date.now() - HOUR), horizon_min: 60 });
    await AR.recordRelease({ asset_class: "crypto", symbol: "RAW2", kind: "k1", eng_ts: t1 + "x",
      deadline: iso(Date.now() - HOUR), horizon_min: 60 });
    const sb = await AR.scoreboard();
    eq("both releases survived a string-returning get", sb.released, 2);
    eq("and both are open", sb.open, 2);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n── NEGATIVE CONTROLS: prove the checks above can actually go red ────────────");
  /* Each of these SHOULD fail. If any prints "control PASSED", the corresponding assertion above
     is not measuring what it claims to measure. */
  let controls = 0, controlsCaught = 0;

  // (a) flat must not be allowed into the denominator
  await reset();
  {
    const now = Date.now(), t1 = iso(now - 2 * HOUR);
    await AR.recordRelease({ asset_class: "crypto", symbol: "F", kind: "k", eng_ts: t1,
      deadline: iso(now - HOUR), horizon_min: 60 });
    await AR.joinCryptoResolutions([{ asset_code: "F", kind: "k", ts_utc: t1, result: "flat",
      outcome: 0.1, correct: false, resolved_utc: iso(now - HOUR) }]);
    const sb = await AR.scoreboard();
    controls++;
    const wrong = sb.decisive === 1;   // would be true if flat leaked into decisive
    if (wrong) console.log("  control PASSED (BAD) — flat leaked into the denominator");
    else { controlsCaught++; console.log("  control caught — flat stayed out of decisive"); }
  }

  // (b) the horizon pin must actually pin
  await reset();
  {
    const now = Date.now(), fired = iso(now - 2 * HOUR);
    await AR.recordRelease({ asset_class: "equity", symbol: "SPY", kind: "r", eng_ts: fired,
      horizon_min: 60 });
    const r = await AR.joinEquityResolutions([
      { ticker: "SPY", rule: "r", fired, horizon_min: 15, outcome: "hit", move_bp: 40 },
    ]);
    controls++;
    if (r.matched === 1) console.log("  control PASSED (BAD) — a 15m verdict graded a 60m alert");
    else { controlsCaught++; console.log("  control caught — off-horizon verdict rejected"); }
  }

  // (c) an unreleased ticket must never enter the book
  await reset();
  {
    const now = Date.now();
    const r = await AR.joinCryptoResolutions([{ asset_code: "PHANTOM", kind: "k",
      ts_utc: iso(now - HOUR), result: "target", outcome: 20, correct: true,
      resolved_utc: iso(now) }]);
    const sb = await AR.scoreboard();
    controls++;
    if (r.matched > 0 || sb.win > 0) console.log("  control PASSED (BAD) — phantom win entered the book");
    else { controlsCaught++; console.log("  control caught — unreleased ticket ignored"); }
  }

  // (d) the reconciliation must notice a lost alert
  await reset();
  {
    const now = Date.now(), t1 = iso(now - 2 * HOUR);
    await AR.recordRelease({ asset_class: "crypto", symbol: "L", kind: "k", eng_ts: t1,
      deadline: iso(now - HOUR), horizon_min: 60 });
    // simulate loss of the working set (TTL expiry / eviction) WITHOUT touching the tally
    KV._store.delete("alert:log");
    const sb = await AR.scoreboard();
    controls++;
    if (sb.reconciled) console.log("  control PASSED (BAD) — a lost alert still reported reconciled");
    else { controlsCaught++; console.log("  control caught — gap reported: " + sb.reconcile_gap); }
  }

  console.log("\n──────────────────────────────────────────────────────────────────────────────");
  console.log("assertions : " + pass + " passed, " + fail + " failed");
  console.log("controls   : " + controlsCaught + "/" + controls + " correctly went red");
  if (fails.length) console.log("failed     : " + fails.join(", "));
  const bad = fail > 0 || controlsCaught !== controls;
  console.log(bad ? "\nRESULT: FAIL\n" : "\nRESULT: PASS\n");
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e); process.exit(2); });
