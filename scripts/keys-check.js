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
    at: "    render(input.value);\n    input.focus();",
    to: "    render(input.value);",
    breaks: 'store: the palette takes focus',
    why: 'a palette that opens without the caret in it makes the user reach for the mouse' },

  { name: 'no-mode-derive', page: 'store',
    file: '/js/novo-keys.js',
    at: "if (s.charAt(0) !== '/') return { mode: 'search'",
    to: "if (true) return { mode: 'search'",
    breaks: 'store: "/" opens the palette in command mode',
    why: 'the mode is derived from the leading slash; force search mode and the second door is gone' },

  { name: 'no-tab-complete', page: 'store',
    file: '/js/novo-keys.js',
    at: "if (k === 'Tab') { complete(); e.preventDefault();",
    to: "if (k === 'Tab') { e.preventDefault();",
    breaks: 'store: Tab completes a unique command token',
    why: 'restores the old unconditional Tab swallow, which is what the footer now advertises against' },

  { name: 'no-badges', page: 'store',
    file: '/site-search.js',
    at: "'<div class=\"nvs-ss-keys\" aria-hidden=\"true\">' +",
    to: "'<div class=\"nvs-ss-keys-off\" aria-hidden=\"true\">' +",
    breaks: 'store: the header box advertises both chords',
    why: 'without the badges the whole layer is invisible again — this is the discoverability fix itself' },

  /* THE ONE THAT REPRODUCES THE PREDICTED DEFECT — and it needs TWO edits, which is itself the
     finding. The undismissable-palette loop the recon predicted requires both halves: the box
     opening on FOCUS, and close() RESTORING focus to whatever opened it. Ship either guard alone
     and there is no loop, so a single mutation leaves the suite green and proves nothing. Removing
     both reproduces it exactly: Escape -> close -> refocus the box -> focus fires -> re-open. */
  { name: 'box-focus-loop', page: 'store',
    edits: [
      { file: '/site-search.js',
        at: "input.addEventListener('mousedown', function (e) {",
        to: "input.addEventListener('focus', function (e) {" },
      { file: '/js/novo-keys.js',
        at: "if (!boxOpened && lastFocus && lastFocus.focus)",
        to: "if (lastFocus && lastFocus.focus)" }
    ],
    breaks: 'store: Escape out of a box-opened palette does not re-open it',
    why: 'focus-bound opening plus focus-restore-on-close makes the palette undismissable' },

  { name: 'coin-from-rail', page: 'crypto',
    file: '/crypto-live.html',
    at: "try { if (SNAP && SNAP.coins) names = Object.keys(SNAP.coins); } catch (_e) { names = []; }",
    to: "try { names = []; } catch (_e) { names = []; }",
    breaks: 'crypto: the coin domain comes from the feed, not the filtered rail',
    why: 'falls back to enumerating mounted rail rows, which the rail filter can silently shrink' },

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
      // A sabotage may carry several edits, across several files: some defects are only reachable
      // when two guards are removed together, and a single-edit model would leave those checks
      // unproven while looking proven.
      const edits = MUTATE ? (MUTATE.edits || [{ file: MUTATE.file, at: MUTATE.at, to: MUTATE.to }])
                           : [];
      const mine = edits.filter((ed) => ed.file === p);
      if (mine.length) {
        let src = fs.readFileSync(file, 'utf8');
        for (const ed of mine) {
          if (src.indexOf(ed.at) < 0) {
            // A sabotage that does not apply produces a green run that means nothing.
            console.error(`SABOTAGE "${MUTATE.name}" does not match ${ed.file} — anchor not found.`);
            process.exit(1);
          }
          src = src.replace(ed.at, ed.to);
        }
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(src);
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

  // ---- the header badges: the reason anyone discovers any of this ------------------------------
  check('store: the header box advertises both chords',
    await cdp.eval(`(function(){
      var k=document.querySelector('.nvs-ss-keys'); if(!k) return 'missing';
      return Array.from(k.querySelectorAll('kbd')).map(function(x){return x.textContent;}).join('|');
    })()`),
    'Ctrl K|/',
    'THE DISCOVERABILITY FIX. Without the badges the palette is invisible and nobody opens it. ' +
    'Ctrl on this headless Linux/Windows profile; the mac glyph is chosen off navigator.platform');

  check('store: the placeholder does not run under the badges',
    await cdp.eval(`(function(){
      var i=document.getElementById('site-search-input'), k=document.querySelector('.nvs-ss-keys');
      if(!i||!k) return 'missing';
      var cs=getComputedStyle(i);
      var c=document.createElement('canvas').getContext('2d');
      c.font=cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily;
      var room=i.getBoundingClientRect().width-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight)
               -k.getBoundingClientRect().width-12;
      return c.measureText(i.placeholder).width <= room;
    })()`),
    true,
    'THE MEASUREMENT. The badges steal room the placeholder was already sized against, so the two ' +
    'are chosen together — a constant would over-reserve on one font family and clip on the other');

  /* ---- the box is the door, and Escape out of it must not loop --------------------------------
     A REAL browser click, not a synthetic MouseEvent. This is the difference between a check that
     discriminates and one that cannot: a dispatched DOM event does not move focus, so against a
     focus-bound implementation the palette would simply never open and "not open" would pass as
     "no loop". Input.dispatchMouseEvent goes through the browser's own input path and focuses the
     field exactly as a person would, which is what makes the loop reproducible at all. */
  const box = await cdp.eval(`(function(){
    var r=document.getElementById('site-search-input').getBoundingClientRect();
    return {x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)};
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent',
      { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await new Promise((r) => setTimeout(r, 250));
  const opened = await cdp.eval('!!document.querySelector("#nvk.on")');
  check('store: clicking the header box opens the palette',
    opened, true,
    'the UW shape: the visible field is the door, so there is ONE search surface over the one index');

  await press(cdp, 'Escape');
  await new Promise((r) => setTimeout(r, 400));
  // Asserted as a PAIR so "it never opened" can never masquerade as "it closed cleanly".
  check('store: Escape out of a box-opened palette does not re-open it',
    [opened, await cdp.eval('!!document.querySelector("#nvk.on")')], [true, false],
    'THE FOCUS LOOP. close() restores focus to whatever opened it, so binding the box to focus ' +
    'rather than mousedown re-opens the palette forever. Checked 400ms later, because a loop ' +
    'needs a tick to show, and paired with the open so a no-op cannot pass for a clean close');

  // ---- the two modes -------------------------------------------------------------------------
  await press(cdp, '/');
  check('store: "/" opens the palette in command mode',
    await cdp.eval('[!!document.querySelector("#nvk.on"), document.getElementById("nvk-q").value, (document.querySelector("#nvk-scope b")||{}).textContent]'),
    [true, '/', 'Commands'],
    '"/" is the second door into the one panel; the scope chip must say which mode it opened in');

  check('store: command mode lists only tokened commands',
    await cdp.eval('Array.from(document.querySelectorAll("#nvk-list li")).every(li=>!!li.querySelector(".tok"))'), true,
    'command mode that leaks prose rows is just search with a slash in the box');

  // Tab completion. `/g` is unique to /go, so Tab must complete it; nothing else may change.
  await press(cdp, 'g');
  await press(cdp, 'Tab');
  check('store: Tab completes a unique command token',
    await cdp.eval('document.getElementById("nvk-q").value'), '/go ',
    'THE TAB CONTRACT. Tab was previously swallowed with "nothing behind it to reach"; completing ' +
    'the token is the useful meaning and the footer now advertises it');

  await cdp.eval('var q=document.getElementById("nvk-q"); q.value="/"; q.dispatchEvent(new Event("input",{bubbles:true}));');
  await press(cdp, 'Tab');
  check('store: Tab with no unique match leaves the query alone',
    await cdp.eval('document.getElementById("nvk-q").value'), '/',
    'a Tab that rewrites your query to something you did not choose is worse than a Tab that does nothing');

  // Clearing the slash must drop back to search, or the chip and the results disagree.
  await cdp.eval('var q=document.getElementById("nvk-q"); q.value=""; q.dispatchEvent(new Event("input",{bubbles:true}));');
  check('store: clearing the slash returns to search mode',
    await cdp.eval('(document.querySelector("#nvk-scope b")||{}).textContent'), 'Global',
    'the mode is DERIVED from the text so the chip cannot drift from what is actually being matched');

  await press(cdp, 'Escape');

  /* THE TYPING GUARD, tested against a real text field that is NOT the palette. Testing it with the
     caret in #nvk-q proves nothing: the palette's own isOpen() early-return would swallow the key
     before the guard was ever consulted, so the check would pass green while testing nothing. The
     store's chat widget input is a genuine field on all 1,431 chrome pages. */
  await cdp.eval('(document.querySelector(".nvc-btn")||{click(){}}).click()');
  await new Promise((r) => setTimeout(r, 250));
  await cdp.eval('var t=document.querySelector(".nvc-in"); if(t) t.focus();');
  check('store: a real text field is focused for the guard test',
    await cdp.eval('!!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("nvc-in"))'),
    true,
    'if this fails the guard check below is testing nothing — the setup, asserted rather than assumed');

  await press(cdp, 'g');
  check('store: a chord started inside a text field is ignored',
    await cdp.eval('!!document.querySelector("#nvk-chip.on")'), false,
    'THE TYPING GUARD. Typing the letter g into a chat box must never arm a navigation chord');

  await press(cdp, 'Escape');
  await cdp.eval('if(document.activeElement && document.activeElement.blur) document.activeElement.blur();');
  await press(cdp, 'g');
  check('store: "g" arms the chord and shows the hint',
    await cdp.eval('!!document.querySelector("#nvk-chip.on")'), true,
    'a chord with no visible hint reads as a dead key');

  await press(cdp, 'a');
  await new Promise((r) => setTimeout(r, 600));
  check('store: "g a" navigates to the Analyst page',
    await cdp.eval('location.pathname'), '/analyst',
    'the go-to chords are the second half of the feature');

  /* index.html is one page. The layer reaches the rest by riding site-search.js, the only script tag
     they all share — so "throughout the store" rests on a journal article and a coin page behaving
     like the home page, not on the home page alone.

     THE HONEST COVERAGE NUMBER is 1,427 of 1,435 static files, and 1,427 of 1,510 published URLs.
     The eight files without it are 404, the three live dashboards (which carry their own tag),
     embed-pulse, subscribe-success, subscriber and success. The other 83 URLs are the
     server-rendered read archive, which is built from api/_lib/site-chrome.js — and that build
     strips external script tags, so the archive has no keyboard layer, no header search box and no
     chat widget at all. Any copy that says "every page" is wrong on 83 of them. */
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

  /* THE COIN DOMAIN MUST COME FROM SNAP.coins, NOT THE MOUNTED RAIL. Enumerating rows meant the
     rail's own filter silently shrank the palette's coin list — the palette agreeing with the
     filter instead of overriding it, which is backwards.

     Discriminating setup: put a coin in SNAP that has NO rail row at all. If the palette lists it,
     the domain is SNAP.coins. If it does not, the domain is still the DOM. Simulating the filter
     instead would prove nothing here — drawRail throws before it touches innerHTML when SNAP is
     null, so the row would survive the filter and the check would pass without discriminating. */
  const snapOk = await cdp.eval(`(function(){
    try { SNAP = { coins: { GHOSTCOIN: { band: 'A' } } }; return typeof SNAP === 'object'; }
    catch (e) { return 'unassignable: ' + e.message; }
  })()`);
  check('crypto: the harness can seed SNAP (setup, asserted not assumed)',
    snapOk, true,
    'SNAP is a script-global let; if this fails the domain check below is not testing what it claims');

  await press(cdp, 'k', CTRL);
  for (const ch of 'ghost') await press(cdp, ch);
  check('crypto: the coin domain comes from the feed, not the filtered rail',
    await cdp.eval('Array.from(document.querySelectorAll("#nvk-list li .l")).map(function(n){return n.textContent;}).indexOf("GHOSTCOIN") > -1'),
    true,
    'GHOSTCOIN exists only in SNAP.coins and has no rail row, so listing it proves the enumeration ' +
    'reads the unfiltered feed set rather than whatever the rail happens to have mounted');
  await press(cdp, 'Escape');
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
        if (!hit) {
          // Say what DID go red. A sabotage that reddens a different check than the one it names is
          // a different failure from one that reddens nothing, and the fix differs.
          const others = fails.map((f) => f.split('\n')[0]);
          console.log(`      red instead: ${others.length ? others.join('; ') : '(nothing — the mutation had no effect)'}`);
          bad.push(`${s.name}: expected "${s.breaks}" to fail — ${s.why}`);
        }
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
