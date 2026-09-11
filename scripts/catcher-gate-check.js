#!/usr/bin/env node
/* scripts/catcher-gate-check.js — the catcher only catches what can be graded.
 *
 * Jake, 2026-09-11: "he doesnt necessarily deny any prediction, the catcher should just not catch
 * a prediction unless its data backed."
 *
 * ⚠ THE POINT OF THIS SUITE IS THE ZOMBIE, NOT THE ERROR STRING. An unresolvable prediction is not
 * a harmless no-op: the evaluator skips it forever (`if (!isFinite(spot)) continue`), nothing ever
 * voids it, and MAX_OPEN=40 means forty of them permanently block every real prediction. The last
 * test proves exactly that, by filling the book with zombies and showing a good call bounce.
 *
 * Negative controls included: each gate is re-run with the condition inverted, so a gate that
 * accidentally rejected EVERYTHING would fail here rather than look like a pass.
 */

const path = require("path");

function makeKv() {
  const store = new Map(), hashes = new Map(), lists = new Map();
  return {
    _store: store,
    async get(k) { const v = store.get(k); return v === undefined ? null : JSON.parse(v); },
    async set(k, v) { store.set(k, v); return "OK"; },
    async hincrby(k, f, by) { const h = hashes.get(k) || {}; h[f] = Number(h[f] || 0) + by; hashes.set(k, h); return h[f]; },
    async hgetall(k) { return hashes.get(k) || null; },
    async rpush(k, v) { const l = lists.get(k) || []; l.push(v); lists.set(k, l); return l.length; },
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

/* The coin map the live store holds; the evaluator can only price what is in it. */
function seedCoinMap(coins) {
  KV._store.set("crypto:map:live", JSON.stringify({ coins }));
}

const GOOD_EQ = { kind: "close_at", asset_class: "equity", symbol: "SPY", value: 760,
                  spot_at: 758.15, horizon_min: 120, source: "conversation" };

async function main() {
  console.log("\n── 1. resolvable calls are still caught (the gate must not block real work) ──");
  KV = makeKv(); seedCoinMap({ BTC: { gamma: 1 }, ETH: {} });
  {
    const a = await P.makePrediction(GOOD_EQ);
    ok("SPY close_at recorded", !a.error, JSON.stringify(a.error));

    const b = await P.makePrediction({ kind: "direction", asset_class: "equity", symbol: "QQQ",
      side: "up", spot_at: 709, horizon_min: 60, source: "conversation" });
    ok("QQQ direction recorded", !b.error, JSON.stringify(b.error));

    const c = await P.makePrediction({ kind: "direction", asset_class: "crypto", symbol: "BTC",
      side: "up", spot_at: 77000, horizon_min: 240, source: "conversation" });
    ok("BTC (on the coin map) recorded", !c.error, JSON.stringify(c.error));
  }

  console.log("\n── 2. unresolvable calls are NOT caught ─────────────────────────────────────");
  KV = makeKv(); seedCoinMap({ BTC: {}, ETH: {} });
  {
    const nvda = await P.makePrediction({ ...GOOD_EQ, symbol: "NVDA" });
    ok("NVDA refused (not in the priceable equity set)", !!nvda.error, JSON.stringify(nvda));

    const vix = await P.makePrediction({ ...GOOD_EQ, symbol: "VIX" });
    ok("VIX refused", !!vix.error);

    const fomc = await P.makePrediction({ kind: "direction", asset_class: "equity",
      symbol: "FOMC", side: "up", spot_at: 1, horizon_min: 10000, source: "conversation" });
    ok("FOMC pseudo-symbol refused", !!fomc.error);

    const memecoin = await P.makePrediction({ kind: "direction", asset_class: "crypto",
      symbol: "CASHCAT", side: "up", spot_at: 0.17, horizon_min: 60, source: "conversation" });
    ok("a chain token not on the coin map refused", !!memecoin.error, JSON.stringify(memecoin));

    ok("the refusal says it is about RECORDING, not permission",
       /not recorded/i.test(String(nvda.error)), nvda.error);
  }

  console.log("\n── 3. a missing coin map must NOT block recording (unknown != unresolvable) ──");
  KV = makeKv();   // no crypto:map:live at all — KV cold, or a hiccup
  {
    const c = await P.makePrediction({ kind: "direction", asset_class: "crypto", symbol: "BTC",
      side: "up", spot_at: 77000, horizon_min: 240, source: "conversation" });
    ok("crypto call still recorded when the map cannot be read", !c.error, JSON.stringify(c.error));
  }

  console.log("\n── 4. THE ZOMBIE: what the gate actually prevents ───────────────────────────");
  /* Fill the book with ungradeable rows the way the UNGATED code would have, then show a perfectly
     good SPY call bounce off MAX_OPEN. This is the failure the gate exists to stop. */
  KV = makeKv(); seedCoinMap({ BTC: {} });
  {
    const book = [];
    for (let i = 0; i < 40; i++) {
      book.push({ id: "z" + i, kind: "close_at", asset_class: "equity", symbol: "NVDA",
        value: 100, spot_at: 100, horizon_utc: Date.now() + 3600000, status: "open",
        source: "conversation", made_utc: Date.now() });
    }
    KV._store.set("pred:log", JSON.stringify(book));

    const blocked = await P.makePrediction(GOOD_EQ);
    ok("40 zombies DO block a real prediction (this is the bug)", !!blocked.error,
       JSON.stringify(blocked));
    ok("...and the block is MAX_OPEN, not the symbol gate",
       /too many open/i.test(String(blocked.error)), blocked.error);

    /* Now the same 40 attempts THROUGH the gate: none of them get in, so the book stays clear. */
    KV = makeKv(); seedCoinMap({ BTC: {} });
    let admitted = 0;
    for (let i = 0; i < 40; i++) {
      const z = await P.makePrediction({ ...GOOD_EQ, symbol: "NVDA" });
      if (!z.error) admitted++;
    }
    ok("with the gate, zero zombies are admitted", admitted === 0, "admitted=" + admitted);
    const after = await P.makePrediction(GOOD_EQ);
    ok("...so a real SPY call still records", !after.error, JSON.stringify(after.error));
  }

  console.log("\n── NEGATIVE CONTROLS ────────────────────────────────────────────────────────");
  let controls = 0, caught = 0;
  // (a) the gate must not be rejecting everything
  KV = makeKv(); seedCoinMap({ BTC: {} });
  {
    controls++;
    const a = await P.makePrediction(GOOD_EQ);
    if (a.error) console.log("  control PASSED (BAD) — the gate rejects valid SPY calls too");
    else { caught++; console.log("  control caught — valid calls still pass the gate"); }
  }
  // (b) an empty coin map object is still a map, and must still reject
  KV = makeKv(); seedCoinMap({});
  {
    controls++;
    const c = await P.makePrediction({ kind: "direction", asset_class: "crypto", symbol: "BTC",
      side: "up", spot_at: 77000, horizon_min: 240, source: "conversation" });
    if (!c.error) console.log("  control PASSED (BAD) — empty map treated as 'unknown', not 'absent'");
    else { caught++; console.log("  control caught — empty coin map rejects unmapped coins"); }
  }

  console.log("\n──────────────────────────────────────────────────────────────────────────────");
  console.log("assertions : " + pass + " passed, " + fail + " failed");
  console.log("controls   : " + caught + "/" + controls + " correctly went red");
  if (fails.length) console.log("failed     : " + fails.join(", "));
  const bad = fail > 0 || caught !== controls;
  console.log(bad ? "\nRESULT: FAIL\n" : "\nRESULT: PASS\n");
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error("harness error:", e); process.exit(2); });
