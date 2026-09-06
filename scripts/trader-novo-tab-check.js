/* trader-novo-tab-check.js — NoVo chat is a real tab on the Trader dashboard.
 *
 * Jake's spec, checked as written: the NoVo button REPLACES Run Analysis on desktop and RUN on
 * mobile, it opens its OWN tab exactly as Analysis does, and it glows green.
 *
 * Driven in headless Chrome because every claim here is about rendered layout and live wiring —
 * whether a panel is visible, whether a view switch reveals it, whether the module's deferred init
 * actually ran. None of that is answerable by reading the file, and the two bugs this build already
 * hit (a null bubble deref, and init running before the panel was mounted) both PASS a syntax check
 * and both fail silently in the page.
 *
 * The page is member-gated, so the token is stubbed and /api/analyst-ask is intercepted. That
 * limits what this proves: it proves the SHELL — mount, tabs, view switching, send path — not that
 * the live endpoint answers. Said plainly rather than implied.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

/* ⚠ SERVED OVER HTTP, NOT file://. The first run of this harness loaded the page as a file URL, so
   `<script src="/js/novo-chat.js">` resolved to the FILESYSTEM ROOT, the module 404'd, and every
   chat function was undefined. Ten checks failed and it looked like a broken port — the product was
   fine and the instrument was wrong. When a result is surprising, suspect the harness first. */
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let SERVER = null, PAGE = '';
const CHROME = process.env.CHROME_BIN || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome found; set CHROME_BIN'); process.exit(2); }

const PORT = Number(process.env.TN_PORT || 9355);
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + path.join(os.tmpdir(), 'trader-novo-' + PORT),
  '--allow-file-access-from-files', '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

let failures = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  PASS  ' + name); return; }
  failures++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
}

/* Stub the member token and the ask endpoint BEFORE any page script runs. */
const PRELUDE = `
  try { localStorage.setItem('novo_live_t', 'stub.token'); } catch (e) {}
  /* ⚠ CLEAR THE SAVED TRANSCRIPT. The Chrome profile persists between runs, so the turn the send
     test posts was still in localStorage on the NEXT run — loadTurns() restored it and CORRECTLY
     replaced the intro with the history, failing "the intro rendered" against working code. The
     harness was testing the residue of its own previous run. Same family as the fixture that
     overwrote a credential and never put it back. */
  try { localStorage.removeItem('novo_ask_log'); } catch (e) {}
  /* ⚠ REAL ERROR CAPTURE. The first version of this harness read window.__pageErrors and NOTHING
     EVER WROTE IT, so "no uncaught page errors" passed while the chat module was throwing at load
     and every chat function was undefined. A check that cannot fail, in the file written to catch
     exactly that — the seventh tonight. */
  window.__pageErrors = [];
  window.addEventListener('error', function (e) {
    window.__pageErrors.push(String((e && e.message) || e) + ' @ ' +
      String((e && e.filename) || '?') + ':' + String((e && e.lineno) || '?'));
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.__pageErrors.push('unhandled rejection: ' + String((e && e.reason && e.reason.message) || e.reason));
  });
  window.__asked = null;
  const _f = window.fetch;
  window.fetch = function (u, o) {
    const url = String(u || '');
    if (url.indexOf('/api/analyst-ask') >= 0) {
      window.__asked = JSON.parse((o && o.body) || '{}');
      return Promise.resolve(new Response(
        JSON.stringify({ answer: 'Stubbed answer.', sources: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    // Everything else on this page is live market data we neither have nor need here.
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  };
`;

(async () => {
  const SPORT = Number(process.env.TN_HTTP || 8781);
  SERVER = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(PUBLIC, rel === '/' ? 'trader-live.html' : rel);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      // A 404 here is the harness failing, not the page — say so rather than serving empty 200s.
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found: ' + rel); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream',
                         'cache-control': 'no-store' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => SERVER.listen(SPORT, '127.0.0.1', r));
  PAGE = 'http://127.0.0.1:' + SPORT + '/trader-live.html';

  const wsUrl = await new Promise((res, rej) => {
    const t = setInterval(async () => {
      try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
        const j = await r.json(); clearInterval(t); res(j.webSocketDebuggerUrl); } catch (_) {}
    }, 120);
    setTimeout(() => { clearInterval(t); rej(new Error('chrome never came up')); }, 15000);
  });

  const ws = new WebSocket(wsUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params, sessionId) => new Promise((res) => {
    const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  await new Promise((r) => { ws.onopen = r; });

  const t = (await send('Target.createTarget', { url: 'about:blank' })).result;
  const s = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result;
  const sid = s.sessionId;
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE }, sid);

  const evalIn = async (expr) => {
    const r = (await send('Runtime.evaluate',
      { returnByValue: true, awaitPromise: true, expression: expr }, sid)).result;
    if (r.exceptionDetails) return { __err: String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text) };
    return r.result.value;
  };

  const load = async (w) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: w < 769 }, sid);
    await send('Page.navigate', { url: PAGE }, sid);
    await new Promise((r) => setTimeout(r, 1400));
  };

  console.log('\nTrader dashboard - NoVo chat tab\n');

  // ── DESKTOP ────────────────────────────────────────────────────────────────────────────────
  await load(1600);

  ok('the module loaded and exposes a mount',
    await evalIn('typeof window.novoChatMount') === 'function',
    'js/novo-chat.js did not execute — check it is reachable at /js/novo-chat.js');
  ok('Run Analysis is gone from the nav',
    await evalIn('!!document.querySelector("[data-run-btn]")') === false);
  ok('a NoVo view button is in its place',
    await evalIn('!!document.querySelector(".navbtn-novo[data-v=\'novo\']")'));

  /* The NAME is a product decision, so it is asserted rather than assumed — Jake, 2026-09-06: the
     analyst is Dr. NoVo, and the chat buttons simply say so with the AI mark in front. Checked as
     rendered text, because an entity like &#10022; that fails to decode still "contains" nothing
     recognisable and would sail past a source grep. */
  const named = await evalIn(`(() => {
    const b = document.querySelector('.navbtn-novo');
    const m = document.querySelector('.mob-tab-novo');
    return { desk: b && b.textContent.trim(),
             mob: m && m.textContent.replace(/[\\s\\u00a0]+/g, ' ').trim() }; })()`);
  /* ⚠ NOT AN EXACT STRING. The button legitimately gained a <kbd>N</kbd> shortcut badge when the
     keyboard layer was made visible, so equality against "✦ Dr. NoVo" started failing a correct
     button. Assert the mark and the NAME and let the badge come and go — an exact-match assertion
     on a control that is still being designed fails for growth as readily as for regression. */
  /* ⚠ ✦ BY CODE POINT, NOT A PASTED GLYPH. A literal ✦ in this file was mangled once by a
     rewriting script, and that failure looks identical to a broken button: the assertion goes red
     while the page is perfect. An escape survives any encoding a tool round-trips the file through. */
  ok('the desktop button reads the AI mark then "Dr. NoVo"',
    /^✦\s*Dr\. NoVo/.test(named.desk || ''), JSON.stringify(named));
  ok('...and carries its keyboard shortcut on the control itself',
    /\bN\b/.test(named.desk || ''), JSON.stringify(named));
  /* ⚠ THE CHAT MUST PAINT ITS OWN BACKGROUND. Left transparent it showed #workspace's rgb(44,44,48)
     and read as a grey card on a black dashboard (Jake spotted it on desktop). "Transparent" is not
     "no colour", it is "whatever is behind me" — and what was behind it was the one grey box on the
     page. Asserted as a COMPUTED colour, because the rule can exist and still lose to specificity. */
  const paint = await evalIn(`(() => {
    const p = document.getElementById('novo-ask'), c = document.getElementById('col-novo');
    const body = getComputedStyle(document.body).backgroundColor;
    return { panel: getComputedStyle(p).backgroundColor,
             col: getComputedStyle(c).backgroundColor, body: body }; })()`);
  ok('the docked chat paints the page background, not the workspace grey',
    paint.panel === paint.body && paint.col === paint.body &&
    paint.panel !== 'rgba(0, 0, 0, 0)', JSON.stringify(paint));

  /* letter-spacing is applied to the SPACE too, so "DR." + space rendered as a double gap.
     ⚠ This used to require word-spacing to cancel letter-spacing EXACTLY, which was correct while
     the button was uppercase and letter-spaced. The button now matches the analyst and crypto ones:
     mixed case, letter-spacing normal, so there is nothing being added to the space and nothing to
     cancel. The requirement is unchanged -- the gap after "Dr." must be a plain space -- so it is
     asserted directly: either no letter-spacing at all, or a word-spacing that exactly undoes it.
     Written as a disjunction rather than deleted, because the defect returns the moment anyone
     letter-spaces this button again. */
  const spacing = await evalIn(`(() => { const b = document.querySelector('.navbtn-novo');
    const c = getComputedStyle(b);
    return { ls: c.letterSpacing, ws: c.wordSpacing }; })()`);
  const _ls = spacing.ls === 'normal' ? 0 : parseFloat(spacing.ls);
  const _ws = spacing.ws === 'normal' ? 0 : parseFloat(spacing.ws);
  ok('the space after "Dr." is not double-width',
    Math.abs(_ls + _ws) < 0.05,
    JSON.stringify(spacing) + '  (letter-spacing must be normal, or word-spacing must cancel it)');

  ok('...and the mobile tab carries the same mark and name',
    (named.mob || '').indexOf('✦') >= 0 && /DR\. NOVO/.test(named.mob || ''),
    JSON.stringify(named));

  const glow = await evalIn(`(() => { const b = document.querySelector('.navbtn-novo');
    const c = getComputedStyle(b), k = b.querySelector('.caret');
    return { color: c.color, shadow: c.boxShadow, anim: c.animationName, border: c.borderColor,
             caret: k ? getComputedStyle(k).color : null }; })()`);
  /* ⚠ GREEN MOVED, it did not leave. The label used to be green text on a bare outline; the button
     now matches the analyst and crypto chat buttons, where the label is the page's normal text
     colour and the product's accent is carried by the CARET, the BORDER and the glow. So the
     assertion follows the accent to where it lives rather than continuing to read `color` -- which
     would fail on a button that is green in every way a viewer can see. */
  ok('...and it is green', /52,\s*211,\s*153/.test(glow.caret) && /52,\s*211,\s*153/.test(glow.border),
    JSON.stringify(glow));
  /* The 2.8s breathing animation is deliberately gone: Jake asked for the three chat buttons to be
     uniform with colour as the only difference, and a pulse on one of three otherwise identical
     controls is a difference that is not colour. It still glows -- the green cast is now static in
     the box-shadow -- so that is what is asserted. Requiring the ANIMATION would be requiring the
     thing that was removed on purpose; requiring only "some shadow" would pass a plain black drop
     shadow with no green in it, so the green is named. */
  ok('...and it glows', !!glow.shadow && glow.shadow !== 'none' && /52,\s*211,\s*153/.test(glow.shadow),
    JSON.stringify(glow));

  // The panel must NOT exist before the tab is opened — mounting into a hidden column is the bug
  // that made INTRO_HTML capture an empty string.
  ok('the chat is not mounted until the tab is opened',
    await evalIn('!!document.getElementById("novo-ask")') === false);

  await evalIn('window.setView("novo")');
  await new Promise((r) => setTimeout(r, 400));

  const opened = await evalIn(`(() => {
    const col = document.getElementById('col-novo');
    const panel = document.getElementById('novo-ask');
    const log = document.getElementById('novo-ask-log');
    const rc = col && col.getBoundingClientRect(), rp = panel && panel.getBoundingClientRect();
    return {
      bodyClass: document.body.className,
      colVisible: !!(rc && rc.width > 200 && rc.height > 200),
      panelVisible: !!(rp && rp.width > 200 && rp.height > 200),
      hasIntro: !!(log && log.querySelector('.intro')),
      chartHidden: (() => { const c = document.getElementById('col-intel');
        return !c || c.getBoundingClientRect().width === 0; })(),
      navOn: !!document.querySelector('.navbtn-novo.on'),
    };
  })()`);
  ok('setView("novo") puts the page in the NoVo view', /v-novo/.test(opened.bodyClass || ''), JSON.stringify(opened));
  ok('the NoVo column is on screen with real size', opened.colVisible, JSON.stringify(opened));
  ok('the chat panel mounted and filled it', opened.panelVisible, JSON.stringify(opened));
  ok('the intro and its starter questions rendered', opened.hasIntro, JSON.stringify(opened));
  ok('it is its OWN tab - the chart view is not also showing', opened.chartHidden, JSON.stringify(opened));
  ok('the nav button shows as active', opened.navOn, JSON.stringify(opened));

  /* ⚠ THE PANEL FILLING ITS COLUMN IS NOT THE SAME AS THE COLUMN FILLING THE VIEW. First build:
     every visibility check passed and the composer still sat mid-screen with dead space under it,
     because the column was content-sized and the log had nothing to grow into. Assert where the
     input actually LANDS, not merely that it exists. */
  const fill = await evalIn(`(() => { const f = document.querySelector('#novo-ask form');
    const r = f && f.getBoundingClientRect();
    return { bottom: r && Math.round(r.bottom), vh: window.innerHeight,
             gap: r && Math.round(window.innerHeight - r.bottom) }; })()`);
  ok('the composer sits at the bottom of the view, not mid-screen',
    fill.gap !== null && fill.gap < 60, JSON.stringify(fill));

  // ⚠ The deferred init: INTRO_HTML must have been captured from the MOUNTED log, or Clear wipes
  // the panel permanently. Asserted through the behaviour, not the variable.
  const cleared = await evalIn(`(() => { window.novoAskClear();
    const l = document.getElementById('novo-ask-log');
    return { restored: !!(l && l.querySelector('.intro')) }; })()`);
  ok('Clear restores the intro (deferred init captured it from the mounted panel)',
    cleared.restored, JSON.stringify(cleared));

  // The send path, end to end, against the stub.
  const asked = await evalIn(`(async () => { await window.novoAsk('what is the flip?');
    await new Promise(r => setTimeout(r, 300));
    return { body: window.__asked,
             turns: document.querySelectorAll('#novo-ask-log .m').length }; })()`);
  ok('asking posts to /api/analyst-ask with the question and the member token',
    asked && asked.body && asked.body.question === 'what is the flip?' && !!asked.body.t,
    JSON.stringify(asked && asked.body));
  ok('...tagged as the equity surface', asked && asked.body && asked.body.surface === 'equity',
    JSON.stringify(asked && asked.body));
  ok('...and the turn rendered in the log', asked && asked.turns >= 1, JSON.stringify(asked));

  // Switching away and back must not lose the conversation.
  await evalIn('window.setView("overview")');
  await new Promise((r) => setTimeout(r, 250));
  await evalIn('window.setView("novo")');
  await new Promise((r) => setTimeout(r, 350));
  const back = await evalIn(`(() => ({ turns: document.querySelectorAll('#novo-ask-log .m').length,
    panels: document.querySelectorAll('#novo-ask').length }))()`);
  ok('leaving the tab and returning keeps the conversation', back.turns >= 1, JSON.stringify(back));
  ok('...and does not mount a second panel', back.panels === 1, JSON.stringify(back));

  // ── MOBILE ─────────────────────────────────────────────────────────────────────────────────
  await load(430);
  ok('mobile: the RUN action button is gone',
    await evalIn('!!document.querySelector(".mob-tab-run")') === false);
  const mt = await evalIn(`(() => { const b = document.querySelector('.mob-tab-novo');
    const c = b && getComputedStyle(b);
    return { present: !!b, tab: b && b.dataset.tab, label: b && b.textContent.trim().slice(-4),
             color: c && c.color }; })()`);
  ok('mobile: a NOVO tab is in its place, as a real tab', mt.present && mt.tab === '4', JSON.stringify(mt));
  ok('mobile: it is green', /52,\s*211,\s*153/.test(mt.color || ''), JSON.stringify(mt));

  await evalIn('switchMobileTab(4)');
  await new Promise((r) => setTimeout(r, 400));
  const mob = await evalIn(`(() => {
    const col = document.getElementById('col-novo'), p = document.getElementById('novo-ask');
    const rc = col && col.getBoundingClientRect(), rp = p && p.getBoundingClientRect();
    return { colVisible: !!(rc && rc.width > 200 && rc.height > 200),
             panelVisible: !!(rp && rp.width > 200 && rp.height > 200),
             active: !!document.querySelector('.mob-tab-novo.mob-active'),
             mtab: document.body.getAttribute('data-mtab'),
             chartHidden: (() => { const c = document.getElementById('col-intel');
               return !c || c.getBoundingClientRect().width === 0; })() }; })()`);
  ok('mobile: the NOVO tab opens the chat', mob.colVisible && mob.panelVisible, JSON.stringify(mob));
  ok('mobile: the tab marks itself active', mob.active && mob.mtab === '4', JSON.stringify(mob));
  ok('mobile: it is its own tab, the chart is not also showing', mob.chartHidden, JSON.stringify(mob));

  /* The same fill check as desktop. It was desktop-only at first, and the phone shipped with the
     composer floating mid-screen while every desktop check was green — a layout assertion that
     runs at one width answers for one width. */
  /* ⚠ TWO-SIDED, AND THE FIRST VERSION WAS NOT. It asserted `gap < 60` where
     gap = innerHeight - barHeight - form.bottom, which is NEGATIVE when the composer is hidden
     BEHIND the fixed tab bar — so it passed at gap -52, with the input covered and 12px showing.
     A one-sided bound on a signed quantity cannot fail in the direction that matters. */
  const mfill = await evalIn(`(() => { const f = document.querySelector('#novo-ask form');
    const bar = document.getElementById('mobile-tabs');
    const r = f && f.getBoundingClientRect(), b = bar && bar.getBoundingClientRect();
    return { formBottom: r && Math.round(r.bottom), barTop: b && Math.round(b.top),
             overlap: (r && b) ? Math.round(r.bottom - b.top) : null,
             gapAbove: (r && b) ? Math.round(b.top - r.bottom) : null }; })()`);
  ok('mobile: the composer is NOT hidden behind the fixed tab bar',
    mfill.overlap !== null && mfill.overlap <= 2, JSON.stringify(mfill));
  /* The install prompt is fixed bottom-right and landed on the Ask button, which no bounding-box
     check would have caught — both elements are "visible", they just occupy the same pixels. */
  const clash = await evalIn(`(() => { const b = document.getElementById('novoInstall');
    const g = document.querySelector('#novo-ask .go');
    if (!b || !g) return { noPrompt: !b, noGo: !g, overlap: false };
    const r = b.getBoundingClientRect(), q = g.getBoundingClientRect();
    const vis = getComputedStyle(b).display !== 'none';
    return { vis, overlap: vis && !(r.right < q.left || r.left > q.right || r.bottom < q.top || r.top > q.bottom) }; })()`);
  ok('mobile: the install prompt does not cover the Ask button',
    clash && clash.overlap === false, JSON.stringify(clash));

  ok('mobile: ...and it sits just above it rather than mid-screen',
    mfill.gapAbove !== null && mfill.gapAbove >= -2 && mfill.gapAbove < 60, JSON.stringify(mfill));

  // Nothing threw anywhere along the way.
  const errs = await evalIn('window.__pageErrors');
  ok('the error recorder is actually installed', Array.isArray(errs), JSON.stringify(errs));
  ok('no uncaught page errors were recorded', Array.isArray(errs) && errs.length === 0, JSON.stringify(errs));

  /* SHOT=1 writes PNGs. A box model can report a panel "visible with real size" while the result
     still reads badly — the numbers say it is there, only a picture says it looks right. */
  if (process.env.SHOT) {
    const out = process.env.SHOT_DIR || os.tmpdir();
    let png = (await send('Page.captureScreenshot', { format: 'png' }, sid)).result;
    fs.writeFileSync(path.join(out, 'novo-tab-mobile.png'), Buffer.from(png.data, 'base64'));
    await load(1600);
    await evalIn('window.setView("novo")');
    await new Promise((r) => setTimeout(r, 700));
    png = (await send('Page.captureScreenshot', { format: 'png' }, sid)).result;
    fs.writeFileSync(path.join(out, 'novo-tab-desktop.png'), Buffer.from(png.data, 'base64'));
    console.log('  .. shots -> ' + out);
  }

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  ws.close(); proc.kill(); try { SERVER.close(); } catch (_) {}
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); proc.kill(); try { SERVER && SERVER.close(); } catch (_) {} process.exit(2); });
