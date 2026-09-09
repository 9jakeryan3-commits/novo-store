/* css-reachability.js — is a CSS selector REACHABLE, or is it dead residue?
 *
 * WHY THIS EXISTS. The 2026-08-29 fork-and-strip removed the execution product's MARKUP and left
 * its STYLESHEET. `trader-live.html` still declares 120 classes and 28 ids that nothing references
 * outside the `<style>` blocks — the trade log, the fire bar, the risk drawer, the broker header.
 * Seven of them declare a 4-sided border, so every source-scanning sweep (border-ban, de-box, font,
 * colour) re-flags them forever. That cost a full review round on 2026-09-08: `.risk-notice` was
 * reported as a live border-ban violation, carried upward, and killed only when someone finally
 * asked whether any element could ever carry the class. Nothing renders it. It is not a violation,
 * it is a rule with no element.
 *
 * A sweep that cannot tell those apart produces noise that masks real hits. The fix is a filter on
 * the INSTRUMENT, not 26 edits to the file — deleting the dead CSS alone leaves the next sweep just
 * as noisy.
 *
 * ── TWO TRAPS THIS FILE EXISTS TO NOT REPEAT ─────────────────────────────────────────────────
 *
 * 1. BOUNDARY-MATCH, NEVER A BARE TOKEN. A class name is a prefix of other class names by design:
 *    `preset-pill` / `preset-pills`, `novo-chart` / `novo-chart-legend`, `tl-badge` / `tl-badge-win`.
 *    A bare `indexOf('preset-pill')` counts `preset-pills` as a reference, OVER-counts references,
 *    and therefore UNDER-reports orphans — it fails silently in the direction of "looks clean",
 *    which is the direction nobody checks. Measured on 2026-09-08: bare matching reported
 *    `novo-chart` at 3 references when the true count is 1, and `preset-pill` at 6 when it is 5.
 *
 * 2. SCOPE THE SWEEP TO THE WHOLE ESTATE, NOT ONE REPO. The same orphan stylesheet ships in
 *    `NoVo-Pulse/chart_service.py` (the live engine behind chart.novo-options.trade) as well as
 *    `novo-store/public/trader-live.html`. A filter pointed only at the store would keep passing
 *    the engine copy forever while looking finished. `c2_dashboard.py` carries a third copy AND the
 *    only real element, but it is dockerignored, so it never ships.
 *    An ABSENCE claim needs a wider scope than a FIND does.
 */
'use strict';

/** Strip CSS/JS/HTML comments so a commented-out reference does not count as use. */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // CSS + JS block
    .replace(/<!--[\s\S]*?-->/g, ' ');   // HTML
}

/** Split a document into its stylesheet text and everything else (markup, JS, template strings). */
function splitStyleFromRest(src) {
  const s = stripComments(src);
  let style = '';
  const rest = s.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, css) => {
    style += '\n' + css;
    return ' ';
  });
  // A .py/.js page embeds its CSS in a string with no <style> tag. If we found none, treat any
  // region that looks like a rule block as style — conservative: it only ever ADDS to `style`,
  // which can only make a token look MORE referenced, never less. Erring toward "reachable" keeps
  // this filter from deleting a live rule.
  if (!style.trim()) return { style: s, rest: s };
  return { style, rest };
}

/**
 * Is `token` referenced anywhere OUTSIDE the stylesheet?
 * Boundary-matched on both sides, so `preset-pill` does not match `preset-pills`.
 */
function isReferencedOutsideStyle(token, rest) {
  const t = String(token).replace(/^[.#]/, '');
  if (!t) return false;
  const re = new RegExp('(^|[^\\w-])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\w-]|$)');
  return re.test(rest);
}

/**
 * Classify one selector token against a document.
 * Returns 'live' (something can carry it) or 'orphan' (declared, never referenced).
 */
function classify(token, src) {
  const { rest } = splitStyleFromRest(src);
  return isReferencedOutsideStyle(token, rest) ? 'live' : 'orphan';
}

/**
 * The filter a sweep should call: given the tokens it flagged, drop the unreachable ones.
 * `sources` is every document that could reference the token — pass the WHOLE estate, not one file.
 */
function filterReachable(tokens, sources) {
  const joined = sources.map((s) => splitStyleFromRest(s).rest).join('\n');
  const live = [], orphan = [];
  for (const t of tokens) (isReferencedOutsideStyle(t, joined) ? live : orphan).push(t);
  return { live, orphan };
}

/* ── SELF-TEST. Runs on `node css-reachability.js`. Exits non-zero if any control fails, because a
 * filter that cannot be shown to discriminate is worth less than no filter — it would silently
 * suppress real hits. Every case below is drawn from a real 2026-09-08 measurement. */
function selfTest() {
  const doc = [
    '<style>',
    '  .risk-notice { border: 1px solid #f59e0b; }',   // declared, never used  -> orphan
    '  .desk-rail { display: flex; }',                  // used in markup        -> live
    '  .preset-pill { border: 1px solid #333; }',       // prefix trap           -> orphan
    '  .preset-pills { gap: 6px; }',                    // the longer name IS used -> live
    '  .cmd-liquidate { color: red; }',                 // execution residue     -> orphan
    '</style>',
    '<div id="desk-rail" class="desk-rail"><div class="preset-pills"></div></div>',
    '<!-- <div class="risk-notice">commented out, must NOT count as use</div> -->',
  ].join('\n');

  const cases = [
    ['risk-notice',    'orphan', 'declared but no element, and the only mention is in a comment'],
    ['desk-rail',      'live',   'referenced in markup'],
    ['preset-pill',    'orphan', 'PREFIX TRAP: must not be satisfied by .preset-pills'],
    ['preset-pills',   'live',   'the longer name is genuinely used'],
    ['cmd-liquidate',  'orphan', 'execution residue'],
  ];

  let bad = 0;
  for (const [token, want, why] of cases) {
    const got = classify(token, doc);
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${token.padEnd(15)} want=${want.padEnd(6)} got=${got.padEnd(6)} ${why}`);
  }

  // The control that makes the orphans mean something: the instrument must be ABLE to say 'live'.
  // If everything came back 'orphan', the passes above would be an artifact, not a measurement.
  const liveCount = cases.filter(([t]) => classify(t, doc) === 'live').length;
  const canSayLive = liveCount > 0;
  console.log(`  ${canSayLive ? 'PASS' : 'FAIL'}  control        the filter can return 'live' at all (${liveCount}/5)`);
  if (!canSayLive) bad++;

  console.log('\n' + (bad ? `FAILED ${bad}` : 'OK — all controls pass') + '\n');
  return bad ? 1 : 0;
}

module.exports = { classify, filterReachable, isReferencedOutsideStyle, splitStyleFromRest };

if (require.main === module) process.exit(selfTest());
