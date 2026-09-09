/* health-assert.js — assert /api/health's TOP-LEVEL ok is true. Exit 0 pass, 1 fail.
 *
 * WHY THIS IS A SCRIPT AND NOT A GREP. deploy.sh's smoke() greps the response body as flat text.
 * Three things follow, and all three bit us on 2026-09-08:
 *
 *   1. The original needle was '"sha"'. A degraded body still contains "sha", so every deploy from
 *      09-07 onward smoke-tested health and was told it was fine while it sat at ok:false. The
 *      pipeline asserted that health RESPONDS, never that it is HEALTHY.
 *
 *   2. The obvious repair — needle '"ok":true' — is ALSO a check that cannot fail. The body nests
 *      drift.price_sets.ok:true and drift.account_prices.ok:true, so the substring matches while
 *      the top-level ok is false. Verified against the live red build before it was written.
 *
 *   3. Anchoring the grep to ^{"ok":true would pass today only because health.js emits `ok` first
 *      AND the body is a single line. Both are incidental. Someone reordering that object literal —
 *      a cosmetic change nobody reviews closely — would silently restore the broken check, with no
 *      diff anywhere near deploy.sh to explain why.
 *
 * A JSON key's position is not a property of the JSON. Parse it.
 *
 * SEQUENCING, because getting this backwards blocks the pipeline: this assertion must only be
 * armed AFTER the tool sets are classified and ok:true is confirmed live. Tightening first fails
 * every deploy, including the deploy carrying the fix.
 */
'use strict';

/** The assertion itself, separated from the fetch so it can be tested on bodies we construct. */
function isHealthy(bodyText) {
  let d;
  try { d = JSON.parse(bodyText); } catch (_) { return { ok: false, why: 'body is not JSON' }; }
  if (d === null || typeof d !== 'object') return { ok: false, why: 'body is not an object' };
  if (d.ok === true) return { ok: true, why: 'ok:true' };
  const deg = Array.isArray(d.degraded) && d.degraded.length ? d.degraded.join(', ') : 'none listed';
  return { ok: false, why: `ok:${JSON.stringify(d.ok)} degraded:[${deg}]` };
}

/* ── SELF-TEST. `node health-assert.js --selftest`. Every case is a real body shape.
 * The whole point of this file is that a check must be SHOWN to fail before it is trusted —
 * and production stopped being a free known-bad fixture the moment the tool sets were classified,
 * so the red body is preserved here verbatim. */
function selfTest() {
  const RED = '{"ok":false,"degraded":["tool-sets"],"build":{"sha":"86934a0a79a1"},'
    + '"drift":{"price_sets":{"ok":true,"unclassified":[]},'
    + '"tool_sets":{"ok":false,"declared":33,"unclassified":["search_x"],"stale":[]},'
    + '"account_prices":{"ok":true,"drift_count":0}},"stripe_configured":true}';
  const GREEN = '{"ok":true,"degraded":[],"build":{"sha":"86934a0a79a1"},'
    + '"drift":{"price_sets":{"ok":true},"tool_sets":{"ok":true},"account_prices":{"ok":true}}}';

  const cases = [
    ['real degraded body (the 09-07..09-08 state)', RED,   false],
    ['real healthy body',                            GREEN, true ],
    ['ok missing entirely',                          '{"degraded":[]}', false],
    ['ok is a string, not a boolean',                '{"ok":"true"}',   false],
    ['not JSON at all (an HTML error page)',         '<!doctype html>', false],
  ];

  let bad = 0;
  for (const [name, body, want] of cases) {
    const got = isHealthy(body).ok;
    if (got !== want) bad++;
    console.log(`  ${got === want ? 'PASS' : 'FAIL'}  want=${String(want).padEnd(5)} got=${String(got).padEnd(5)} ${name}`);
  }

  // The control that makes the failures mean something: a naive substring needle PASSES the red
  // body. If this ever stops being true the red fixture has drifted and no longer reproduces the bug.
  const naivePassesRed = /"ok":true/.test(RED);
  console.log(`  ${naivePassesRed ? 'PASS' : 'FAIL'}  control  the naive '"ok":true' needle still matches the RED body (proves why grep is wrong)`);
  if (!naivePassesRed) bad++;

  console.log('\n' + (bad ? `FAILED ${bad}` : 'OK — all controls pass') + '\n');
  return bad ? 1 : 0;
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === '--selftest') process.exit(selfTest());

  let body;
  try {
    const r = await fetch(arg + (arg.includes('?') ? '&' : '?') + 'v=' + Date.now(),
      { headers: { 'user-agent': 'novo-deploy-check/1.0' } });
    body = await r.text();
    if (r.status !== 200) { console.error(`!! health http ${r.status}`); process.exit(1); }
  } catch (e) {
    console.error('!! health unreachable:', e.message);
    process.exit(1);
  }
  const v = isHealthy(body);
  console.log(`   health: ${v.why}`);
  /* process.exitCode, NOT process.exit(). Calling process.exit() here while fetch's handle is
     still closing trips a libuv assertion on Node 24 / Windows and the process dies with 127 --
     which deploy.sh's `if ! node ...` reads as FAILURE, so a green health check would have failed
     every deploy. Caught by running it against live production before trusting it; the self-test
     alone would never have surfaced it, because the self-test never opens a socket. */
  process.exitCode = v.ok ? 0 : 1;
}

module.exports = { isHealthy };
if (require.main === module) main();
