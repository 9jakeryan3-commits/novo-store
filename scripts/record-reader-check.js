#!/usr/bin/env node
// scripts/record-reader-check.js — proves the record reader can still call a failure a failure.
//
// WHY THIS EXISTS. F-6 (2026-09-02): the reader was publishing SPY's flip_regime as a FAILING
// claim off z = -2.43 while the engine itself graded that same cell 'inconclusive' with an effect
// size of -0.03. NoVo was telling paying members that one of his own published claims had stopped
// working, on the strength of a statistic the scorer had explicitly declined to call anything.
// Meanwhile the archive cell — the SAME claim measured on 4,540 sessions instead of 28, reading
// z = +23.9, strength 'strong' — was structurally unreachable, because it carries no `holds` key
// and the walk never descended into it.
//
// Fixing that meant tightening what counts as a failure, and tightening a failure test is exactly
// how you end up with a test that can never fire. An empty "failing" list is the CORRECT output
// today, and it is indistinguishable from a reader that has been broken into permanent silence.
// So the guard is exercised in both directions here: real failures must still surface, artifacts
// must not, and the day a genuine claim inverts this file is what says the reader would notice.
//
//   node scripts/record-reader-check.js            # the guard, offline
//   node scripts/record-reader-check.js <base-url> # also read the LIVE record through it
//
// Exits non-zero on any failure.

const R = require("../api/_lib/record-reader.js");

let failures = 0;
const t = (label, cell, want) => {
  const got = R.verdictOf(cell);
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(56)} -> ${String(got).padEnd(8)}${ok ? "" : ` (want ${want})`}`);
};

console.log("a genuine failure must still be reported");
t("real failure: holds=false, z=-4.0, effect_r=-0.40, strong",
  { holds: false, z: -4.0, effect_r: -0.40, strength: "strong", sample: 3000 }, "failing");
t("real failure, no strength field at all",
  { holds: false, z: -4.0, effect_r: -0.40, sample: 3000 }, "failing");
t("real failure, no effect_r field at all",
  { holds: false, z: -4.0, sample: 3000 }, "failing");
t("real failure via rate vs baseline (40% vs 68%)",
  { rate: 40, baseline: 68, sample: 500 }, "failing");
t("archive-style failure: no holds key, z NEGATIVE, big effect",
  { z: -8.0, effect_r: -0.40, strength: "strong", sample: 2000 }, "failing");

console.log("\nand the things that must not be called failures");
t("engine graded inconclusive (the SPY flip case)",
  { holds: false, z: -2.43, effect_r: -0.03, strength: "inconclusive", sample: 4011 }, null);
t("effect_r below threshold even without a strength label",
  { holds: false, z: -3.0, effect_r: 0.02, sample: 5000 }, null);
t("effect_r exactly at the threshold still counts",
  { holds: false, z: -3.0, effect_r: -R.MIN_EFFECT_R, sample: 5000 }, "failing");
t("a holding claim is unaffected",
  { holds: true, z: 13.1, effect_r: 0.30, strength: "strong", sample: 2000 }, "holding");
t("archive-style holding (no holds key, z positive)",
  { z: 23.9, effect_r: 0.411, strength: "strong", sample: 2107 }, "holding");
t("sample too small to grade",
  { holds: true, z: 5.0, effect_r: 0.5, strength: "strong", sample: 3 }, null);

// The container walk: archive cells must be REACHED, and must be labelled so the next-session
// range test cannot be read as the intraday one.
console.log("\nthe walk reaches archive cells and labels them distinctly");
const rec = R.readRecord({
  tickers: {
    SPY: {
      flip_regime: { holds: false, z: -2.43, effect_r: -0.03, strength: "inconclusive", sample: 4011 },
      archive: {
        n: 4540, horizon: "the next session's range",
        flip_regime: { z: 23.9, effect_r: 0.411, strength: "strong", sample: 2107 },
      },
    },
  },
});
const reached = rec.holding.some((s) => /archive/.test(s) && /next session/.test(s));
const quiet = rec.failing.length === 0;
console.log(`  ${reached ? "ok  " : "FAIL"} archive cell reached and horizon-labelled`);
console.log(`  ${quiet ? "ok  " : "FAIL"} the inconclusive cell is not reported as failing`);
if (!reached || !quiet) failures++;

if (process.argv[2]) {
  const base = process.argv[2].replace(/\/$/, "");
  console.log(`\nlive record at ${base}`);
  (async () => {
    try {
      const r = await (await fetch(`${base}/api/track-record`)).json();
      const live = R.readRecord(r);
      console.log(`  holding ${live.holding.length}, failing ${live.failing.length}`);
      live.failing.forEach((f) => console.log("   failing:", f));
      R.byClaim(live.holding, 5).forEach((h) => console.log("   holding:", h));
      console.log("  note: an empty failing list is a valid state — it means no published claim");
      console.log("  is currently inverted with an effect size worth naming, not that none can be.");
    } catch (e) { failures++; console.log("  FAIL could not read the live record:", e.message); }
    done();
  })();
} else done();

function done() {
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}
