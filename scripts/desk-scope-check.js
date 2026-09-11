#!/usr/bin/env node
/* scripts/desk-scope-check.js — each desk shows its OWN desk's things.
 *
 * Two defects, both measured live by Temi on 2026-09-11 against build 568711e3fefc7f09, both on
 * the $79 crypto map:
 *   1. The Digest tab rendered a full SPY dealer-map read from Sep 10. The per-app stamp I shipped
 *      that morning was forward-only and the read-side filter passed unstamped rows, so the fix
 *      worked for Sep 11 and not for Sep 10 — on the same panel, in the same session.
 *   2. The Predictions tab showed five equity tickers and no crypto, because NOVO's book is
 *      filtered by asset class and the MEMBER's was not. One panel, two books, one filter.
 *
 * ⚠ THE BACKFILL GAP IS THE POINT OF TEST 1. A filter added today meets rows written yesterday.
 * "New rows are correct" is not the same claim as "the panel is correct", and only the second one
 * is what the subscriber sees. Every assertion here is paired with the pre-fix behaviour it must
 * NOT reproduce.
 */

const path = require("path");

function makeKv() {
  const store = new Map();
  return {
    _store: store,
    async get(k) { const v = store.get(k); return v === undefined ? null : JSON.parse(v); },
    async set(k, v) { store.set(k, v); return "OK"; },
    async hincrby() { return 1; }, async hgetall() { return null; },
    async rpush() { return 1; }, async ltrim() { return "OK"; },
  };
}
let KV = makeKv();
const kvPath = require.resolve(path.join(__dirname, "..", "api", "_kv.js"));
require.cache[kvPath] = { id: kvPath, filename: kvPath, loaded: true, exports: { kv: () => KV } };
const funnelPath = require.resolve(path.join(__dirname, "..", "api", "_lib", "funnel.js"));
require.cache[funnelPath] = { id: funnelPath, filename: funnelPath, loaded: true,
  exports: { bump: async () => {} } };

const P = require("../api/_lib/predictions.js");

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; fails.push(name); console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

/* ── 1. THE DIGEST LOG FILTER ───────────────────────────────────────────────────────────────
   Mirrored from api/alerts.js. It is one predicate inside a handler, so it is copied rather than
   imported; the shapes below are the real ones daily-digest.js writes. */
const shipped = (app, digest, e) => !app || !digest.app || (!!e && e.app === digest.app);
const preFix  = (app, digest, e) => !app || !digest.app || !e || !e.app || e.app === digest.app;

console.log("\n-- 1. the digest log: a crypto desk shows crypto mornings ------------------");
{
  const order = { app: "crypto", symbols: ["BTC"] };
  const log = [
    { ts: 1, text: "SPY sits in short gamma at 758.21, below the 761.26 gamma flip." },  // Sep 10, UNSTAMPED
    { ts: 2, text: "Where your map sits: CHIP 0.046786.", app: "crypto" },               // Sep 11, stamped
    { ts: 3, text: "SPY dealer map, equity desk.", app: "analyst" },                     // stamped, other desk
  ];
  const shown = log.filter((e) => shipped("crypto", order, e));

  ok("the stamped crypto morning shows", shown.some((e) => e.app === "crypto"));
  ok("the other desk's stamped morning does NOT", !shown.some((e) => e.app === "analyst"));
  ok("THE UNSTAMPED SPY READ DOES NOT — the bug Temi measured",
     !shown.some((e) => /SPY sits in short gamma/.test(e.text)),
     JSON.stringify(shown.map((e) => e.app || "unstamped")));
  ok("exactly one entry survives", shown.length === 1, "got " + shown.length);

  // an order with no app is legacy and still sees everything
  const legacy = log.filter((e) => shipped("crypto", { symbols: ["BTC"] }, e));
  ok("an order with no app still shows all of it", legacy.length === 3, "got " + legacy.length);
}

console.log("\n-- 2. the member's own book is scoped to the desk --------------------------");
{
  const email = "seat@example.com";
  const mk = (symbol, asset_class) => ({
    id: symbol + asset_class, kind: "close_at", symbol, asset_class, status: "graded",
    horizon_utc: 1, outcome: { hit: false }, made_utc: 1,
  });
  const book = [mk("SPY", "equity"), mk("QQQ", "equity"), mk("BTC", "crypto")];
  const crypto = require("crypto");
  const h = crypto.createHash("sha256").update(email).digest("hex").slice(0, 24);
  KV._store.set("pred:user:" + h, JSON.stringify(book));

  return (async () => {
    const onCrypto = await P.listUserPredictions(email, 40, "crypto");
    const onEquity = await P.listUserPredictions(email, 40, "equity");
    const unscoped = await P.listUserPredictions(email, 40);

    const syms = (r) => (r.graded || []).map((p) => p.symbol).sort().join(",");
    ok("the crypto desk shows only the crypto call", syms(onCrypto) === "BTC", syms(onCrypto));
    ok("NO EQUITY TICKERS ON THE CRYPTO DESK — the bug Temi measured",
       !/SPY|QQQ/.test(syms(onCrypto)), syms(onCrypto));
    ok("the equity desk shows only the equity calls", syms(onEquity) === "QQQ,SPY", syms(onEquity));
    ok("unscoped still returns the whole book (no caller is broken)",
       syms(unscoped) === "BTC,QQQ,SPY", syms(unscoped));
    ok("the rate is computed over the DESK's calls, not the whole book",
       onCrypto.overall.n === 1 && onEquity.overall.n === 2,
       JSON.stringify({ crypto: onCrypto.overall.n, equity: onEquity.overall.n }));

    console.log("\n-- NEGATIVE CONTROLS ------------------------------------------------------");
    let controls = 0, caught = 0;

    controls++;
    const preShown = [
      { ts: 1, text: "SPY sits in short gamma at 758.21." },
      { ts: 2, text: "CHIP 0.046786.", app: "crypto" },
    ].filter((e) => preFix("crypto", { app: "crypto" }, e));
    if (preShown.some((e) => /SPY/.test(e.text))) {
      caught++;
      console.log("  control caught — the SHIPPED-THIS-MORNING filter let the SPY read through ("
        + preShown.length + " of 2 entries). That is the defect, and test 1 detects it.");
    } else console.log("  control PASSED (BAD) — pre-fix filter also hid it, so test 1 proves nothing");

    controls++;
    if (/SPY|QQQ/.test(syms(unscoped))) {
      caught++;
      console.log("  control caught — unfiltered returns " + syms(unscoped)
        + ", so the crypto assertion is measuring the filter and not an empty book.");
    } else console.log("  control PASSED (BAD) — the book has no equity calls, test 2 proves nothing");

    console.log("\n---------------------------------------------------------------------------");
    console.log("assertions : " + pass + " passed, " + fail + " failed");
    console.log("controls   : " + caught + "/" + controls + " correctly went red");
    if (fails.length) console.log("failed     : " + fails.join(", "));
    const bad = fail > 0 || caught !== controls;
    console.log(bad ? "\nRESULT: FAIL\n" : "\nRESULT: PASS\n");
    process.exit(bad ? 1 : 0);
  })();
}
