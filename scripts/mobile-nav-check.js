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

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
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
  ok('three tabs, in the order Jake asked for',
    bar.tabs.length === 3 &&
    bar.tabs.map((t) => t.label).join('|') === 'Dealer Map|The Read|Dr. NoVo',
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
             readText: rd ? (rd.textContent || '').replace(/\s+/g, ' ').trim().length : 0,
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
  ok('four tabs, in the order Jake asked for', bar.tabs.length === 4 &&
    bar.tabs.map((t) => t.label).join('|') === 'Stats|Coins|Map|Dr. NoVo',
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
