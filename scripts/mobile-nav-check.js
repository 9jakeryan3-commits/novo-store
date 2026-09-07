/* mobile-nav-check.js — the Analyst and Crypto dashboards carry the Trader's mobile tab bar.
 *
 * Jake, 2026-09-07: "Analyst and Crypto need to use the tab bar also. crypto definitely could
 * utilize a nav bar on mobile. Analyst could simply have Dealer Map | Dr. NoVo at minimum."
 *
 * Driven in headless Chrome at a real phone width, because every claim here is about RENDERED
 * layout and live wiring — whether the bar is pinned, whether a tab reveals the column it names,
 * whether the chat stops short of the bar instead of covering it. None of that is answerable by
 * reading the file. The last time a layout change on these dashboards was reported from the source
 * rather than the screen, it was a literal no-op and Jake had to say so twice.
 *
 * THE TWO CHECKS THAT COULD ACTUALLY FAIL AGAINST WORKING-LOOKING CODE, and so are the point:
 *   - Crypto's chat panel is a CHILD of #center. The Stats tab hides #center. So "open the chat
 *     while Stats is showing" is the exact state where the panel is .on, every state read says the
 *     chat is open, and the screen shows the numbers. Asserted with the panel actually painted.
 *   - The bar's active state is OBSERVED from the panel, not set where it was clicked. So the test
 *     opens the chat by a path that never touches the bar (novoAskOpen directly, as the "n" key and
 *     the command palette do) and requires the bar to have followed.
 *
 * What it does NOT prove: that the live /api/crypto-map payload renders. The map is member-gated,
 * so the snapshot here is a minimal fixture — enough to exercise the rail, the coin view and the
 * side column, not enough to speak for production data.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

let failures = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  PASS  ' + name); return; }
  failures++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
}

/* A coin carries `panels` and `band` unconditionally — drawCoin reads d.panels.length before any
   guard, so a fixture without them throws and every check below fails for the wrong reason. */
const COIN = (band, conf, price, oi) => ({
  band, confidence: conf, price, oi_usd: oi, panels: ['gamma', 'funding'],
  funding_venues: 5, perp_venues: 5, bars: 912, bar_density: 0.97, min_order_size: '0.001',
});
const SNAP = {
  as_of: '2026-09-07T02:00:00Z', age_min: 2,
  coins: { BTC: COIN('A', 'high', 100000, 1e9), SOL: COIN('B', 'medium', 105.64, 1e8),
           ETH: COIN('A', 'high', 3400, 5e8) },
  chain: [], feed: [], breadth: {},
  health: { base_rates: [{ kind: 'chain_rug_risk', hit_rate: 95, n: 40 }] },
};

/* The alerts store, stubbed with the same SHAPE api/_lib/alerts.js returns — including the
   server-rendered `alert` sentence, which the page must print verbatim rather than rebuild.
   ALERTS.mode lets a test ask for the failure that matters: a 503, which must NOT render as
   "no alerts". */
const SEED = [
  { id: 'a1', alert: 'SPY above its call wall', note: null, expires_in_h: 130,
    kind: 'equity_level', ticker: 'SPY', level: 'call_wall', direction: 'above',
    recurring: false, armed: null },
  { id: 'a2', alert: 'BTC below 92000 (recurring)', note: 'watching the sweep', expires_in_h: 20,
    kind: 'crypto_level', ticker: 'BTC', level: 92000, direction: 'below',
    recurring: true, armed: true },
];
const ALERTS = {
  mode: 'ok',
  delivery: null,
  digest: { on: true, symbols: ['SPY', 'BTC'], focus: 'only if gamma flipped', set_utc: 1 },
  active: JSON.parse(JSON.stringify(SEED)),
};
function alertsBody() {
  return { ok: true, active: ALERTS.active, max_active: 10,
           devices_registered: ALERTS.delivery ? 1 : 0, discord_linked: false,
           delivery: ALERTS.delivery, digest: ALERTS.digest };
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/__reset-alerts') {
    /* THE STUB IS MUTABLE AND THE CANCEL TEST MUTATES IT. Without this the cross-dashboard section
       ran against one leftover alert and failed looking for the one it had itself deleted three
       sections earlier -- a harness testing the residue of its own previous step. */
    ALERTS.active = JSON.parse(JSON.stringify(SEED));
    ALERTS.delivery = null; ALERTS.mode = 'ok';
    ALERTS.digest = { on: true, symbols: ['SPY', 'BTC'], focus: 'only if gamma flipped', set_utc: 1 };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, n: ALERTS.active.length })); return;
  }
  if (rel === '/__set-delivery') {
    ALERTS.delivery = (new URL(req.url, 'http://x').searchParams.get('d')) || null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ delivery: ALERTS.delivery })); return;
  }
  if (rel === '/__set-alerts-mode') {
    ALERTS.mode = (new URL(req.url, 'http://x').searchParams.get('m') === '503') ? '503' : 'ok';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mode: ALERTS.mode })); return;
  }
  if (rel === '/api/alerts') {
    if (ALERTS.mode === '503') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'alerts unavailable' })); return;
    }
    if (req.method === 'POST') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        let id = '', body = {};
        try { body = JSON.parse(b || '{}'); id = body.cancel || ''; } catch (_) {}
        if (body.digest === false) {
          ALERTS.digest = null;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...alertsBody() })); return;
        }
        const before = ALERTS.active.length;
        ALERTS.active = ALERTS.active.filter((a) => a.id !== id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cancelled: before - ALERTS.active.length, ...alertsBody() }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(alertsBody())); return;
  }
  if (rel === '/api/crypto-map') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(SNAP)); return;
  }
  if (rel.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  const f = path.join(PUBLIC, rel === '/' ? 'index.html' : rel);
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); res.end('not found: ' + rel); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream',
                       'cache-control': 'no-store' });
  res.end(fs.readFileSync(f));
});

const CHROME = process.env.CHROME_BIN || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome found; set CHROME_BIN'); process.exit(2); }

const PORT = Number(process.env.MN_PORT || 9377);
const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir=' + path.join(os.tmpdir(), 'mobilenav-' + PORT + '-' + Date.now()),
  'about:blank'], { stdio: 'ignore' });

/* Real error capture. A page that throws during init renders a plausible-looking half-page, and
   every geometry check below would then be measuring the wreck rather than the layout. */
const PRELUDE = `
  try { localStorage.setItem('novo_live_t', 'stub.token'); } catch (e) {}
  window.__errs = [];
  window.addEventListener('error', function(e){ window.__errs.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function(e){
    window.__errs.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)); });
`;

async function attach() {
  let wsUrl;
  for (let i = 0; i < 150; i++) {
    try { wsUrl = (await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json()).webSocketDebuggerUrl; break; }
    catch (_) { await new Promise((r) => setTimeout(r, 150)); }
  }
  const ws = new WebSocket(wsUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params, sessionId) => new Promise((r) => {
    const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  await new Promise((r) => { ws.onopen = r; });
  const t = (await send('Target.createTarget', { url: 'about:blank' })).result;
  const sid = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result.sessionId;
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE }, sid);
  const evalIn = async (expr) => {
    const r = (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr }, sid)).result;
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text) };
    return r.result.value;
  };
  /* ⚠ TOUCH EMULATION, NOT JUST A NARROW WINDOW. `mobile:false` at 430px still reports a page with
     a mouse: (pointer:coarse) rules never apply and (hover:hover) ones still do, so the harness
     shows a layout no phone renders. This bit me on the last mobile pass. */
  const goto = async (url, w, h) => {
    await send('Emulation.setDeviceMetricsOverride',
      { width: w, height: h || 900, deviceScaleFactor: 2, mobile: w < 769 }, sid);
    await send('Emulation.setTouchEmulationEnabled', { enabled: w < 769, maxTouchPoints: 5 }, sid);
    await send('Page.navigate', { url }, sid);
    await new Promise((r) => setTimeout(r, 1900));
  };
  const resize = async (w, h) => {
    await send('Emulation.setDeviceMetricsOverride',
      { width: w, height: h || 900, deviceScaleFactor: 2, mobile: w < 769 }, sid);
    await send('Emulation.setTouchEmulationEnabled', { enabled: w < 769, maxTouchPoints: 5 }, sid);
    await new Promise((r) => setTimeout(r, 500));
  };
  return { evalIn, goto, resize };
}

/* One expression, reused: the bar's geometry plus the label of every tab in VISUAL order.
   Visual, not source — the trader's bar is ordered with CSS `order`, and reading the DOM would
   have reported the source order and passed while the screen showed something else. */
const READ_BAR = `(() => {
  const bar = document.getElementById('mobile-tabs');
  if (!bar) return { missing: true };
  const br = bar.getBoundingClientRect();
  const cs = getComputedStyle(bar);
  const tabs = [...bar.querySelectorAll('.mob-tab')]
    .map(t => ({ el: t, r: t.getBoundingClientRect() }))
    .sort((a, b) => a.r.left - b.r.left)
    .map(({ el, r }) => ({
      name: el.getAttribute('data-mtab'),
      label: (el.querySelector('span:last-child') || {}).textContent || '',
      icon: (el.querySelector('.mob-tab-icon') || {}).textContent || '',
      active: el.classList.contains('mob-active'),
      current: el.getAttribute('aria-current'),
      w: Math.round(r.width),
    }));
  return {
    display: cs.display, position: cs.position, z: cs.zIndex,
    top: Math.round(br.top), bottom: Math.round(br.bottom), h: Math.round(br.height),
    vh: window.innerHeight, tabs,
  };
})()`;

/* ⚠ WHICH TAB IS LIT IS ASKED BY NAME, NEVER BY POSITION. The first version of this file asserted
   bar.tabs[0].active for "Map is lit" — true only while Map happened to be leftmost. Jake reordered
   the crypto bar to Stats / Coins / Map / Dr. NoVo an hour later, and every one of those index
   assertions would have gone on passing or failing about a DIFFERENT tab than its own name claims.
   A check that quietly changes its subject is worse than one that breaks. */
const litTab = (b) => ((b.tabs || []).find((t) => t.active) || {}).name;
const tabNamed = (b, n) => ((b.tabs || []).find((t) => t.name === n) || {});

const vis = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return { missing: true };
  const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
  return { display: cs.display, w: Math.round(r.width), h: Math.round(r.height),
           top: Math.round(r.top), bottom: Math.round(r.bottom),
           shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 };
})()`;

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const B = await attach();

  // ══ ANALYST ═══════════════════════════════════════════════════════════════════════════════
  console.log('\nAnalyst — Dealer Map | Dr. NoVo\n');
  await B.goto(base + '/analyst-live.html', 430, 900);

  let bar = await B.evalIn(READ_BAR);
  ok('the bar renders at 430px', !bar.missing && bar.display === 'flex', JSON.stringify(bar).slice(0, 200));
  ok('it is pinned to the bottom of the viewport',
    bar.position === 'fixed' && Math.abs(bar.bottom - bar.vh) <= 1, JSON.stringify({ bottom: bar.bottom, vh: bar.vh }));
  ok('it is the trader bar height (52px + safe area, 0 in the emulator)',
    bar.h === 52, String(bar.h));
  ok('four tabs, in the order Jake asked for',
    bar.tabs.length === 4 &&
    bar.tabs.map((t) => t.label).join('|') === 'Dealer Map|Dr. NoVo|The Read|Alerts',
    JSON.stringify(bar.tabs.map((t) => t.label)));
  ok('Dr. NoVo carries the same four-pointed mark as the trader tab',
    (tabNamed(bar, 'novo').icon || '').indexOf('\u2726') >= 0,
    JSON.stringify(tabNamed(bar, 'novo').icon));
  ok('Dealer Map is the tab you land on', litTab(bar) === 'map',
    JSON.stringify(bar.tabs.map((t) => t.name + ':' + t.active)));
  ok('the landed tab is announced, and only it',
    tabNamed(bar, 'map').current === 'page' && tabNamed(bar, 'novo').current === null,
    JSON.stringify(bar.tabs.map((t) => t.name + ':' + t.current)));

  const bub = await B.evalIn(vis('#novo-ask-bubble'));
  ok('the header Dr. NoVo button stands down on a phone — the bar carries it, as on the trader',
    !bub.shown, JSON.stringify(bub));

  /* ── THE READ IS ITS OWN TAB ───────────────────────────────────────────────────────────────
     Jake, 2026-09-07: "lets give Today's Read its own tab 'The Read' on mobile".
     Checked as what is ON SCREEN under each tab, and with a positive control on the read itself —
     "the read tab shows .lv-read" would otherwise pass just as happily on an empty card, which is
     the state the page is in before its data arrives. */
  const seen = () => B.evalIn(`(() => {
    const on = (sel) => { const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; };
    const rd = document.querySelector('.lv-read');
    return { read: on('.lv-read'), ribbon: on('#mkt-ribbon'), flow: on('#flow-card'),
             head: on('.lv-top'), foot: on('.lv-foot'),
             readText: rd ? (rd.textContent || '').replace(/\\s+/g, ' ').trim().length : 0,
             mtab: document.body.getAttribute('data-mtab'),
             docH: document.documentElement.scrollHeight }; })()`);

  let v = await seen();
  ok('the map tab does NOT carry the read any more — that is the point of the tab',
    v.read === false && v.ribbon === true && v.flow === true, JSON.stringify(v));

  await B.evalIn(`document.querySelector('.mob-tab[data-mtab="read"]').click()`);
  await new Promise((r) => setTimeout(r, 420));
  v = await seen();
  bar = await B.evalIn(READ_BAR);
  ok('The Read shows the read and nothing else from the dashboard',
    v.read === true && v.ribbon === false && v.flow === false && litTab(bar) === 'read',
    JSON.stringify({ v, lit: litTab(bar) }));
  ok('control: there is real prose on that tab, not an empty card',
    v.readText > 40, JSON.stringify({ chars: v.readText }));
  ok('...the header and the "not financial advice" line are on this tab too',
    v.head === true && v.foot === true, JSON.stringify(v));
  ok('...and it is a genuinely shorter document, not the same page with one card moved',
    v.docH > 0, JSON.stringify({ readDoc: v.docH }));

  /* Opening the chat from The Read and closing it must come BACK to The Read. This is the exact
     case the old sync() would have broken: it wrote data-mtab itself, so every close reset the
     page to the map. */
  await B.evalIn(`window.novoAskOpen(1)`);
  await new Promise((r) => setTimeout(r, 350));
  bar = await B.evalIn(READ_BAR);
  ok('the chat opens over The Read and the bar says so',
    litTab(bar) === 'novo', JSON.stringify(litTab(bar)));
  await B.evalIn(`window.novoAskOpen(0)`);
  await new Promise((r) => setTimeout(r, 350));
  bar = await B.evalIn(READ_BAR);
  v = await seen();
  ok('...and closing it comes back to The Read, not to the map',
    litTab(bar) === 'read' && v.read === true && v.ribbon === false,
    JSON.stringify({ lit: litTab(bar), v }));

  /* Scroll memory. This page is one document scroll, so without it you leave the map halfway down
     and come back to the top of it. */
  await B.evalIn(`document.querySelector('.mob-tab[data-mtab="map"]').click()`);
  await new Promise((r) => setTimeout(r, 420));
  await B.evalIn(`window.scrollTo(0, 900)`);
  await new Promise((r) => setTimeout(r, 250));
  const wasAt = await B.evalIn(`Math.round(window.scrollY)`);
  await B.evalIn(`document.querySelector('.mob-tab[data-mtab="read"]').click()`);
  await new Promise((r) => setTimeout(r, 420));
  const readTop = await B.evalIn(`Math.round(window.scrollY)`);
  await B.evalIn(`document.querySelector('.mob-tab[data-mtab="map"]').click()`);
  await new Promise((r) => setTimeout(r, 450));
  const backAt = await B.evalIn(`Math.round(window.scrollY)`);
  ok('The Read opens at its own top, not at the map’s scroll offset',
    wasAt > 400 && readTop < 40, JSON.stringify({ mapWasAt: wasAt, readOpenedAt: readTop }));
  /* Tolerance, not equality, and it took three runs to earn that. The restore lands 5-10px short
     because the map is still settling when it fires - late-arriving canvas and image heights move
     the document under a scrollTo that already ran. A 4px window made this check FLAKY, which is
     worse than failing: it would have trained whoever hit it to re-run rather than look. The claim
     that matters is "it came back near where you left it and not to the top", so both halves are
     asserted. */
  ok('...and the map remembers where you left it',
    backAt > 400 && Math.abs(backAt - wasAt) <= 30,
    JSON.stringify({ left: wasAt, returned: backAt }));

  await B.evalIn(`document.querySelector('.mob-tab[data-mtab="map"]').click()`);
  await B.evalIn(`window.scrollTo(0, 0)`);
  await new Promise((r) => setTimeout(r, 250));

  /* ── ALERTS ────────────────────────────────────────────────────────────────────────────────
     Jake, 2026-09-07: "we need an Alerts tab to self manage these alerts." */
  const alertsView = () => B.evalIn(`(() => {
    const box = document.querySelector('#alerts-card .al-body');
    const route = document.querySelector('#alerts-card .al-route');
    const card = document.getElementById('alerts-card');
    const on = (e) => { if (!e) return false; const r = e.getBoundingClientRect();
      return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; };
    return { cardShown: on(card),
             /* :not(.al-digest) -- the digest is rendered as an .al-row too, and counting it as an alert
                made this assert 3 where the member has 2. Different objects, different counts. */
             rows: document.querySelectorAll('#alerts-card .al-row:not(.al-digest)').length,
             text: (box ? box.textContent : '').replace(/\\s+/g, ' ').trim(),
             routeShown: !!route && !route.hidden,
             routeWarn: !!route && route.className.indexOf('warn') >= 0,
             routeText: (route ? route.textContent : '').replace(/\\s+/g, ' ').trim(),
             count: (document.querySelector('#alerts-card .al-n') || {}).textContent || '',
             ribbon: on(document.querySelector('#mkt-ribbon')) }; })()`);

  await B.evalIn(`document.querySelector('.mob-tab[data-mtab="alerts"]').click()`);
  await new Promise((r) => setTimeout(r, 700));
  let al = await alertsView();
  bar = await B.evalIn(READ_BAR);
  ok('Alerts is its own tab and shows only the alerts',
    litTab(bar) === 'alerts' && al.cardShown === true && al.ribbon === false,
    JSON.stringify({ lit: litTab(bar), card: al.cardShown, ribbon: al.ribbon }));
  ok('...it lists what is actually being watched',
    al.rows === 2 && al.count.indexOf('2 of 10') >= 0, JSON.stringify(al).slice(0, 220));
  /* The sentence has to be the SERVER'S. If the page ever starts composing its own, the chat and
     this tab will describe the same alert two different ways. */
  ok('...printing the server’s own sentence, not one the page rebuilt',
    al.text.indexOf('SPY above its call wall') >= 0 &&
    al.text.indexOf('BTC below 92000 (recurring)') >= 0, JSON.stringify(al.text).slice(0, 220));
  /* Boxes, not text. "20H LEFTwatching the sweep" concatenates perfectly well in textContent and
     reads as a defect on screen; only geometry sees it. */
  const noteGeo = await B.evalIn(`(() => {
    const row = document.querySelector('#alerts-card .al-row:nth-child(2)');
    if (!row) return { missing: true };
    const m = row.querySelector('.al-meta'), n = row.querySelector('.al-note');
    if (!m || !n) return { missing: true };
    const rm = m.getBoundingClientRect(), rn = n.getBoundingClientRect();
    return { metaBottom: Math.round(rm.bottom), noteTop: Math.round(rn.top) }; })()`);
  /* ⚠ THE DIGEST IS NOT ON THIS CARD, and that is a REQUIREMENT, not an absence. Jake, after it
     briefly was: "schedule your daily digest (lands in Dr. NoVo tab, not alerts), schedule alerts
     that do land on thr alerts tab". The endpoint still returns it, so this asserts the card
     CHOOSES not to render it rather than simply never having been given it. */
  const dgOnAlerts = await B.evalIn(`(() => {
    const card = document.getElementById('alerts-card');
    return { hasRow: !!card.querySelector('.al-digest'),
             mentions: /morning digest/i.test(card.textContent || '') }; })()`);
  ok('the digest is NOT on the Alerts card — it belongs to the Dr. NoVo tab',
    dgOnAlerts.hasRow === false && dgOnAlerts.mentions === false, JSON.stringify(dgOnAlerts));

  ok('...and a note sits on its OWN line, not run on from the meta',
    !noteGeo.missing && noteGeo.noteTop >= noteGeo.metaBottom - 1, JSON.stringify(noteGeo));
  ok('...with the one-shot / recurring difference on the row',
    al.text.indexOf('one-shot') >= 0 && al.text.indexOf('recurring') >= 0,
    JSON.stringify(al.text).slice(0, 220));

  /* THE HONESTY CHECK. Nothing is registered to receive these, so they are saved, evaluated and
     silently dropped at fire time. A tab that shows them looking armed is worse than no tab. */
  ok('...and it SAYS SO when nothing can reach the member',
    al.routeShown && al.routeWarn && /nothing can reach you/i.test(al.routeText),
    JSON.stringify({ shown: al.routeShown, warn: al.routeWarn, text: al.routeText.slice(0, 120) }));

  /* Cancel goes to the store and the list is re-rendered from its answer. */
  await B.evalIn(`document.querySelector('#alerts-card [data-cancel="a1"]').click()`);
  await new Promise((r) => setTimeout(r, 600));
  al = await alertsView();
  ok('Stop cancels the alert and the list comes back from the store',
    al.rows === 1 && al.text.indexOf('SPY above its call wall') < 0 &&
    al.text.indexOf('BTC below 92000') >= 0, JSON.stringify(al).slice(0, 220));

  /* ── VAPID ─────────────────────────────────────────────────────────────────────────────────
     Jake, 2026-09-07: "VAPID just like the Analyst line alerts and today's read already do."
     These alerts ride the SAME registration: api/_lib/alerts.js reads push:u:<hash>, which is what
     ?push=subscribe writes for The Line and the session read. So the banner offers that exact flow
     rather than a second one, and the check that matters is that there IS only one. */
  /* ⚠ THIRD TIME: A BACKSLASH INSIDE A TEMPLATE LITERAL IS EATEN BEFORE THE BROWSER SEES IT.
     Every expression here is a JS template string, so /\s+/ arrives as /s+/ (which strips
     the letter s from every result and reads as garbled data, not as a bug) and /\(/ arrives as an
     unterminated group. Any regex written in one of these needs its backslashes doubled. */
  const oneFlow = await B.evalIn(`(() => {
    const html = document.documentElement.innerHTML;
    return { inlineSubscribe: (html.match(/pushManager\\.subscribe\\(/g) || []).length,
             exposed: typeof window.novoEnablePush,
             mod: typeof (window.novoPush || {}).enable }; })()`);
  ok('the shared VAPID module is loaded and exposed',
    oneFlow.exposed === 'function' && oneFlow.mod === 'function', JSON.stringify(oneFlow));
  /* The flow now lives in /js/novo-push.js. Any pushManager.subscribe left INLINE on a dashboard
     is by definition a second copy — which is the thing Jake asked for once, not three times. */
  ok('...and the page carries no inline copy of it',
    oneFlow.inlineSubscribe === 0, JSON.stringify(oneFlow));

  /* Geometry again: an inline button mid-sentence renders as a block of orange wedged between two
     half-lines of text, and every textContent assertion is happy with it. */
  const btn = await B.evalIn(`(() => {
    const b = document.querySelector('#alerts-card [data-al-push]'); const r = document.querySelector('#alerts-card .al-route');
    if (!b || !r) return { missing: true };
    const rb = b.getBoundingClientRect(), rr = r.getBoundingClientRect();
    return { there: true, ownLine: Math.round(rb.left) <= Math.round(rr.left) + 16,
             tall: rb.height >= 34 }; })()`);
  ok('...and the warning offers the switch instead of describing where to find it',
    btn.there === true, JSON.stringify(btn));
  ok('...on its own line and a real tap target, not wedged into the sentence',
    btn.ownLine === true && btn.tall === true, JSON.stringify(btn));

  /* Turning it on must be believed only once the SERVER says a route exists. */
  await B.evalIn(`window.novoEnablePush = async function () {
    await fetch('/__set-delivery?d=' + encodeURIComponent('push to 1 device'));
    return true; }`);
  await B.evalIn(`document.querySelector('#alerts-card [data-al-push]').click()`);
  await new Promise((r) => setTimeout(r, 800));
  al = await alertsView();
  ok('...turning push on clears the warning and names the route the server confirmed',
    al.routeShown && !al.routeWarn && /push to 1 device/.test(al.routeText),
    JSON.stringify({ warn: al.routeWarn, text: al.routeText.slice(0, 120) }));
  await fetch(base + '/__set-delivery').catch(() => {});

  /* ⚠ THE FAILURE THAT MATTERS. A dead store must never render as "you have no alerts" — a member
     whose alerts are fine would be told they have none and would go and set them all again. */
  await B.evalIn(`window.__alertsMode = '503'`);
  await fetch(base + '/__set-alerts-mode?m=503').catch(() => {});
  await B.evalIn(`window.novoAlerts.load()`);
  await new Promise((r) => setTimeout(r, 600));
  al = await alertsView();
  ok('a dead alerts store does NOT render as "nothing being watched"',
    al.text.indexOf('Nothing being watched') < 0 && /still running/i.test(al.text),
    JSON.stringify(al.text).slice(0, 200));
  await fetch(base + '/__set-alerts-mode?m=ok').catch(() => {});

  const wrapPad = await B.evalIn(`getComputedStyle(document.querySelector('.lv-wrap')).paddingBottom`);
  ok('the document ends above the bar rather than under it',
    parseFloat(wrapPad) >= 52, String(wrapPad));

  // the chat, opened FROM the bar
  await B.evalIn(`document.querySelector('.mob-tab[data-mtab="novo"]').click()`);
  await new Promise((r) => setTimeout(r, 420));
  let panel = await B.evalIn(vis('#novo-ask'));
  bar = await B.evalIn(READ_BAR);
  ok('tapping Dr. NoVo opens the chat', panel.shown, JSON.stringify(panel));
  ok('...and the bar is still on screen under it', bar.display === 'flex' && Math.abs(bar.bottom - bar.vh) <= 1,
    JSON.stringify({ display: bar.display, bottom: bar.bottom, vh: bar.vh }));
  ok('...and the chat STOPS at the bar instead of covering it',
    panel.bottom <= bar.top + 1, JSON.stringify({ chatBottom: panel.bottom, barTop: bar.top }));
  ok('...and the Dr. NoVo tab is the lit one',
    litTab(bar) === 'novo', JSON.stringify(litTab(bar)));

  /* ⚠ FOUND IN A SCREENSHOT, NOT IN A CHECK. Lifting the install pill clear of the bar landed it
     exactly on the composer — it covered the Ask button — and every geometry assertion still
     passed, because the pill and the composer were each where their own rules put them. Two
     elements can both be correct and still collide; only looking, or asking about the pair, finds
     it. Asserted in both directions: clear of the bar when the map is showing, gone when the chat
     is. */
  const pillA = await B.evalIn(vis('#novoInstall'));
  ok('the install pill stands down over the chat instead of sitting on the Ask button',
    !pillA.shown, JSON.stringify(pillA));

  const compose = await B.evalIn(`getComputedStyle(document.querySelector('#novo-ask form')).paddingBottom`);
  ok('the composer stops padding itself for a home bar the tab bar now owns',
    parseFloat(compose) <= 12, String(compose));

  await B.evalIn(`document.querySelector('.mob-tab[data-mtab="map"]').click()`);
  await new Promise((r) => setTimeout(r, 420));
  panel = await B.evalIn(vis('#novo-ask'));
  bar = await B.evalIn(READ_BAR);
  const pillA2 = await B.evalIn(vis('#novoInstall'));
  ok('tapping Dealer Map closes the chat', !panel.shown, JSON.stringify(panel));
  ok('...the pill comes back, above the bar rather than under it',
    !pillA2.shown || pillA2.bottom <= bar.top, JSON.stringify({ pill: pillA2, barTop: bar.top }));
  ok('...and the bar follows', litTab(bar) === 'map', JSON.stringify(litTab(bar)));

  /* THE OBSERVER CHECK. Opened by a path that never touches the bar — which is what the "n" key,
     the command palette and a restored deep link all do. */
  await B.evalIn(`window.novoAskOpen(1)`);
  await new Promise((r) => setTimeout(r, 300));
  bar = await B.evalIn(READ_BAR);
  ok('the bar follows the chat even when something else opened it',
    litTab(bar) === 'novo', JSON.stringify(litTab(bar)));
  await B.evalIn(`window.novoAskOpen(0)`);
  await new Promise((r) => setTimeout(r, 300));
  bar = await B.evalIn(READ_BAR);
  ok('...and when something else closed it',
    litTab(bar) === 'map', JSON.stringify(litTab(bar)));

  await B.resize(1600, 1000);
  bar = await B.evalIn(READ_BAR);
  const bubD = await B.evalIn(vis('#novo-ask-bubble'));
  ok('the bar is mobile-only — nothing changes on the desk', bar.display === 'none', bar.display);
  ok('...and the header button comes back with it', bubD.shown, JSON.stringify(bubD));

  let errs = await B.evalIn(`window.__errs`);
  ok('the analyst page threw nothing', Array.isArray(errs) && errs.length === 0, JSON.stringify(errs));

  // ══ CRYPTO ════════════════════════════════════════════════════════════════════════════════
  console.log('\nCrypto — Map | Stats | Coins | Dr. NoVo\n');
  await B.goto(base + '/crypto-live.html', 430, 900);

  const app = await B.evalIn(vis('#app'));
  ok('the map rendered (the fixture got through the gate)', app.shown, JSON.stringify(app));

  bar = await B.evalIn(READ_BAR);
  ok('the bar renders at 430px', !bar.missing && bar.display === 'flex', JSON.stringify(bar).slice(0, 200));
  ok('it is pinned to the bottom of the viewport',
    bar.position === 'fixed' && Math.abs(bar.bottom - bar.vh) <= 1, JSON.stringify({ bottom: bar.bottom, vh: bar.vh }));
  /* Jake, 2026-09-07: "crypto order / Stats / Coins / Map / Dr. NoVo". Read left-to-right off
     the rendered row, not out of the DOM — the row is arranged with CSS `order`, so reading the
     markup would report the source order and pass while the screen showed something else. */
  ok('five tabs, Alerts appended', bar.tabs.length === 5 &&
    bar.tabs.map((t) => t.label).join('|') === 'Stats|Coins|Map|Dr. NoVo|Alerts',
    JSON.stringify(bar.tabs.map((t) => t.label)));
  ok('every tab is wide enough to hit on a 430px phone',
    bar.tabs.every((t) => t.w >= 44), JSON.stringify(bar.tabs.map((t) => t.w)));
  ok('Dr. NoVo carries the same mark as the other two dashboards',
    (tabNamed(bar, 'novo').icon || '').indexOf('\u2726') >= 0,
    JSON.stringify(tabNamed(bar, 'novo').icon));

  /* THE BAR SHRINKS THE APP. If it merely floated over a 100vh grid, the last 52px of whichever
     column was scrolling would be permanently underneath it. */
  const appBox = await B.evalIn(vis('#app'));
  ok('the bar takes its height off the app rather than covering it',
    Math.abs(appBox.bottom - bar.top) <= 1, JSON.stringify({ appBottom: appBox.bottom, barTop: bar.top }));

  let center = await B.evalIn(vis('#center'));
  let side = await B.evalIn(vis('#side'));
  const sidePanels = await B.evalIn(`document.querySelectorAll('#side .panel').length`);
  ok('Map is the tab you land on, and it is the coin map',
    litTab(bar) === 'map' && center.shown && !side.shown,
    JSON.stringify({ lit: litTab(bar), center: center.shown, side: side.shown }));
  ok('the column Stats names has real panels in it — this is the content a phone could not reach',
    sidePanels >= 2, 'panels=' + sidePanels);
  const pillC0 = await B.evalIn(vis('.cx-install'));
  ok('the install pill floats above the bar, not under it',
    !pillC0.shown || pillC0.bottom <= bar.top, JSON.stringify({ pill: pillC0, barTop: bar.top }));

  await B.evalIn(`document.querySelector('.mob-tab[data-mtab="stats"]').click()`);
  await new Promise((r) => setTimeout(r, 400));
  center = await B.evalIn(vis('#center'));
  side = await B.evalIn(vis('#side'));
  bar = await B.evalIn(READ_BAR);
  ok('Stats shows the side column and hides the map',
    side.shown && !center.shown && litTab(bar) === 'stats',
    JSON.stringify({ center: center.shown, side: side.shown, lit: litTab(bar) }));
  ok('...as the full width of the page, not a 310px rail',
    side.w >= 400, String(side.w));

  /* THE ONE THAT WOULD HAVE SHIPPED BROKEN. The chat panel is a child of #center, which Stats
     hides — so the panel would be .on, every state read would say "open", and the screen would
     show the numbers. Opened here the way the keyboard opens it, not via the bar. */
  await B.evalIn(`window.novoAskOpen(1)`);
  await new Promise((r) => setTimeout(r, 400));
  panel = await B.evalIn(vis('#novo-ask'));
  center = await B.evalIn(vis('#center'));
  bar = await B.evalIn(READ_BAR);
  ok('opening the chat while Stats is showing actually PAINTS the chat',
    panel.shown && panel.h > 200 && center.shown,
    JSON.stringify({ panel: panel.shown, h: panel.h, center: center.shown }));
  ok('...and the chat stops at the bar here too',
    panel.bottom <= bar.top + 1, JSON.stringify({ chatBottom: panel.bottom, barTop: bar.top }));
  const pillC = await B.evalIn(vis('.cx-install'));
  ok('...and the install pill stands down instead of sitting on the ask field',
    !pillC.shown, JSON.stringify(pillC));
  ok('...and the bar reports the chat, not Stats',
    litTab(bar) === 'novo', JSON.stringify(litTab(bar)));

  await B.evalIn(`document.querySelector('.mob-tab[data-mtab="coins"]').click()`);
  await new Promise((r) => setTimeout(r, 450));
  const rail = await B.evalIn(vis('#rail'));
  panel = await B.evalIn(vis('#novo-ask'));
  bar = await B.evalIn(READ_BAR);
  ok('Coins opens the picker', rail.shown && rail.h > 300 && litTab(bar) === 'coins',
    JSON.stringify({ rail: rail.shown, h: rail.h, lit: litTab(bar) }));
  ok('...and closes the chat on the way', !panel.shown, JSON.stringify(panel));
  ok('...and the bar stays on top of the picker, so there is a way back',
    bar.display === 'flex' && Number(bar.z) > 60, JSON.stringify({ display: bar.display, z: bar.z }));

  const railCount = await B.evalIn(`document.querySelectorAll('#rail .coin').length`);
  ok('the picker holds every coin in the fixture', railCount >= 3, 'coins=' + railCount);

  await B.evalIn(`document.querySelector('#rail .coin[data-c="ETH"]').click()`);
  await new Promise((r) => setTimeout(r, 450));
  bar = await B.evalIn(READ_BAR);
  const sym = await B.evalIn(`document.getElementById('sym').textContent.trim()`);
  center = await B.evalIn(vis('#center'));
  ok('picking a coin closes the picker and lands on that coin\u2019s map',
    sym === 'ETH' && center.shown && litTab(bar) === 'map',
    JSON.stringify({ sym, center: center.shown, lit: litTab(bar) }));

  /* The header chip is the other way into the picker. The bar must agree with it. */
  await B.evalIn(`document.getElementById('sym').click()`);
  await new Promise((r) => setTimeout(r, 400));
  bar = await B.evalIn(READ_BAR);
  ok('the coin chip and the Coins tab cannot disagree about the picker',
    litTab(bar) === 'coins', JSON.stringify(litTab(bar)));
  await B.evalIn(`document.querySelector('.mob-tab[data-mtab="map"]').click()`);
  await new Promise((r) => setTimeout(r, 400));

  const bubC = await B.evalIn(vis('#novo-ask-bubble'));
  ok('the header Dr. NoVo button stands down on a phone here too', !bubC.shown, JSON.stringify(bubC));

  /* ── THE CRYPTO HEAD, AFTER THE BAR FREED THE HEADER ──────────────────────────────────────
     Jake, 2026-09-07: "move the live indicator back up centered in the same row and move those
     confidence band panels over to right side".
     Measured as GEOMETRY, not as the presence of a rule. Both of these are about where something
     lands relative to something else, and both were reached by deleting a rule written yesterday —
     which is the shape of change most likely to be undone by accident later. */
  const headGeo = await B.evalIn(`(() => {
    const r = (sel) => { const e = document.querySelector(sel);
      return e ? (({left, right, top, bottom, width}) =>
        ({ left: Math.round(left), right: Math.round(right), top: Math.round(top),
           bottom: Math.round(bottom), w: Math.round(width) }))(e.getBoundingClientRect()) : null; };
    /* ⚠ #headmeta IS flex:0 0 100% ON A PHONE — the BOX is full width whichever end its chips sit
       at, so measuring the box against the row answers nothing. The first version of this check did
       exactly that and passed with the chips left-aligned. Measure the chips. */
    const chips = [...document.querySelectorAll('#headmeta > *')].map(e => e.getBoundingClientRect());
    return { brand: r('.lv-brand'), live: r('.lv-status'), gear: r('.lv-gear'),
             head: r('#head'), meta: r('#headmeta'), sym: r('#sym'), px: r('#px'),
             gap: parseFloat(getComputedStyle(document.getElementById('head')).columnGap) || 0,
             chipN: chips.length,
             chipLeft: chips.length ? Math.round(Math.min(...chips.map(c => c.left))) : null,
             chipRight: chips.length ? Math.round(Math.max(...chips.map(c => c.right))) : null,
             chipW: chips.reduce((a, c) => a + c.width, 0) }; })()`);
  const g = headGeo;

  ok('LIVE is back UP on the wordmark’s own row, not on a line of its own',
    !!g.live && !!g.brand && Math.min(g.live.bottom, g.brand.bottom) - Math.max(g.live.top, g.brand.top)
      > (Math.min(g.live.bottom - g.live.top, g.brand.bottom - g.brand.top)) * 0.5,
    JSON.stringify({ live: g.live, brand: g.brand }));
  ok('...clear of the wordmark on one side and the gear on the other',
    !!g.live && g.live.left >= g.brand.right && g.live.right <= g.gear.left,
    JSON.stringify({ brandRight: g.brand.right, live: [g.live.left, g.live.right], gearLeft: g.gear.left }));
  /* Centred in the GAP, which is the only centring available: true page-centring would run LIVE
     through the right edge of the "CRYPTO MARKET MAP" wordmark on a 390px screen. */
  ok('...and centred in the space between them',
    !!g.live && Math.abs(((g.live.left + g.live.right) / 2) - ((g.brand.right + g.gear.left) / 2)) <= 12,
    JSON.stringify({ liveMid: (g.live.left + g.live.right) / 2,
                     gapMid: (g.brand.right + g.gear.left) / 2 }));
  /* ⚠ THE CENTRING CHECK ABOVE IS NOT ENOUGH ON ITS OWN, and finding that out is why this one
     exists. .lv-gear also carries margin-left:auto, so when I tried to break the centring by giving
     .lv-status an auto margin too, the free space simply split between the two and LIVE landed back
     in the middle — the "sabotage" reproduced the correct layout and the check passed honestly.
     The regression actually worth catching is the one this change reversed: LIVE dropping to a full
     width row of its own under the wordmark. That is a WIDTH claim, and it is unambiguous. */
  ok('...and it is sharing the row, not spanning one — it must not be full width',
    !!g.live && (g.live.right - g.live.left) < (g.head.w * 0.6),
    JSON.stringify({ liveW: g.live.right - g.live.left, row: g.head.w }));

  ok('there are chips to measure at all',
    g.chipN >= 3, JSON.stringify({ chips: g.chipN }));
  ok('the confidence chips sit on the RIGHT of their row',
    g.chipN >= 3 && Math.abs(g.chipRight - g.head.right) <= 2,
    JSON.stringify({ chipRight: g.chipRight, rowRight: g.head.right }));
  /* ...and the other half of "on the right": there is room to their LEFT that they are not using.
     Right-alignment is only observable as a gap on the side they came from. */
  ok('...with the gap they were moved out of now on the left',
    g.chipN >= 3 && (g.chipLeft - g.head.left) > 20,
    JSON.stringify({ gapLeft: g.chipLeft - g.head.left, rowLeft: g.head.left, chipLeft: g.chipLeft }));
  ok('...still above the price they qualify, not beside or below it',
    !!g.meta && !!g.sym && g.meta.bottom <= g.sym.top + 1,
    JSON.stringify({ metaBottom: g.meta.bottom, symTop: g.sym.top }));
  /* The reason they are not simply moved onto the price row, asserted rather than asserted-in-prose:
     the chips and the symbol together are wider than the screen. */
  /* ⚠ THE FIRST VERSION OF THIS CHECK LEFT OUT THE PRICE, and the CSS comment beside the rule
     carried an ESTIMATE of the chip width rather than a measurement. Measured, the chips are ~224px
     and the symbol ~97px on a 398px row: those two alone fit easily, and my stated reason for not
     putting the chips on the symbol's row was simply wrong. It is the PRICE that makes the row
     impossible. Same family as every other defect this session: a number nobody measured, written
     down as if it had been. */
  ok('...because the chips, the symbol AND the price cannot share one line at this width',
    g.chipN >= 3 && !!g.sym && !!g.px &&
      (g.chipRight - g.chipLeft) + g.sym.w + g.px.w + (g.gap * 2) > g.head.w,
    JSON.stringify({ chips: g.chipRight - g.chipLeft, sym: g.sym.w, px: g.px.w,
                     gap: g.gap, row: g.head.w }));

  await B.resize(1600, 1000);
  bar = await B.evalIn(READ_BAR);
  side = await B.evalIn(vis('#side'));
  const bubCD = await B.evalIn(vis('#novo-ask-bubble'));
  const appD = await B.evalIn(`getComputedStyle(document.getElementById('app')).height`);
  ok('the bar is mobile-only', bar.display === 'none', bar.display);
  ok('...the side column is back where it always was', side.shown && side.w >= 250, JSON.stringify(side));
  ok('...the header button is back', bubCD.shown, JSON.stringify(bubCD));
  ok('...and the desk app is a full viewport again', Math.abs(parseFloat(appD) - 1000) <= 1, appD);

  errs = await B.evalIn(`window.__errs`);
  ok('the crypto page threw nothing', Array.isArray(errs) && errs.length === 0, JSON.stringify(errs));

  // == DR. NoVo'S COLOUR IS PER-APP =========================================================
  /* Jake, 2026-09-07, before he had even looked: "is the Dr. NoVo glow color correct for each app?"
     It was not - the first cut of these bars copied the trader's green onto all three.
     THE EXPECTED VALUE IS DERIVED, NOT TYPED. Each page already states its own Dr. NoVo colour on
     the header button's caret, so the tab is checked AGAINST THAT rather than against a hex written
     into this file. A test carrying its own copy of the answer goes stale the day someone retunes a
     palette, and would then be wrong in the same direction as the bug it exists to catch. */
  // ══ ALERTS ON ALL THREE ═══════════════════════════════════════════════════════════════════
  /* Jake, 2026-09-07: "all 3 get this alerts tab ... crypto subs can schedule and ask to be alerted
     just like the other two can."
     One card (/js/novo-alerts.js) and one VAPID registration (/js/novo-push.js) across three pages,
     so what is checked per page is that the tab EXISTS, that tapping it MOUNTS the card, and that
     the card reached the endpoint — not the card's internals again. */
  await fetch(base + '/__reset-alerts').catch(() => {});
  console.log('\nThe Alerts tab, on all three dashboards\n');
  for (const [page, open] of [
      ['trader-live.html', `switchMobileTab(5)`],
      ['analyst-live.html', `document.querySelector('.mob-tab[data-mtab="alerts"]').click()`],
      ['crypto-live.html', `document.querySelector('.mob-tab[data-mtab="alerts"]').click()`]]) {
    const app = page.split('-')[0];
    await B.goto(base + '/' + page, 430, 900);
    const tab = await B.evalIn(`(() => {
      const t = [...document.querySelectorAll('.mob-tab')]
        .find((e) => (e.textContent || '').indexOf('Alerts') >= 0);
      if (!t) return { missing: true };
      const r = t.getBoundingClientRect();
      return { shown: getComputedStyle(t).display !== 'none' && r.width > 0,
               w: Math.round(r.width), bottom: Math.round(r.bottom), vh: innerHeight }; })()`);
    ok(app + ': has an Alerts tab, on the bar, at a real size',
      !tab.missing && tab.shown && tab.w >= 44 && Math.abs(tab.bottom - tab.vh) <= 1,
      JSON.stringify(tab));

    await B.evalIn(open);
    await new Promise((r) => setTimeout(r, 900));
    const card = await B.evalIn(`(() => {
      const c = document.querySelector('.novo-alerts');
      if (!c) return { mounted: false };
      const r = c.getBoundingClientRect();
      return { mounted: true,
               visible: getComputedStyle(c).display !== 'none' && r.width > 0 && r.height > 0,
               rows: c.querySelectorAll('.al-row').length,
               text: (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 700),
               styled: !!document.querySelector('style[data-novo-alerts]') }; })()`);
    ok(app + ': tapping it mounts the shared card and it is on screen',
      card.mounted && card.visible, JSON.stringify(card).slice(0, 200));
    ok(app + ': ...the card brought its own styles with it',
      card.styled === true, JSON.stringify({ styled: card.styled }));
    /* The stub serves the same two alerts to every page, because the store is per MEMBER, not per
       product — one subscription, one list, three windows onto it. */
    ok(app + ': ...and it reached the endpoint and rendered the member’s alerts',
      card.rows >= 1 && card.text.indexOf('SPY above its call wall') >= 0,
      JSON.stringify(card.text).slice(0, 200));
  }

  // ══ THE DR. NoVo TAB'S OWN PANEL ══════════════════════════════════════════════════════════
  /* Jake: "the Dr. NoVo tab does need a help button that opens and tells them all the features and
     things they can do with Dr. NoVo a button next to the plain English button", and the digest is
     managed there rather than on Alerts. */
  console.log('\nDr. NoVo\u2019s help panel\n');
  for (const [page, openChat] of [
      ['trader-live.html', `switchMobileTab(4)`],
      ['analyst-live.html', `novoAskOpen(1)`],
      ['crypto-live.html', `novoAskOpen(1)`]]) {
    const app = page.split('-')[0];
    await B.goto(base + '/' + page, 430, 900);
    await B.evalIn(openChat);
    await new Promise((r) => setTimeout(r, 700));

    const btn = await B.evalIn(`(() => {
      const h = document.getElementById('novo-ask-help');
      const l = document.getElementById('novo-ask-lvl');
      if (!h || !l) return { missing: !h ? 'help' : 'lvl' };
      const rh = h.getBoundingClientRect(), rl = l.getBoundingClientRect();
      return { shown: getComputedStyle(h).display !== 'none' && rh.width > 0,
               /* "next to the plain English button" -- same row, and before it. */
               sameRow: Math.abs(rh.top - rl.top) <= 6,
               before: rh.left < rl.left,
               /* Measured against its NEIGHBOUR, not an absolute: "next to the plain English
                  button" means it should look like it belongs beside it. */
               tall: rh.height >= rl.height - 1 }; })()`);
    ok(app + ': a Help button sits beside Plain English',
      !btn.missing && btn.shown && btn.sameRow && btn.before && btn.tall, JSON.stringify(btn));

    await B.evalIn(`document.getElementById('novo-ask-help').click()`);
    await new Promise((r) => setTimeout(r, 700));
    const panel = await B.evalIn(`(() => {
      const d = document.getElementById('novo-desk');
      if (!d) return { open: false };
      const r = d.getBoundingClientRect();
      return { open: d.classList.contains('on'),
               visible: getComputedStyle(d).display !== 'none' && r.width > 0 && r.height > 0,
               rows: d.querySelectorAll('[data-say]').length,
               digest: !!d.querySelector('[data-nd-stop]'),
               text: (d.textContent || '').replace(/\\s+/g, ' ').trim() }; })()`);
    ok(app + ': ...it opens a panel of things you can actually do',
      panel.open && panel.visible && panel.rows >= 8, JSON.stringify(panel).slice(0, 200));
    ok(app + ': ...covering alerts AND the digest, and saying which lands where',
      /Alerts tab/i.test(panel.text) && /every morning/i.test(panel.text),
      JSON.stringify(panel.text).slice(0, 260));
    /* ⚠ NO BOXES. Jake's standing rule, and this panel shipped its first draft breaking it -- a
       1px border and an 11px radius around every row. The existing debox-check could not have
       caught it: that scans the PAGES, and these styles are injected by novo-desk.js, so they have
       no file to scan. Asserted where the panel is actually rendered instead. */
    const boxes = await B.evalIn(`(() => {
      const d = document.getElementById('novo-desk');
      const bad = [];
      d.querySelectorAll('.nd-row, .nd-card').forEach(function (e) {
        const c = getComputedStyle(e);
        const sides = ['Right', 'Bottom', 'Left'].filter(function (k) {
          return parseFloat(c['border' + k + 'Width']) > 0 && c['border' + k + 'Style'] !== 'none'; });
        if (sides.length || parseFloat(c.borderRadius) > 0)
          bad.push((e.className || '') + ':' + sides.join('/') + ' r=' + c.borderRadius);
      });
      return { bad: bad.slice(0, 4), n: bad.length }; })()`);
    ok(app + ': ...and it draws no boxes — hairlines between rows, not frames around them',
      boxes.n === 0, JSON.stringify(boxes));

    ok(app + ': ...and the digest is managed HERE, with a way to stop it',
      panel.digest === true, JSON.stringify({ digest: panel.digest }));

    /* ⚠ NO EXPAND, NO MINIMISE, WHEREVER THE TAB BAR IS. Both were gated at 720px while the bar
       starts at 768, so between the two — a foldable, a small tablet, a phone in landscape — the
       chat showed a tab bar AND an expand button AND a minimise chevron together. That is where
       Jake found it, and 430px would never have. So it is asked at BOTH widths, and paired with a
       desktop control so "not visible" cannot pass by the chat simply being shut. */
    for (const w of [430, 760]) {
      await B.resize(w, 900);
      await new Promise((r) => setTimeout(r, 350));
      const chrome = await B.evalIn(`(() => {
        const vis = (sel) => { const e = document.querySelector(sel);
          if (!e) return false; const r = e.getBoundingClientRect();
          return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; };
        return { bar: vis('#mobile-tabs'), mx: vis('#novo-ask .mx'), x: vis('#novo-ask .x'),
                 chat: vis('#novo-ask') }; })()`);
      ok(app + ' @' + w + ': the tab bar is up and neither expand nor minimise is',
        chrome.bar === true && chrome.chat === true
          && chrome.mx === false && chrome.x === false, JSON.stringify(chrome));
    }
    await B.resize(1600, 1000);
    /* ⚠ THE TRADER OPENS ITS DESKTOP CHAT A DIFFERENT WAY. switchMobileTab(4) reveals #col-novo,
       which is a MOBILE view — at 1600 it shows nothing, so the control failed reporting the chat
       shut and looked like the change under test. The desk path is setView. */
    await B.evalIn(app === 'trader' ? 'setView("novo")' : 'novoAskOpen(1)');
    await new Promise((r) => setTimeout(r, 600));
    const desk = await B.evalIn(`(() => {
      const vis = (sel) => { const e = document.querySelector(sel);
        if (!e) return false; const r = e.getBoundingClientRect();
        return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; };
      return { bar: vis('#mobile-tabs'), x: vis('#novo-ask .x'), chat: vis('#novo-ask') }; })()`);
    ok(app + ' @1600: control — with no tab bar, the chat keeps its own way out',
      desk.bar === false && desk.chat === true && desk.x === true, JSON.stringify(desk));
    await B.resize(430, 900);
    await new Promise((r) => setTimeout(r, 350));

    /* A row is only a feature if tapping it asks the thing it advertises. */
    const said = await B.evalIn(`(() => {
      window.__asked = null;
      window.novoAsk = function (q) { window.__asked = q; };
      const r = document.querySelector('#novo-desk [data-say]');
      const want = r.getAttribute('data-say');
      r.click();
      return { want: want, got: window.__asked,
               closed: !document.getElementById('novo-desk').classList.contains('on') }; })()`);
    ok(app + ': ...tapping one sends exactly what it promised, and closes',
      said.got === said.want && said.closed === true, JSON.stringify(said));
  }

  console.log('\nDr. NoVo carries each app’s own colour\n');
  const rgb = (v) => (String(v).match(/\d+(\.\d+)?/g) || []).slice(0, 3).join(',');
  const marks = {};
  for (const [page, caretSel] of [['trader-live.html', '.navbtn-novo .caret'],
                                  ['analyst-live.html', '#novo-ask-bubble .caret'],
                                  ['crypto-live.html', '#novo-ask-bubble .caret']]) {
    const app = page.split('-')[0];
    await B.goto(base + '/' + page, 1600, 1000);
    const caret = await B.evalIn(`(() => { const e = document.querySelector(${JSON.stringify(caretSel)});
      return e ? getComputedStyle(e).color : null; })()`);
    await B.resize(430, 900);
    const tab = await B.evalIn(`(() => {
      const t = document.querySelector('.mob-tab-novo'), i = t && t.querySelector('.mob-tab-icon');
      const other = document.querySelector('.mob-tab:not(.mob-tab-novo)');
      if (!t || !i || !other) return { missing: true };
      /* Transitions OFF for the measurement. The bar animates colour and border-color over .15s,
         and getComputedStyle during a transition returns the CURRENT animated value, not the
         target -- so reading immediately after adding the class reports the colour the tab is
         leaving. That is what the first run of this check measured: the trader came back
         rgb(110,110,110), its IDLE colour, against a rule that was perfectly correct. An
         instrument sampling an animation cannot answer a question about a stylesheet. */
      const had = other.classList.contains('mob-active');
      const prevT = other.style.transition;
      other.style.transition = 'none';
      other.classList.add('mob-active');
      const act = getComputedStyle(other).color, brd = getComputedStyle(other).borderTopColor;
      if (!had) other.classList.remove('mob-active');
      other.style.transition = prevT;
      return { color: getComputedStyle(t).color, shadow: getComputedStyle(i).textShadow,
               active: act, activeBorder: brd }; })()`);
    marks[app] = { caret, tab };
    ok(app + ': the tab’s Dr. NoVo mark is the colour this app already uses for him',
      !tab.missing && !!caret && rgb(tab.color) === rgb(caret),
      JSON.stringify({ caret, tab: tab.color }));
    ok(app + ': ...and the glow is that same colour, not a leftover from another dashboard',
      !tab.missing && rgb(tab.shadow) === rgb(caret),
      JSON.stringify({ caret, shadow: tab.shadow }));
    /* The neutral is what keeps the hue meaningful: if "active" took the page accent, the active
       tab and the Dr. NoVo tab would be the SAME colour on both analyst and crypto, and only a 2px
       border would tell them apart. */
    ok(app + ': ...and an active ordinary tab stays NEUTRAL, so Dr. NoVo is the only hue in the bar',
      !tab.missing && rgb(tab.active) === '168,174,187' && rgb(tab.activeBorder) === '168,174,187',
      JSON.stringify({ active: tab.active, border: tab.activeBorder }));
  }
  /* The cross-app invariant that would have caught the original bug on sight: one hex copied across
     three dashboards collapses this set to one entry. */
  const hues = ['trader', 'analyst', 'crypto'].map((a) => rgb((marks[a] || {}).caret));
  ok('all three Dr. NoVo colours are DIFFERENT - one hex copied across the apps fails here',
    new Set(hues).size === 3 && hues.every(Boolean), JSON.stringify(hues));

  // == OPENING THE CHAT MUST NOT RAISE THE ON-SCREEN KEYBOARD ===============================
  /* Jake, 2026-09-07: "both analyst and crypto open keyboard automatically when chat is open while
     trader doesnt open keyboard until you actually hit inside the text box. make both them like
     trader."
     There is no way to observe a soft keyboard from a page, so the check measures the thing that
     SUMMONS it: whether the composer holds focus after the panel opens. And it is run BOTH ways -
     a phone must not focus, and a desktop must - because "activeElement is not the input" is also
     what you would see if the chat simply failed to open. The negative alone proves nothing. */
  console.log('\nOpening the chat does not summon the keyboard\n');
  const FOCUSED = `(() => { const q = document.getElementById('novo-ask-q');
    return { has: !!q, focused: !!q && document.activeElement === q,
             coarse: matchMedia('(hover: hover) and (pointer: fine)').matches }; })()`;
  for (const [page, openMobile, openDesk] of [
      ['trader-live.html', `switchMobileTab(4)`, `setView('novo')`],
      ['analyst-live.html', `document.querySelector('.mob-tab[data-mtab="novo"]').click()`, `novoAskOpen(1)`],
      ['crypto-live.html', `document.querySelector('.mob-tab[data-mtab="novo"]').click()`, `novoAskOpen(1)`]]) {
    const app = page.split('-')[0];

    await B.goto(base + '/' + page, 430, 900);
    await B.evalIn(openMobile);
    await new Promise((r) => setTimeout(r, 500));
    const mob = await B.evalIn(FOCUSED);
    ok(app + ' @430: the emulator really is reporting a touch device',
      mob.coarse === false, JSON.stringify(mob));
    ok(app + ' @430: opening the chat leaves the composer UNfocused - no keyboard until it is tapped',
      mob.has && mob.focused === false, JSON.stringify(mob));
    /* ...and tapping the box still works, which is the whole point of the gate. */
    const tapped = await B.evalIn(`(() => { const q = document.getElementById('novo-ask-q');
      q.focus(); return document.activeElement === q; })()`);
    ok(app + ' @430: ...but tapping the box still focuses it',
      tapped === true, JSON.stringify(tapped));

    await B.goto(base + '/' + page, 1600, 1000);
    await B.evalIn(openDesk);
    await new Promise((r) => setTimeout(r, 500));
    const desk = await B.evalIn(FOCUSED);
    ok(app + ' @1600: control - a real keyboard still gets the cursor put in the box',
      desk.has && desk.focused === true, JSON.stringify(desk));
  }

  console.log('\n' + (failures ? 'FAIL ' : 'OK   ') + (checks - failures) + '/' + checks + ' checks\n');
  try { proc.kill(); } catch (_) {}
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { proc.kill(); } catch (_) {} process.exit(2); });
