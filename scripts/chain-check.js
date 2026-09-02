#!/usr/bin/env node
// scripts/chain-check.js — proves the track-record chain actually detects tampering.
//
// WHY THIS FILE EXISTS RATHER THAN A NOTE SAYING "TESTED". The first version of record-chain.js
// passed every test I wrote for it and was still blind: it stored `contentHash` and verified only
// that sha256(prev + contentHash) matched `hash`, so the chain bound the digest but never bound
// the CLAIMS to it. I edited a stored z from -3.8 to +3.8, re-ran the verifier, and it reported
// the chain fully intact. The tamper test is the entire value of the feature — without it the
// chain is decoration that returns `intact: true` — so it lives in the repo and runs on demand
// rather than existing once in a terminal I closed.
//
//   node scripts/chain-check.js            # offline, against the module (no KV needed)
//   node scripts/chain-check.js <base-url> # also verifies the LIVE chain over HTTP
//
// Exits non-zero on any failure.

const C = require("../api/_lib/record-chain.js");

let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  (got ${got}, want ${want})`}`);
};

// A stand-in for Upstash with the same lpush/lrange/ltrim semantics.
const fakeKv = () => {
  const L = [];
  return {
    _L: L,
    async lpush(_k, v) { L.unshift(v); },
    async lrange(_k, a, b) { return L.slice(a, b + 1); },
    async ltrim(_k, a, b) { L.splice(0, L.length, ...L.slice(a, b + 1)); },
  };
};

const rec = (z, n) => ({
  ok: true, generated: "gen", prose: "payload text that never changes",
  tickers: {
    SPY: { flip_regime: { z, sample: n, holds: z > 0 } },
    IWM: { flip_regime: { z: 10.3, sample: 4021, holds: true } },
  },
});

(async () => {
  const r = fakeKv();

  console.log("append + dedupe");
  check("first publish appends", (await C.appendLink(r, rec(-3.8, 3887), 1000)).appended, true);
  check("identical republish does NOT append", (await C.appendLink(r, rec(-3.8, 3887), 2000)).appended, false);
  check("changed z appends", (await C.appendLink(r, rec(-3.9, 3901), 3000)).appended, true);
  check("changed z appends again", (await C.appendLink(r, rec(2.1, 4100), 4000)).appended, true);
  check("three links stored", r._L.length, 3);

  const V = async () => C.verifyChain(await C.readChain(r, 200));
  console.log("\nverification");
  check("an untouched chain verifies", (await V()).intact, true);

  const pristine = JSON.stringify(r._L);
  const restore = () => r._L.splice(0, r._L.length, ...JSON.parse(pristine));

  console.log("\ntamper detection — each of these MUST come back false");
  // A: edit a scored value only. This is the one the first implementation missed.
  let t = JSON.parse(r._L[2]); t.claims["SPY.flip_regime"].z = 3.8; r._L[2] = JSON.stringify(t);
  check("edited a scored value", (await V()).intact, false);

  // B: edit the value AND relink it so the link is internally consistent.
  t = JSON.parse(r._L[2]);
  t.contentHash = C.contentHashOf(t.claims, t.payloadHash);
  t.hash = C.sha256(String(t.prev) + String(t.contentHash));
  r._L[2] = JSON.stringify(t);
  check("edited a value and rebuilt that link", (await V()).intact, false);

  restore();
  r._L.splice(1, 1);
  check("silently deleted a record", (await V()).intact, false);

  restore();
  t = JSON.parse(r._L[1]); t.ts = 999999; r._L[1] = JSON.stringify(t);
  check("back-dated a record", (await V()).intact, true);   // ts is metadata, not hashed — see note

  restore();
  check("restored chain verifies again", (await V()).intact, true);

  console.log("\n  note: `ts` is deliberately NOT covered by the hash — it is stamped by the");
  console.log("  receiver, not the engine, and a link whose only difference is arrival time is");
  console.log("  the same record. `generated` (the engine's own stamp) rides inside the payload");
  console.log("  hash, so the SCORING time is covered even though the WRITE time is not.");

  // Live chain, if a base URL was given.
  const base = process.argv[2];
  if (base) {
    console.log(`\nlive chain at ${base}`);
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/api/track-record?verify=1`);
      const j = await res.json();
      console.log(`  links=${j.links} head=${j.head ? j.head.slice(0, 16) + "…" : "none"}`);
      // AN EMPTY CHAIN IS NOT A FAILING CHAIN. The endpoint deliberately answers intact:null with
      // zero links rather than a vacuous true, so asserting `intact === true` here turned that
      // honesty into a red — the same false signal as the vacuous green, pointing the other way.
      // Until the engine publishes, there is nothing to check and this must say so.
      if (j.links === 0) {
        console.log("  nothing to check yet — no publish has been recorded since this shipped.");
        console.log(`  the endpoint reports intact=${JSON.stringify(j.intact)}, which is correct:` +
                    " an empty check is not a passing one.");
      } else {
        check("live chain intact", j.intact, true);
        if (j.problems && j.problems.length) j.problems.forEach((p) => console.log("   -", p.problem));
      }
    } catch (e) {
      failures++;
      console.log("  FAIL could not read the live chain:", e.message);
    }
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
