#!/usr/bin/env node
/**
 * Does /daily-strike EMIT a whole page, not just parse as one?
 *
 * `node --check` proves the file is valid JavaScript. It cannot prove the handler returns a
 * document. The 2026-09-12 header bug was exactly that gap: valid syntax, <head> opened and never
 * closed, no <body> at all — and grepping for the markup PASSED, because the markup WAS there. The
 * STRUCTURE was missing. So every assertion here is on the rendered string, never on the source.
 *
 * This page needs its own check because the two that guard every other page cannot see it:
 *   inline-js-check  walks public/*.html — this page has no static file
 *   the deploy smoke is GET-only, so a broken page answers 200 with a full-size body and certifies
 *
 * Run it before committing api/daily-strike.js:  node scripts/check-daily-strike.js
 * Add --self-test to prove the checker can fail before believing that it passed.
 */
const path = require('path');

/* The checks, split out so --self-test can run them against deliberately broken bodies.
   A check that has never been shown to fail is decoration. */
function check(body, status) {
  const fail = [];
  const need = [
    [/<!doctype html>/i, 'no doctype'],
    [/<head[\s>]/i, '<head> never opened'],
    [/<\/head>/i, '<head> OPENED BUT NEVER CLOSED — the 2026-09-12 bug'],
    [/<body[\s>]/i, 'no <body>'],
    [/<\/body>\s*<\/html>/i, 'document never closed'],
    [/<title>[^<]{3,}<\/title>/i, 'empty or missing <title>'],
  ];
  for (const [re, why] of need) if (!re.test(body)) fail.push(why);

  // Tag balance on the containers that nest. A stray </div> reads fine in a diff and collapses
  // everything below it in a browser.
  for (const t of ['div', 'section', 'head', 'body', 'main']) {
    const o = (body.match(new RegExp('<' + t + '[\\s>]', 'gi')) || []).length;
    const c = (body.match(new RegExp('</' + t + '>', 'gi')) || []).length;
    if (o !== c) fail.push(t + ': ' + o + ' open vs ' + c + ' close');
  }

  // A panel that silently returns '' leaves its heading with nothing under it.
  if (body.length < 8000) fail.push('body is only ' + body.length + ' chars — a panel returned empty');
  if (status && status >= 400) fail.push('handler answered ' + status);
  return fail;
}

async function render() {
  const mod = path.join(__dirname, '..', 'api', 'daily-strike.js');

  /* api/daily-strike.js is a HYBRID: it uses `import` at the top (so Node auto-detects it as an ES
     module even though package.json says commonjs) and then calls `require('./_kv.js')` at top
     level, which is undefined in ESM scope. It only runs in production because Vercel's bundler
     rewrites it. To render it here, put a `require` in global scope for it to find — resolved
     against api/ so its own relative paths ('./_kv.js') land in the right directory rather than
     next to this script. */
  if (typeof globalThis.require === 'undefined') {
    globalThis.require = require('module').createRequire(mod);
  }
  // It also assigns `module.exports = handler`, which is likewise undefined in ESM scope, so the
  // export has to be caught in a global the file can reach.
  const shim = { exports: {} };
  globalThis.module = shim;
  globalThis.exports = shim.exports;

  const imported = await import('file:///' + mod.replace(/\\/g, '/'));
  const handler = (typeof shim.exports === 'function' && shim.exports)
    || imported.default
    || (typeof imported === 'function' ? imported : null);
  if (typeof handler !== 'function') {
    throw new Error('no handler function exported (module.exports was '
      + typeof shim.exports + ', default was ' + typeof imported.default + ')');
  }
  let body = '', status = 0;
  const res = {
    setHeader() {}, status(s) { status = s; return this; },
    send(b) { body = String(b); return this; },
    end(b) { if (b) body = String(b); return this; },
    json(o) { body = JSON.stringify(o); return this; },
  };
  await handler({ method: 'GET', query: {}, headers: {} }, res);
  return { body, status };
}

(async () => {
  const { body, status } = await render();

  if (process.argv.includes('--self-test')) {
    // THREE POSITIVE CONTROLS, one per defect class this exists to catch. The real rendered body
    // is mutated rather than the module, because a modified copy inside api/ would sit in the
    // shared tree as an untracked file and block everyone's deploy.
    const cases = [
      ['</head> deleted', body.replace('</head>', ''), /never closed|head:/i],
      ['one </div> deleted', body.replace('</div>', ''), /^div: /],
      ['a panel returned empty (body truncated)', body.slice(0, 5000), /body is only/],
    ];
    let bad = 0;
    for (const [name, mutated, expect] of cases) {
      const f = check(mutated, status);
      const caught = f.some((x) => expect.test(x));
      if (!caught) bad++;
      console.log('  ' + (caught ? 'PASS' : 'FAIL') + '  ' + name.padEnd(40)
        + (caught ? f.filter((x) => expect.test(x))[0] : 'NOT CAUGHT — the check has a hole'));
    }
    const clean = check(body, status);
    console.log('  ' + (clean.length === 0 ? 'PASS' : 'FAIL') + '  unmutated body is clean'.padEnd(46)
      + (clean.length ? clean.join('; ') : 'no findings'));
    if (bad || clean.length) process.exit(1);
    console.log('  self-test ok — every defect class is caught and the real page is clean');
    return;
  }

  const fail = check(body, status);
  if (fail.length) {
    console.error('check-daily-strike FAILED (local render):\n  ' + fail.join('\n  '));
    process.exit(1);
  }
  console.log('check-daily-strike ok (local) — ' + body.length + ' chars, document closed, tags balanced');

  /* ⚠ THE LOCAL RENDER ONLY EXERCISES THE EMPTY-STATE BRANCH. Without KV credentials kv() returns
     null, readIndex() comes back empty, and the handler returns early on "the first story publishes
     shortly" — so the eight data panels and the whole front-page template never execute. The local
     pass is real but partial, and reporting it as full coverage would be the exact over-claim this
     file exists to prevent.
     So the same assertions run against the deployed page, which DOES take the full branch. Network
     is best-effort: an unreachable production is reported, never a silent pass. */
  const url = 'https://novo-options.trade/daily-strike?cb=' + Date.now();
  let liveBody = null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    const r = await fetch(url, { headers: { 'User-Agent': 'NoVo-checks' }, signal: ac.signal });
    clearTimeout(timer);
    if (r.ok) liveBody = await r.text();
    else console.log('check-daily-strike: production answered ' + r.status + ' — full branch UNVERIFIED');
  } catch (e) {
    console.log('check-daily-strike: could not reach production (' + e.message + ') — full branch UNVERIFIED');
  }
  if (liveBody) {
    const lf = check(liveBody, 200);
    // the deployed page must actually be the full one, or we have verified the wrong branch twice
    if (!/ds-secrow|ds-rrow/.test(liveBody)) lf.push('live page has no stories/panels — same branch as local, full path still UNVERIFIED');
    if (lf.length) {
      console.error('check-daily-strike FAILED (deployed page):\n  ' + lf.join('\n  '));
      process.exit(1);
    }
    console.log('check-daily-strike ok (deployed) — ' + liveBody.length + ' chars, full branch, tags balanced');
  }
})().catch((e) => { console.error('check-daily-strike THREW: ' + e.message); process.exit(1); });
