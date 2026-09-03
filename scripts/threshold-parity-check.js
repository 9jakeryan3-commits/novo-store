#!/usr/bin/env node
// Two repos hold ONE significance threshold: the store's record-reader refuses to grade a claim
// whose |effect_r| sits under MIN_EFFECT_R, and the engine's claim_strength grades with the same
// bar as _BIG_GROUP_R. They are hand-mirrored constants with nothing crossing the boundary — in
// step today only because nobody has touched either since creation (Register: mirrored constants,
// filed by Einstein 2026-09-02). If the engine's moves and the store's does not, the store silently
// grades claims the engine refused. This check makes that drift a failed deploy instead.
//
// Runs in deploy.sh under `set -e`. It FAILS on: missing file, moved/renamed constant (a pattern
// that can't find its needle must not certify a zero), or unequal values. The env overrides exist
// for sabotage-testing the check itself — see scripts/deploy.sh's caller comment.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const JS_FILE = process.env.PARITY_JS || path.join(ROOT, "api", "_lib", "record-reader.js");
const PY_FILE = process.env.PARITY_PY || path.resolve(ROOT, "..", "NoVo-Pulse", "skills", "claim_strength.py");

function grab(file, re, label) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    console.error("!! threshold parity: cannot read " + label + " at " + file + " (" + e.message + ")");
    console.error("   If the file moved, update scripts/threshold-parity-check.js in the same commit.");
    process.exit(1);
  }
  const m = text.match(re);
  if (!m) {
    console.error("!! threshold parity: " + label + " not found in " + file);
    console.error("   The constant was renamed or reformatted; a check that cannot find its needle");
    console.error("   cannot certify parity. Update this check in the same commit that moved it.");
    process.exit(1);
  }
  return { value: parseFloat(m[1]), raw: m[1] };
}

const js = grab(JS_FILE, /const MIN_EFFECT_R = ([0-9]*\.?[0-9]+);/, "MIN_EFFECT_R (store)");
const py = grab(PY_FILE, /_BIG_GROUP_R = ([0-9]*\.?[0-9]+)/, "_BIG_GROUP_R (engine)");

if (js.value !== py.value) {
  console.error("!! threshold parity: DRIFT — store MIN_EFFECT_R=" + js.raw + " vs engine _BIG_GROUP_R=" + py.raw);
  console.error("   These are one threshold in two repos. Move BOTH in one change, then redeploy.");
  process.exit(1);
}
console.log(".. threshold parity: MIN_EFFECT_R == _BIG_GROUP_R == " + js.raw);
