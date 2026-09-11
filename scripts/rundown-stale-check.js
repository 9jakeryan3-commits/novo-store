#!/usr/bin/env node
/* scripts/rundown-stale-check.js — the daily rundown must not call itself stale on the day it ran.
 *
 * Jake, 2026-09-10 21:59 ET, screenshot: the crypto Daily Rundown headed "Dr. NoVo · 2026-09-10"
 * carried the banner "This is not today's rundown. It was written on 2026-09-10". On 2026-09-10.
 *
 * THE OLD TEST COMPARED TWO UTC CALENDAR LABELS. A calendar rolls at 00:00 UTC; the cron does not
 * fire until 12:15 UTC. So for the twelve hours in between — 20:00 to 08:15 Eastern — a perfectly
 * current rundown declared itself missing. The fix makes staleness an ELAPSED-TIME question, and
 * this suite walks a full 24 hours to prove it, because a bug that only appears in the evening is
 * exactly the bug a spot check at lunchtime misses.
 *
 * Run: node scripts/rundown-stale-check.js
 */

const path = require("path");

/* The handler requires _kv at load; stub it so this stays a pure-logic test with no network. */
const kvPath = require.resolve(path.join(__dirname, "..", "api", "_kv.js"));
require.cache[kvPath] = { id: kvPath, filename: kvPath, loaded: true, exports: { kv: () => null } };

const { rundownStale } = require("../api/eye-readings.js");

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; fails.push(name); console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

const H = 3600000;
/* 2026-09-10, the day in the screenshot. The run fires at 12:15 UTC = 08:15 ET. */
const RUN = Date.UTC(2026, 8, 10, 12, 15, 0);
const read = (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), as_of: new Date(ms).toISOString() });

function utc(y, mo, d, h, mi) { return Date.UTC(y, mo, d, h, mi, 0); }
function label(ms) {
  const et = new Date(ms - 4 * H);  // Sep is EDT (UTC-4); this is for the printout only
  return new Date(ms).toISOString().slice(11, 16) + "Z (" +
         String(et.getUTCHours()).padStart(2, "0") + ":" + String(et.getUTCMinutes()).padStart(2, "0") + " ET)";
}

console.log("\n── THE REPORTED BUG: 9:59 PM ET on the day it was written ───────────────────");
{
  const now = utc(2026, 8, 11, 1, 59);          // 01:59 UTC Sep 11 == 21:59 ET Sep 10
  ok("a rundown written this morning is NOT stale at 9:59 PM ET",
     rundownStale(read(RUN), now) === false,
     "stale=" + rundownStale(read(RUN), now) + " at " + label(now));
}

console.log("\n── A FULL 24 HOURS: a same-day rundown is never stale ───────────────────────");
{
  /* From the moment it is written until the next run is due plus grace, it is current. */
  let wrong = [];
  for (let m = 0; m < 24 * 60; m += 5) {
    const now = RUN + m * 60000;
    // the next run is due 24h later; allow the grace window before we expect a fresh one
    if (m >= 24 * 60 - 1) break;
    if (rundownStale(read(RUN), now)) wrong.push(label(now));
  }
  ok("never stale in the 24h after it was written", wrong.length === 0,
     wrong.length + " false positives, first at " + (wrong[0] || "-"));
}

console.log("\n── IT MUST STILL CATCH A RUN THAT ACTUALLY FAILED ───────────────────────────");
{
  /* Yesterday's rundown, and today's run is overdue. That is a real failure and must say so. */
  const yesterday = RUN - 24 * H;
  const afterToday = RUN + 60 * 60000;          // an hour past today's run, which never landed
  ok("yesterday's rundown IS stale once today's run is overdue",
     rundownStale(read(yesterday), afterToday) === true,
     "stale=" + rundownStale(read(yesterday), afterToday));

  const twoDays = RUN - 48 * H;
  ok("a two-day-old rundown is stale", rundownStale(read(twoDays), afterToday) === true);
}

console.log("\n── THE GRACE WINDOW: a late cron is not a failure ───────────────────────────");
{
  const yesterday = RUN - 24 * H;
  // 12:20 UTC — today's run is 5 minutes late. Yesterday's read should NOT yet be called stale.
  const justAfterDue = utc(2026, 8, 10, 12, 20);
  ok("5 minutes after the run time, yesterday's read is not yet condemned",
     rundownStale(read(yesterday), justAfterDue) === false,
     "stale=" + rundownStale(read(yesterday), justAfterDue));

  // 13:30 UTC — well past the 45-minute grace, and nothing landed. Now it is stale.
  const pastGrace = utc(2026, 8, 10, 13, 30);
  ok("past the grace window with nothing new, it IS stale",
     rundownStale(read(yesterday), pastGrace) === true,
     "stale=" + rundownStale(read(yesterday), pastGrace));
}

console.log("\n── LEGACY ROWS: a read with no as_of still gets a verdict ───────────────────");
{
  const afterToday = RUN + 60 * 60000;
  ok("a day-string-only read from today is not stale",
     rundownStale({ day: "2026-09-10" }, afterToday) === false);
  ok("a day-string-only read from last week is stale",
     rundownStale({ day: "2026-09-03" }, afterToday) === true);
  ok("no read at all is not 'stale' (there is nothing to be stale)",
     rundownStale(null, afterToday) === false);
}

console.log("\n── NEGATIVE CONTROLS: the OLD logic must fail this suite ────────────────────");
/* If the old calendar comparison would have passed the tests above, the tests are not measuring
   the bug. Reimplement it here and prove it goes red on the exact case Jake screenshotted. */
{
  const oldStale = (rd, nowMs) => {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    return !!(rd.day && rd.day !== today);
  };
  let controls = 0, caught = 0;

  controls++;
  const evening = utc(2026, 8, 11, 1, 59);   // 9:59 PM ET Sep 10
  if (oldStale(read(RUN), evening)) { caught++; console.log("  control caught — old logic DID flag the 9:59 PM case (the bug)"); }
  else console.log("  control PASSED (BAD) — old logic looks fine here, so this test proves nothing");

  controls++;
  // count how many of the 24h samples the old logic got wrong
  let wrongOld = 0;
  for (let m = 0; m < 24 * 60; m += 5) {
    if (oldStale(read(RUN), RUN + m * 60000)) wrongOld++;
  }
  if (wrongOld > 0) { caught++; console.log("  control caught — old logic false-positives on " + wrongOld + " of 288 samples"); }
  else console.log("  control PASSED (BAD) — old logic never false-positived");

  console.log("\n──────────────────────────────────────────────────────────────────────────────");
  console.log("assertions : " + pass + " passed, " + fail + " failed");
  console.log("controls   : " + caught + "/" + controls + " correctly went red");
  if (fails.length) console.log("failed     : " + fails.join(", "));
  const bad = fail > 0 || caught !== controls;
  console.log(bad ? "\nRESULT: FAIL\n" : "\nRESULT: PASS\n");
  process.exit(bad ? 1 : 0);
}
