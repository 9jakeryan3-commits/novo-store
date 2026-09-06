/* keys-visible-check.js — the keyboard layer is DISCOVERABLE on all three dashboards.
 *
 * Jake: "when a user opens it you can not see that keyboard commands are possible... make keyboard
 * commands clearly visible and usable on all 3 dashboards."
 *
 * So the assertions are about what a member can SEE and CLICK, not about whether a key handler is
 * bound. Two things have to be true and they are different: the hint must be VISIBLE (real pixels,
 * in the viewport, not display:none behind a media query), and it must be USABLE — clicking it has
 * to do what the key does, because a hint you cannot click is an instruction rather than a control.
 *
 * And it must be ABSENT on touch, where it would advertise something the device cannot operate.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
let failures = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  PASS  ' + name); return; }
  failures++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  const f = path.join(PUBLIC, rel === '/' ? 'trader-live.html' : rel);
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(f));
});

const CHROME = process.env.CHROME_BIN || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome found; set CHROME_BIN'); process.exit(2); }

const PAGES = ['trader-live.html', 'analyst-live.html', 'crypto-live.html'];

(async () => {
  const PORT = 8830;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9407', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'keysvis'), 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 120; i++) {
    try { wsUrl = (await (await fetch('http://127.0.0.1:9407/json/version')).json()).webSocketDebuggerUrl; break; }
    catch (_) { await new Promise((r) => setTimeout(r, 150)); }
  }
  const ws = new WebSocket(wsUrl); let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (me, pa, si) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: pa, sessionId: si })); });
  await new Promise((r) => { ws.onopen = r; });
  const t = (await send('Target.createTarget', { url: 'about:blank' })).result;
  const s = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result;
  const sid = s.sessionId;
  await send('Page.enable', {}, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('novo_live_t','x')}catch(e){}" }, sid);
  const evalIn = async (e) => (await send('Runtime.evaluate', { returnByValue: true, expression: e }, sid)).result.result.value;
  const load = async (page, w, touch) => {
    await send('Emulation.setDeviceMetricsOverride',
      { width: w, height: 950, deviceScaleFactor: 1, mobile: !!touch }, sid);
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: !!touch, configuration: 'mobile' }, sid).catch(() => {});
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' + page }, sid);
    await new Promise((r) => setTimeout(r, 1600));
  };

  console.log('\nKeyboard commands are visible and usable\n');

  for (const page of PAGES) {
    await load(page, 1600, false);

    /* VISIBLE means occupying real pixels inside the viewport — not merely present in the DOM.
       A hint rendered into a hidden container, or scrolled off, is exactly as undiscoverable as
       no hint at all, and `document.getElementById(...) !== null` cannot tell the difference. */
    const v = await evalIn(`(() => {
      const h = document.getElementById('novo-keys-hint');
      if (!h) return { present: false };
      const r = h.getBoundingClientRect();
      const cs = getComputedStyle(h);
      const btns = Array.from(h.querySelectorAll('button'));
      return { present: true,
               w: Math.round(r.width), h: Math.round(r.height),
               inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
               display: cs.display, vis: cs.visibility,
               buttons: btns.length,
               text: h.textContent.replace(/\\s+/g, ' ').trim() }; })()`);

    ok(page + ': the hint is on the page at all', v.present, JSON.stringify(v));
    ok(page + ': ...rendered with real size, inside the viewport',
      v.w > 40 && v.h > 10 && v.inViewport && v.display !== 'none' && v.vis !== 'hidden',
      JSON.stringify(v));
    ok(page + ': ...naming the modifier key and the shortcut sheet',
      /(⌘|Ctrl)/.test(v.text || '') && /K/.test(v.text || '') && /\?/.test(v.text || ''),
      JSON.stringify(v.text));

    /* USABLE: a click must open the palette, the same as the key. */
    const clicked = await evalIn(`(() => {
      document.querySelector('#novo-keys-hint [data-nvk-open]').click();
      const el = document.getElementById('nvk');
      const r = el && el.getBoundingClientRect();
      return { open: !!(el && el.classList.contains('on')),
               painted: !!(r && r.width > 100 && r.height > 60) }; })()`);
    ok(page + ': clicking the hint OPENS the palette, not just binds a key',
      clicked.open && clicked.painted, JSON.stringify(clicked));

    /* And the shortcut sheet — routed to whichever sheet the page actually owns. trader-live keeps
       its own; sending it to the shared one would open an empty panel on the busiest page. */
    const sheet = await evalIn(`(() => {
      try { window.NovoKeys.close(); } catch (e) {}
      const trader = typeof window._kbHelpToggle === 'function';
      document.querySelector('#novo-keys-hint [data-nvk-help]').click();
      const own = document.getElementById('nvk-sheet');
      const kb = document.getElementById('kbd-help');
      const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect();
        return getComputedStyle(el).display !== 'none' && r.width > 80 && r.height > 40; };
      return { trader: trader, shared: shown(own), traderSheet: shown(kb) }; })()`);
    ok(page + ': the ? button opens a sheet with real content',
      sheet.trader ? sheet.traderSheet : sheet.shared, JSON.stringify(sheet));
  }

  /* TOUCH: the hint must be gone. Advertising Cmd-K on a phone is worse than saying nothing. */
  await load('trader-live.html', 430, true);
  const touch = await evalIn(`(() => {
    const h = document.getElementById('novo-keys-hint');
    const r = h && h.getBoundingClientRect();
    return { coarse: matchMedia('(pointer:coarse)').matches,
             w: r ? Math.round(r.width) : 0,
             display: h ? getComputedStyle(h).display : 'absent' }; })()`);
  ok('touch: the hint is hidden where there is no keyboard to use it',
    touch.coarse ? (touch.display === 'none' || touch.w === 0) : true, JSON.stringify(touch));

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  /* SHOT=1 renders each topbar. Every assertion above says the hint has real pixels; only a picture
     says whether it reads as part of the chrome rather than bolted onto it. */
  if (process.env.SHOT) {
    const out = process.env.SHOT_DIR || os.tmpdir();
    for (const page of PAGES) {
      await load(page, 1600, false);
      const clip = await evalIn(`(() => { const h = document.getElementById('novo-keys-hint');
        const r = h.getBoundingClientRect();
        return { x: 0, y: Math.max(0, Math.round(r.top - 16)), width: 1600,
                 height: Math.round(r.height + 32) }; })()`);
      const png = (await send('Page.captureScreenshot',
        { format: 'png', clip: Object.assign({ scale: 1 }, clip) }, sid)).result;
      fs.writeFileSync(path.join(out, 'keys-hint-' + page + '.png'), Buffer.from(png.data, 'base64'));
    }
    console.log('  .. shots -> ' + out);
  }

  ws.close(); proc.kill(); server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
