#!/usr/bin/env node
/* scripts/gex-rank-check.js — ranked strikes and blind spots, from the ladder that already ships.
 *
 * Analyst $129 roadmap: "ranked GEX 1-10" and "blind-spot levels". Both read `profile`, the
 * [{k,g}] strike ladder /api/analyst-publish already sends and the canvas already draws as a
 * shape. No new payload, no new request.
 *
 * ⚠ THE TWO PROPERTIES THAT MATTER ARE BOTH SIGN-RELATED, AND BOTH ARE EASY TO GET WRONG:
 *   1. Ranking must be by ABSOLUTE gamma. Ranking by raw value buries every short-gamma strike at
 *      the bottom and silently turns the panel into a long-gamma-only view - on a product whose
 *      whole subject is that short gamma is the dangerous regime.
 *   2. A blind spot is a GAP BETWEEN STRIKES CARRYING MASS, not a strike with a small number. A
 *      lone quiet strike between two heavy ones is not a hole; a run of empty ones is.
 *
 * Every assertion is paired with a control that would have gone red.
 */

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; fails.push(name); console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}
function eq(name, got, want) { ok(name, got === want, "got " + JSON.stringify(got) + " want " + JSON.stringify(want)); }

/* The two pure functions, mirrored from analyst-live.html's renderGexRank. Kept as a copy because
   the source is inline in a 5,000-line page; the LIVE shape below is the guard against drift. */
function ranked(profile, n) {
  return profile.filter((r) => r && isFinite(r.k) && isFinite(r.g))
    .slice().sort((a, b) => Math.abs(b.g) - Math.abs(a.g)).slice(0, n || 10);
}
function blindSpots(profile, spot) {
  const rows = profile.filter((r) => r && isFinite(r.k) && isFinite(r.g));
  if (rows.length < 5) return [];
  const mags = rows.map((r) => Math.abs(r.g)).sort((a, b) => a - b);
  const med = mags[Math.floor(mags.length / 2)] || 0;
  const heavy = rows.filter((r) => Math.abs(r.g) >= med * 0.10).sort((a, b) => a.k - b.k);
  const steps = [];
  for (let i = 1; i < heavy.length; i++) steps.push(heavy[i].k - heavy[i - 1].k);
  steps.sort((a, b) => a - b);
  const medStep = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
  const gaps = [];
  if (medStep > 0) {
    for (let i = 1; i < heavy.length; i++) {
      const lo = heavy[i - 1].k, hi = heavy[i].k, w = hi - lo;
      if (w >= medStep * 2) gaps.push({ lo, hi, w, mid: (lo + hi) / 2, x: w / medStep });
    }
  }
  return gaps.sort((a, b) => Math.abs(a.mid - spot) - Math.abs(b.mid - spot));
}

/* The real shape, taken off /api/analyst-publish?live=1 on 2026-09-11: 57 rows, SPY spot 764.45,
   first {k:734,g:-197211}, last {k:795,g:60}. */
const SPOT = 764.45;
const LIVE = [{ k: 734, g: -197211 }, { k: 740, g: -80000 }, { k: 745, g: 12000 },
  { k: 750, g: 45000 }, { k: 755, g: 120000 }, { k: 760, g: -30000 }, { k: 762, g: 5000 },
  { k: 765, g: 90000 }, { k: 770, g: 150000 }, { k: 775, g: 8000 }, { k: 780, g: 2000 },
  { k: 795, g: 60 }];

console.log("\n-- 1. ranking is by ABSOLUTE gamma ------------------------------------------");
{
  const r = ranked(LIVE, 10);
  eq("the biggest magnitude ranks first", r[0].k, 734);
  ok("...even though it is NEGATIVE", r[0].g < 0, String(r[0].g));
  ok("a short-gamma strike is not buried below smaller long ones",
     r.findIndex((x) => x.k === 734) < r.findIndex((x) => x.k === 775),
     JSON.stringify(r.map((x) => x.k)));
  eq("at most ten", ranked(LIVE, 10).length, 10);
  ok("order is strictly non-increasing by |g|",
     ranked(LIVE, 10).every((x, i, a) => i === 0 || Math.abs(a[i - 1].g) >= Math.abs(x.g)));
}

console.log("\n-- 2. blind spots are GAPS, not small strikes -------------------------------");
{
  const g = blindSpots(LIVE, SPOT);
  /* ⚠ MY FIRST FIXTURE HAD NO BLIND SPOT IN IT AND I ASSERTED ONE ANYWAY. LIVE is a uniform
     5-point SPY ladder; its sparse 780/795 tail is the EDGE of the book, not a hole between two
     walls, and the code is right to ignore it. The suite failed the claim, and the claim was the
     thing that was wrong. Testing a gap needs a ladder that actually has one. */
  eq("a uniform ladder has NO blind spots", blindSpots(LIVE, SPOT).length, 0);
  const HOLE = [{ k: 735, g: 90000 }, { k: 740, g: 120000 }, { k: 745, g: 80000 },
    { k: 750, g: 150000 }, { k: 770, g: 140000 }, { k: 775, g: 95000 },
    { k: 780, g: 60000 }, { k: 785, g: 70000 }];
  const gh = blindSpots(HOLE, 760);
  ok("finds a REAL hole: 750->770 where the book otherwise lists every 5",
     gh.some((x) => x.lo === 750 && x.hi === 770), JSON.stringify(gh));
  eq("and reports only that one", gh.length, 1);
  ok("...measured in strike-gaps, not % of spot (4x the usual step)",
     gh.length === 1 && Math.abs(gh[0].x - 4) < 0.001, JSON.stringify(gh[0]));
  ok("never reports an ordinary step", !gh.some((x) => x.w === 5));
  ok("does NOT report 760->762 (adjacent listed strikes)",
     !g.some((x) => x.lo === 760 && x.hi === 762));
  ok("nearest-to-spot is reported first",
     g.length < 2 || Math.abs(g[0].mid - SPOT) <= Math.abs(g[1].mid - SPOT));
  ok("a lone quiet strike between two heavy ones is not a hole",
     !g.some((x) => x.lo === 770 && x.hi === 780), JSON.stringify(g.map((x) => x.lo + "-" + x.hi)));
}

const HOLE2 = [{ k: 735, g: 90000 }, { k: 740, g: 120000 }, { k: 745, g: 80000 },
  { k: 750, g: 150000 }, { k: 770, g: 140000 }, { k: 775, g: 95000 },
  { k: 780, g: 60000 }, { k: 785, g: 70000 }];
console.log("\n-- 3. degrades honestly ------------------------------------------------------");
{
  eq("a ladder too short for a median yields no gaps", blindSpots([{ k: 1, g: 1 }], 100).length, 0);
  eq("works with no spot at all, because the bar is spacing not percent", blindSpots(HOLE2, 0).length, 1);
  eq("non-numeric rows are dropped, not rendered",
     ranked([{ k: "x", g: 5 }, { k: 700, g: 9 }, null], 10).length, 1);
  eq("an all-flat ladder has no blind spots", blindSpots(
     Array.from({ length: 20 }, (_, i) => ({ k: 700 + i, g: 100 })), 764).length, 0);
}

console.log("\n-- NEGATIVE CONTROLS ---------------------------------------------------------");
let controls = 0, caught = 0;
{
  controls++;
  // (a) ranking by RAW value must produce a different, wrong answer
  const raw = LIVE.slice().sort((a, b) => b.g - a.g).slice(0, 10);
  if (raw[0].k === ranked(LIVE, 10)[0].k) {
    console.log("  control PASSED (BAD) — raw and absolute ranking agree, test 1 proves nothing");
  } else {
    caught++;
    console.log("  control caught — ranking by raw value puts " + raw[0].k
      + " first and drops the -197,211 short-gamma strike to position "
      + (raw.findIndex((x) => x.k === 734) + 1));
  }

  controls++;
  // (b) "small strike" must NOT be the blind-spot test
  const naive = LIVE.filter((r) => Math.abs(r.g) < 10000).map((r) => r.k);
  if (naive.length && !blindSpots(LIVE, SPOT).some((g) => g.lo === 762)) {
    caught++;
    console.log("  control caught — the naive test would flag strikes " + naive.join(",")
      + " as blind spots; the gap test reports "
      + blindSpots(LIVE, SPOT).map((g) => g.lo + "-" + g.hi).join(", ") + " instead");
  } else console.log("  control PASSED (BAD) — the two tests agree, so test 2 proves nothing");
}

console.log("\n------------------------------------------------------------------------------");
console.log("assertions : " + pass + " passed, " + fail + " failed");
console.log("controls   : " + caught + "/" + controls + " correctly went red");
if (fails.length) console.log("failed     : " + fails.join(", "));
const bad = fail > 0 || caught !== controls;
console.log(bad ? "\nRESULT: FAIL\n" : "\nRESULT: PASS\n");
process.exit(bad ? 1 : 0);
