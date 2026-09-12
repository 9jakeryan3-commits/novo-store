// scripts/inline-js-check.js — every inline <script> on every page must PARSE, before it ships.
//
// Two dead surfaces shipped in ONE day (2026-09-11) with smoke green. A straight ASCII apostrophe
// inside a single-quoted JS string (3a1e6c50b, analyst-live.html) killed a 55,188-char inline
// block at parse time; the block held showLogin/showDash/poll and the boot line, both panels ship
// hidden in markup, so /analyst/live served a BLANK page to paying subscribers — while returning
// 200 with a full-size body. The GET-only smoke passed 7/7. Parse failure is invisible to every
// other check in the pipeline: it is not a diff problem, not a size problem, not a status problem.
//
// The first attempt at this gate spawned `node --check` per block across ~1,430 pages and blew a
// 120-second budget; it was correctly pulled rather than shipped as a gate nobody can afford to
// run. This one compiles IN-PROCESS with vm.Script — no spawn, whole corpus in seconds.
//
// What it checks: every <script> block with no src= and a classic-JS type (none, text/javascript,
// application/javascript). type="module" blocks are skipped (vm.Script cannot compile module
// syntax; the corpus has zero today — if one ever appears it is skipped, not failed, and this
// comment is the note to extend the gate). Splitting on </script> matches BROWSER termination
// rules, so what this parses is exactly what the browser would execute.
//
// EMPTY IS NOT A PASS. A glob bug that finds zero files must fail this gate, not green it: the
// corpus floor below asserts we scanned something the size of the real site. And the instrument
// proves it can still detect a defect on EVERY run (a known-bad snippet must throw) before any
// verdict is issued — a checker that cannot fail is not a check.
//
// Sabotage-tested against the real defect before wiring: fails on 3a1e6c50b's analyst-live.html
// naming line 1148, passes on bb1f4e5d9's fix. Re-run that test with:
//   git show 3a1e6c50b:public/analyst-live.html > /tmp/bad.html
//   node scripts/inline-js-check.js /tmp/bad.html   (must exit 1)

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MIN_FILES = 50;    // the real corpus is ~1,430 pages; under this the scan itself is broken
const MIN_BLOCKS = 100;  // and it carries thousands of inline blocks

// ── instrument self-test: this must throw, every run, or the checker is lying ──────────────────
(function selfTest() {
  let threw = false;
  try { new vm.Script("var x = 'book's';", { filename: 'selftest' }); } catch (_) { threw = true; }
  if (!threw) {
    console.error('!! inline-js-check: self-test FAILED — vm.Script accepted a known-bad snippet.');
    console.error('!! The instrument cannot detect the defect class it exists for. Refusing to pass anything.');
    process.exit(1);
  }
})();

const SCRIPT_RE = /<script\b([^>]*)>/gi;
const CLASSIC_TYPE_RE = /^\s*(text\/javascript|application\/javascript)\s*$/i;

function checkFile(file) {
  const html = fs.readFileSync(file, 'utf8');
  const failures = [];
  let blocks = 0;
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const attrs = m[1] || '';
    const bodyStart = m.index + m[0].length;
    // The browser ends the block at the first </script>, string literal or not — so do we.
    const end = html.toLowerCase().indexOf('</script', bodyStart);
    const body = html.slice(bodyStart, end === -1 ? html.length : end);
    SCRIPT_RE.lastIndex = end === -1 ? html.length : end;
    if (/\bsrc\s*=/i.test(attrs)) continue;                       // external: stamped + fetched, not inline
    const typeMatch = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (typeMatch && !CLASSIC_TYPE_RE.test(typeMatch[1])) continue; // ld+json, module, templates
    if (!body.trim()) continue;
    blocks++;
    const lineOffset = html.slice(0, bodyStart).split('\n').length - 1;
    try {
      new vm.Script(body, { filename: file, lineOffset });
    } catch (e) {
      // e.stack's first lines carry file:line and the caret; the message alone often lacks the line
      const where = String(e.stack || e.message).split('\n').slice(0, 5).join('\n    ');
      failures.push({ file, line: lineOffset + 1, msg: where });
    }
  }
  return { blocks, failures };
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.toLowerCase().endsWith('.html')) out.push(p);
  }
  return out;
}

// Argument mode: check exactly the files named (the sabotage-test path). No corpus floor —
// the floor asserts the SITE scan found the site, and a single named file is not the site.
const args = process.argv.slice(2);
const files = args.length ? args : walk(path.join(__dirname, '..', 'public'), []);

let totalBlocks = 0;
const allFailures = [];
for (const f of files) {
  const { blocks, failures } = checkFile(f);
  totalBlocks += blocks;
  allFailures.push(...failures);
}

if (!args.length && (files.length < MIN_FILES || totalBlocks < MIN_BLOCKS)) {
  console.error(`!! inline-js-check: scanned only ${files.length} file(s) / ${totalBlocks} block(s) — ` +
                `the real corpus is ~1,430 pages. The scan is broken; this is NOT a pass.`);
  process.exit(1);
}

if (allFailures.length) {
  console.error(`!! inline-js-check: ${allFailures.length} inline block(s) DO NOT PARSE — ` +
                `each one is a page whose JS is fully dead in the browser:`);
  for (const f of allFailures) {
    console.error(`!!   ${f.file}:${f.line}\n    ${f.msg}`);
  }
  process.exit(1);
}

console.log(`OK  inline-js-check: ${totalBlocks} inline blocks across ${files.length} pages all parse`);
