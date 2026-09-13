/* csstext-box-check.js — the boxes the de-box pass structurally could not see.
 *
 * WHY THIS EXISTS, AND WHY debox-check.js DOES NOT COVER IT.
 * `debox-check.js` asserts on the COMPUTED STYLE of real elements, which is the right instrument for
 * anything the page renders on load — a grep cannot tell a deleted declaration from one overridden
 * two rules later. But computed style can only see elements that EXIST while the scan runs, and the
 * worst offenders here never do:
 *
 *   #novoInstall  — built only when the browser fires `beforeinstallprompt`
 *   #novoNotif    — built only on the push-permission path
 *
 * Both are `position:fixed; z-index:9999` buttons over the dashboard, both shipped with a 4-sided
 * border or a gradient fill plus `box-shadow`, and neither is instantiated in a headless run. So the
 * existing check could return green forever while boxed buttons shipped — which is the
 * checks-that-cannot-fail shape, not a gap in diligence.
 *
 * WHAT IT ASSERTS: no `element.style.cssText = '…'` in the dashboards or their shared modules
 * carries a 4-sided border, a border-radius on a CONTAINER, or a box-shadow.
 * Jake, 2026-09-07: "boxes and borders are banned. no more full boxes only line breaks can be used."
 * Extended to buttons 2026-09-08: "button borders need to go as well … we click the link word button."
 * Single-side hairlines (`border-top`/`border-bottom`) are the separator the rule asks FOR and pass.
 *
 * ⚠ THIS FILE CHECKS ITSELF FIRST. A detector that has only ever returned zero has never been shown
 * to fail, and a silently-broken matcher reads identically to a clean tree. Every run feeds a
 * synthetic violation through the same matcher and aborts if it does not fire.
 */
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
let failures = 0, checks = 0;
const ok = (n, c, d) => { checks++; if (c) return console.log('  PASS  ' + n);
  failures++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); };

/* Accepted, with the reason. A rounded corner on a PHOTO is a photo corner, not a container box —
   the ban is about panels, cards and buttons. Anything not listed here is a failure, so a new box
   cannot be absorbed silently; it has to be argued for in this list. */
/* ⚠ EXACT DECLARATIONS, NOT FILENAMES AND NOT SUBSTRINGS. Two separate bugs lived here.
   1. These exemptions were scoped to analyst-live.html, so the BYTE-IDENTICAL code in
      crypto-live.html and js/novo-chat.js failed forever. The guard built to catch three-copy
      drift had the three-copy problem itself -- an exemption argued once covered one copy.
      Temi refused to sweep the four it flagged, checked all three copies were identical, and
      found e531f078f in the history where the radius was deliberately kept and the border
      removed. Sweeping them would have undone a four-hour-old ruling. A guard that cries wolf
      eventually gets obeyed, and the obedient sweep is the regression.
   2. My first repair matched a SUBSTRING, which exempted anything APPENDED to the declaration:
      adding box-shadow to the approved overlay did not fire. An exemption that grows with the
      code it exempts is a check that cannot fail. EXACT equality means any edit -- however
      small -- drops out of the allowlist and has to be argued again, which is the property the
      header above already asks for.
   Both halves shown to discriminate: shadow added to the overlay fires, border added to a photo
   corner fires, restored state green. const ALLOW = [
  { is: 'display:block;margin:6px 0 0;max-width:min(240px,60%);width:auto;border-radius:8px;cursor:zoom-in;',
    why: 'sent-image thumbnail - a rounded PHOTO corner, no border, no shadow' },
  { is: 'height:34px;width:auto;max-width:84px;border-radius:4px;display:block;',
    why: 'attached-image preview in the composer - photo corner' },
  { is: 'position:absolute;z-index:400;background:#14161b;border:1px solid var(--bdr2);',
    why: 'layouts menu - floating overlay over live content, hairline boundary per the .termpop ruling' },
];

function scan(src) {
  const out = [];
  const re = /cssText\s*=\s*(['"`])([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const css = m[2];
    const why = [];
    if (/border\s*:\s*(?!none|0)/.test(css)) why.push('4-sided border');
    if (/border-radius/.test(css)) why.push('border-radius');
    if (/box-shadow/.test(css)) why.push('box-shadow');
    if (why.length) out.push({ line: src.slice(0, m.index).split('\n').length, css, why });
  }
  return out;
}

/* ── SELF-TEST: prove the matcher fires before believing any zero it reports ── */
const CANARY = "el.style.cssText = 'padding:4px;border:1px solid #fff;border-radius:9px;box-shadow:0 2px 4px #000';";
const canaryHits = scan(CANARY);
if (canaryHits.length !== 1 || canaryHits[0].why.length !== 3) {
  console.log('  ABORT  self-test failed: the matcher did not fire on a known violation.');
  console.log('         Every "0 findings" from this script would have been meaningless.');
  process.exit(2);
}
console.log('  PASS  self-test — matcher fires on a synthetic box (border + radius + shadow)');
checks++;

const FILES = ['analyst-live.html', 'trader-live.html', 'crypto-live.html']
  .map(f => path.join(PUBLIC, f))
  .concat(fs.readdirSync(path.join(PUBLIC, 'js')).filter(f => f.endsWith('.js')).map(f => path.join(PUBLIC, 'js', f)));

/* CORPUS FLOOR: an empty scan must never read as a clean one. */
const present = FILES.filter(f => fs.existsSync(f));
ok(`corpus — ${present.length} files scanned (floor 12)`, present.length >= 12,
   `only ${present.length} found; a shrunken corpus makes a green run meaningless`);

let found = 0;
for (const f of present) {
  const rel = path.basename(f);
  const hits = scan(fs.readFileSync(f, 'utf8'));
  for (const h of hits) {
    const allowed = ALLOW.some(a => a.is === h.css);          // EXACT, not substring -- see ALLOW
    if (allowed) continue;
    found++;
    ok(`${rel}:${h.line} — ${h.why.join(' + ')}`, false, h.css.replace(/\s+/g, ' ').slice(0, 110) + '…');
  }
}
if (!found) console.log('  PASS  no un-allowed cssText box in any dashboard or shared module');

console.log(`\n  ${checks} checks, ${failures} failing`);
process.exit(failures ? 1 : 0);
