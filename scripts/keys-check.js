#!/usr/bin/env node
/* keys-check — the keyboard layer, driven by real key events in a real browser.

   WHY A BROWSER AND NOT A STUB. Every claim worth making about this feature is a claim about event
   ORDER: that the palette's Cmd-K reaches the page before the chat panel's old handler, that Escape
   is consumed in the capture phase before trader-live's unconditional "cancel everything" runs, that
   a `g` chord's second key never reaches the chart's timeframe bindings, that typing "1" into the
   palette does not switch the timeframe behind it. A DOM stub is a re-implementation of exactly the
   thing under test — it would pass while the product broke. So: a static server over public/, headless
   Chrome, Input.dispatchKeyEvent, and assertions read back out of the live DOM.

   The pages fetch live APIs that are not running here. That is deliberate and load-bearing: a
   keyboard layer that only works once the feed arrives is broken, and this proves the keys work on a
   cold page with every request failing.

   RUN:  node scripts/keys-check.js
         node scripts/keys-check.js --sabotage      (proves the assertions can fail)
   Exit 0 = every check passed. Exit 1 = a check failed, with the reason. */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..', 'public');
const SABOTAGE = process.argv.includes('--sabotage');
const PORT = 8731;
const CDP_PORT = 9333;

/* THE MUST-FAIL PROOFS.

   The first attempt at this injected a competing listener into the finished page and expected the
   suite to fail. It did not — because capture-phase consumption genuinely prevents a later listener
   from ever seeing the key, which is the entire mechanism under test. The sabotage was wrong, not
   the code, and a sabotage that cannot reproduce the bug proves nothing about the check.

   So these mutate the SOURCE as it is served: one edit, one broken behaviour, and a named check that
   must go red. `at` is asserted to actually match before the run — a sabotage that silently fails to
   apply is a green run that means nothing. */
const SABOTAGES = [
  { name: 'capture-off', page: 'trader',
    file: '/js/novo-keys.js',
    at: "document.addEventListener('keydown', onKey, true);",
    to: "document.addEventListener('keydown', onKey, false);",
    breaks: 'trader: a missed chord key does not fall through to the chart',
    why: 'in the bubble phase the chart handler, registered first, runs before the chord can swallow the key' },

  { name: 'no-stand-down', page: 'trader',
    file: '/js/novo-keys.js',
    at: "function traderSheet() { return typeof window._kbHelpToggle === 'function'; }",
    to: "function traderSheet() { return false; }",
    breaks: 'trader: the shared sheet stands down',
    why: 'without the detection both help panels open on one press of ?' },

  { name: 'no-typing-guard', page: 'store',
    file: '/js/novo-keys.js',
    at: "return !!(el && el.closest && el.closest('input,textarea,select,[contenteditable=\"true\"]'));",
    to: "return false;",
    breaks: 'store: a chord started inside a text field is ignored',
    why: 'typing the letter g into the search box arms a navigation chord' },

  { name: 'no-dynamic-commands', page: 'crypto',
    file: '/js/novo-keys.js',
    at: "if (typeof c === 'function') {",
    to: "if (false) {",
    breaks: 'crypto: the palette finds a coin by name',
    why: 'coins are registered as a function because the rail does not exist at boot; drop the ' +
         'function form and every data-driven command disappears' },

  { name: 'no-focus', page: 'store',
    file: '/js/novo-keys.js',
    at: "    render('');\n    input.focus();",
    to: "    render('');",
    breaks: 'store: the palette takes focus',
    why: 'a palette that opens without the caret in it makes the user reach for the mouse' },

  { name: 'stale-kbd-hint', page: 'analyst',
    file: '/analyst-live.html',
    at: ' Ask about this tape&hellip; <kbd aria-hidden="true">N</kbd></button>',
    to: ' Ask about this tape&hellip; <kbd aria-hidden="true">&#8984;K</kbd></button>',
    breaks: 'analyst: the bubble teaches the key it actually uses',
    why: 'the badge would name a chord that now opens something else entirely' }
];
let MUTATE = null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

// ── the static server ───────────────────────────────────────────────────────────────────────────
function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not served in keys-check"}');
        return;
      }
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      if (MUTATE && p === MUTATE.file) {
        const src = fs.readFileSync(file, 'utf8');
        if (src.indexOf(MUTATE.at) < 0) {
          // A sabotage that does not apply produces a green run that means nothing.
          console.error(`SABOTAGE "${MUTATE.name}" does not match ${MUTATE.file} — anchor not found.`);
          process.exit(1);
        }
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(src.replace(MUTATE.at, MUTATE.to));
        return;
      }
      res.writeHead(200, { 'content-type': type });
      fs.createReadStream(file).pipe(res);
    });
    // 127.0.0.1 only. Never a public bind for a local check.
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  });
}

// ── CDP ─────────────────────────────────────────────────────────────────────────────────────────
function findChrome() {
  const c = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('no Chromium browser found — keys-check needs Chrome or Edge');
}

async function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.session = null;
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pend.has(msg.id)) {
        const { resolve, reject } = this.pend.get(msg.id);
        this.pend.delete(msg.id);
        msg.error ? reject(new Error(msg.method + ': ' + msg.error.message)) : resolve(msg.result);
      }
    };
  }
  send(method, params) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (this.session) payload.sessionId = this.session;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pend.set(id, { resolve, reject });
      setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); reject(new Error('timeout: ' + method)); } }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval threw: ' + (r.exceptionDetails.exception || {}).description);
    return r.result.value;
  }
}

const VK = { Escape: 27, ArrowDown: 40, ArrowUp: 38, Enter: 13, Tab: 9 };
function codeFor(k) {
  if (/^[a-z]$/i.test(k)) return 'Key' + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return 'Digit' + k;
  if (k === '/') return 'Slash';
  if (k === '?') return 'Slash';
  return k;
}

async function press(cdp, key, mods) {
  mods = mods || 0;
  const printable = key.length === 1 && !(mods & 2) && !(mods & 4);
  const base = {
    key, code: codeFor(key), modifiers: mods,
    windowsVirtualKeyCode: VK[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
  };
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: printable ? 'keyDown' : 'rawKeyDown', text: printable ? key : undefined }, base));
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  await new Promise((r) => setTimeout(r, 60));
}
const CTRL = 2, SHIFT = 8;

// ── assertions ──────────────────────────────────────────────────────────────────────────────────
let pass = 0;
const fails = [];
function check(name, got, want, why) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; return; }
  fails.push(`${name}\n      expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}\n      ${why}`);
}

async function load(cdp, url) {
  await cdp.send('Page.navigate', { url });
  // Wait for the deferred layer to have installed itself rather than sleeping a guessed interval.
  const t0 = Date.now();
  for (;;) {
    try {
      const ready = await cdp.eval('!!(window.NovoKeys) && document.readyState === "complete"');
      if (ready) break;
    } catch (_e) { /* mid-navigation */ }
    if (Date.now() - t0 > 15000) throw new Error('NovoKeys never installed on ' + url);
    await new Promise((r) => setTimeout(r, 120));
  }
  await new Promise((r) => setTimeout(r, 250));
}

// ── the suite ───────────────────────────────────────────────────────────────────────────────────
const SECTIONS = {};

SECTIONS.store = async function (cdp, base) {
  await load(cdp, base + '/index.html');

  await press(cdp, 'k', CTRL);
  check('store: Cmd-K opens the palette',
    await cdp.eval('!!document.querySelector("#nvk.on")'), true,
    'the palette is the whole feature; if this fails nothing else matters');
  check('store: the palette takes focus',
    await cdp.eval('document.activeElement && document.activeElement.id'), 'nvk-q',
    'a palette that opens without the caret in it makes the user click, which defeats the point');

  await press(cdp, 'p'); await press(cdp, 'l'); await press(cdp, 'a');
  const first = await cdp.eval('(document.querySelector("#nvk-list li .l")||{}).textContent||""');
  check('store: typing filters to a matching command',
    /plan|pricing/i.test(first), true,
    `typing "pla" ranked "${first}" first — the scorer is not finding the Plans link`);

  await press(cdp, 'ArrowDown');
  check('store: ArrowDown moves the selection',
    await cdp.eval('(document.querySelector("#nvk-list li[aria-selected=\\"true\\"]")||{}).id'), 'nvk-o1',
    'arrow keys are the only way to reach anything but the top hit');

  await press(cdp, 'Escape');
  check('store: Escape closes the palette',
    await cdp.eval('!!document.querySelector("#nvk.on")'), false,
    'Escape is the universal dismiss; without it the palette traps the user');

  await press(cdp, '/');
  check('store: "/" focuses the site search box',
    await cdp.eval('document.activeElement && document.activeElement.id'), 'site-search-input',
    '"/" is the search convention every big desk uses');

  await press(cdp, 'g');
  check('store: a chord started inside a text field is ignored',
    await cdp.eval('!!document.querySelector("#nvk-chip.on")'), false,
    'THE TYPING GUARD. Typing the letter g into the search box must never arm a navigation chord');

  await cdp.eval('document.activeElement.blur()');
  await press(cdp, 'g');
  check('store: "g" arms the chord and shows the hint',
    await cdp.eval('!!document.querySelector("#nvk-chip.on")'), true,
    'a chord with no visible hint reads as a dead key');

  await press(cdp, 'a');
  await new Promise((r) => setTimeout(r, 600));
  check('store: "g a" navigates to the Analyst page',
    await cdp.eval('location.pathname'), '/analyst',
    'the go-to chords are the second half of the feature');

  /* index.html is one page out of 1,435. The layer reaches the other 1,426 by riding site-search.js,
     which is the only script tag they all share — so the claim "throughout the entire store" rests
     on a journal article and a coin page behaving like the home page, not on the home page alone. */
  for (const [url, what] of [['/journal/0dte-scalping.html', 'a journal article'],
                             ['/crypto/btc.html', 'a coin page']]) {
    await load(cdp, base + url);
    await press(cdp, 'k', CTRL);
    check(`store: the palette reaches ${what}`,
      await cdp.eval('!!document.querySelector("#nvk.on")'), true,
      `${url} carries no tag of its own; if this fails the layer covers 8 pages, not 1,435`);
    await press(cdp, 'Escape');
  }
};

SECTIONS.crypto = async function (cdp, base) {
  await load(cdp, base + '/crypto-live.html');

  await press(cdp, 'k', CTRL);
  check('crypto: Cmd-K opens the palette',
    await cdp.eval('!!document.querySelector("#nvk.on")'), true,
    'the palette must win the chord it was reassigned');
  check('crypto: Cmd-K no longer opens the chat panel',
    await cdp.eval('!!document.querySelector("#novo-ask.on")'), false,
    'THE MIGRATION. Both listeners sit on document and neither stops the other by default, so ' +
    'without capture-phase consumption one press opens the palette AND toggles the chat');
  await press(cdp, 'Escape');

  await press(cdp, 'n');
  check('crypto: "n" opens NoVo',
    await cdp.eval('!!document.querySelector("#novo-ask.on")'), true,
    'n is where Cmd-K went; if it does not work the chat lost its shortcut entirely');
  await press(cdp, 'Escape');

  // The rail is fed by an API that is not running here, so mount two rows and prove the palette
  // both FINDS a coin and routes the choice through the rail row's own click handler.
  await cdp.eval(`(function(){
    var r = document.getElementById('rail') || document.body;
    var d = document.createElement('div');
    d.className = 'coin'; d.setAttribute('data-c','SOLTEST');
    d.onclick = function(){ window.__picked = 'SOLTEST'; };
    r.appendChild(d);
    return 1;
  })()`);
  await press(cdp, 'k', CTRL);
  for (const ch of 'soltest') await press(cdp, ch);
  check('crypto: the palette finds a coin by name',
    await cdp.eval('(document.querySelector("#nvk-list li .l")||{}).textContent||""'), 'SOLTEST',
    'ninety coins sorted by open interest with no A-Z index is the reason this feature exists');
  await press(cdp, 'Enter');
  check('crypto: choosing a coin clicks the rail row, not a reimplementation',
    await cdp.eval('window.__picked||null'), 'SOLTEST',
    'the row handler carries the full reset (TOK/FEED/SCREEN/BOOK, remember, close rail); ' +
    'setting CUR directly would skip all of it');
};

SECTIONS.trader = async function (cdp, base) {
  await load(cdp, base + '/trader-live.html');

  await press(cdp, '?', SHIFT);
  check('trader: "?" opens the chart\'s own sheet',
    await cdp.eval('!!document.querySelector("#kbd-help.open")'), true,
    'the chart sheet lives inside #novo-chart so it survives fullscreen; it stays the owner of ?');
  check('trader: the shared sheet stands down',
    await cdp.eval('!!document.querySelector("#nvk-sheet.on")'), false,
    'TWO HELP PANELS ON ONE KEYPRESS. novo-keys must detect _kbHelpToggle and not bind ?');
  check('trader: the chart sheet teaches the new keys too',
    await cdp.eval('/Command palette/.test((document.getElementById("kbd-help")||{}).innerHTML||"")'), true,
    'a sheet that lists only half the map is worse than no sheet');
  await press(cdp, 'Escape');

  const tf0 = await cdp.eval('(document.querySelector("#ctb-tf .ctb-btn.on")||{}).dataset ? document.querySelector("#ctb-tf .ctb-btn.on").dataset.tf : null');
  await press(cdp, 'k', CTRL);
  check('trader: Cmd-K opens the palette',
    await cdp.eval('!!document.querySelector("#nvk.on")'), true,
    'Cmd-K was free on this page; the palette should simply take it');
  await press(cdp, '4');
  const tf1 = await cdp.eval('(document.querySelector("#ctb-tf .ctb-btn.on")||{}).dataset ? document.querySelector("#ctb-tf .ctb-btn.on").dataset.tf : null');
  check('trader: typing a digit into the palette does not switch the timeframe',
    tf1, tf0,
    'THE GUARD THAT HAD NEVER FIRED. trader-live has no other text field, so the palette input is ' +
    'the first thing its typing guard ever sees; if it misses, every query rewrites the chart');
  await press(cdp, 'Escape');

  const tf2 = await cdp.eval('(document.querySelector("#ctb-tf .ctb-btn.on")||{}).dataset ? document.querySelector("#ctb-tf .ctb-btn.on").dataset.tf : null');
  await press(cdp, 'g');
  await press(cdp, '4');
  const tf3 = await cdp.eval('(document.querySelector("#ctb-tf .ctb-btn.on")||{}).dataset ? document.querySelector("#ctb-tf .ctb-btn.on").dataset.tf : null');
  check('trader: a missed chord key does not fall through to the chart',
    tf3, tf2,
    'CHORD SWALLOW. "g" then "4" must not switch the timeframe — the second key of a chord is ' +
    'consumed in capture, or every mistyped chord edits the chart');

  await press(cdp, '2');
  const tf4 = await cdp.eval('(document.querySelector("#ctb-tf .ctb-btn.on")||{}).dataset ? document.querySelector("#ctb-tf .ctb-btn.on").dataset.tf : null');
  check('trader: the chart keys still work with nothing open',
    tf4, '5',
    'REGRESSION GUARD. The whole point of extending rather than replacing is that Tony\'s ' +
    'twenty bindings keep working; if this fails the feature broke the chart');
};

SECTIONS.analyst = async function (cdp, base) {
  await load(cdp, base + '/analyst-live.html');
  await press(cdp, 'k', CTRL);
  check('analyst: Cmd-K opens the palette, not the chat',
    await cdp.eval('[!!document.querySelector("#nvk.on"), !!document.querySelector("#novo-ask.on")]'),
    [true, false],
    'same migration as crypto — the two files are byte-identical forks and drift silently');
  await press(cdp, 'Escape');
  await press(cdp, 'n');
  check('analyst: "n" opens NoVo',
    await cdp.eval('!!document.querySelector("#novo-ask.on")'), true,
    'n is the advertised replacement, and the bubble now prints it');
  check('analyst: the bubble teaches the key it actually uses',
    await cdp.eval('((document.querySelector("#novo-ask-bubble kbd")||{}).textContent||"").trim()'), 'N',
    'the badge said ⌘K and was rewritten per-platform; a badge naming a dead chord is a lie ' +
    'the product tells on every page load');
};

async function run(cdp, base, only) {
  for (const name of (only ? [only] : Object.keys(SECTIONS))) await SECTIONS[name](cdp, base);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const server = await serve();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvk-'));
  const chrome = spawn(findChrome(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp, code = 0;
  try {
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      try { ver = await getJSON(`http://127.0.0.1:${CDP_PORT}/json/version`); }
      catch (_e) { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!ver) throw new Error('browser never opened its debugging port');

    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp connect failed')); });
    cdp = new CDP(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.session = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const base = `http://127.0.0.1:${PORT}`;

    if (!SABOTAGE) {
      await run(cdp, base);
    } else {
      /* Each mutation must turn its NAMED check red. A sabotage that leaves everything green means
         the check does not test what it claims; a sabotage that reddens a different check means the
         mechanism is not the one described. Both are reported as failures of the SUITE. */
      const bad = [];
      for (const s of SABOTAGES) {
        MUTATE = s;
        pass = 0; fails.length = 0;
        await run(cdp, base, s.page);
        const hit = fails.some((f) => f.startsWith(s.breaks));
        console.log(`  ${hit ? 'x' : '!'} ${s.name.padEnd(20)} ${hit ? 'broke' : 'DID NOT BREAK'} "${s.breaks}"`);
        if (!hit) bad.push(`${s.name}: expected "${s.breaks}" to fail — ${s.why}`);
        else if (fails.length > 1) {
          console.log(`      (also red: ${fails.filter((f) => !f.startsWith(s.breaks))
            .map((f) => f.split('\n')[0]).join('; ')})`);
        }
      }
      MUTATE = null;
      fails.length = 0;
      if (bad.length) { bad.forEach((b) => fails.push('SABOTAGE ' + b)); }
      else console.log(`\nsabotage: all ${SABOTAGES.length} mutations reddened their own check`);
    }
  } catch (e) {
    fails.push('HARNESS: ' + e.message + '\n      ' + (e.stack || '').split('\n')[1]);
  } finally {
    try { chrome.kill(); } catch (_e) {}
    server.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
  }

  if (fails.length) {
    console.error(`\nkeys-check: ${fails.length} FAILED${SABOTAGE ? '' : `, ${pass} passed`}\n`);
    for (const f of fails) console.error('  X ' + f + '\n');
    code = 1;
  } else {
    console.log(SABOTAGE ? 'keys-check --sabotage: PASS' : `keys-check: ${pass}/${pass} passed`);
  }
  process.exit(code);
})();
