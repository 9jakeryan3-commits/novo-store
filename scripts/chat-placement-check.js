/* chat-placement-check.js — where the chat button lives and where the panel opens.
 *
 * Jake, 2026-09-06:
 *   crypto  — button into the header beside the wordmark; opens into the MIDDLE section on
 *             desktop, FULL SCREEN on mobile.
 *   analyst — button into the header beside the wordmark; opens FULL SCREEN on desktop AND mobile.
 *
 * Every assertion is geometric, because "moved into the header" and "opens full screen" are claims
 * about pixels. The button being a child of <header> proves nothing about whether it renders there,
 * and a panel with an `.on` class proves nothing about whether it covers the viewport.
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

(async () => {
  const PORT = 8836;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9412', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'chatplace'), 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 120; i++) {
    try { wsUrl = (await (await fetch('http://127.0.0.1:9412/json/version')).json()).webSocketDebuggerUrl; break; }
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
  await send('Page.addScriptToEvaluateOnNewDocument',
    { source: "try{localStorage.setItem('novo_live_t','x');localStorage.removeItem('novo_ask_log');localStorage.removeItem('novo_ask_log_crypto');}catch(e){}" }, sid);
  const evalIn = async (e) => (await send('Runtime.evaluate', { returnByValue: true, expression: e }, sid)).result.result.value;
  const load = async (page, w) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 700 }, sid);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' + page }, sid);
    await new Promise((r) => setTimeout(r, 1700));
  };

  /* IN THE HEADER means: same horizontal band as the wordmark, and to the RIGHT of it. A button
     that is a DOM child of <header> but rendered 900px below it would satisfy "moved" and fail the
     thing Jake actually asked for. */
  const HEADER = `(() => {
    const b = document.getElementById('novo-ask-bubble');
    const wm = document.querySelector('.lv-brand');
    if (!b || !wm) return { missing: !b ? 'button' : 'wordmark' };
    const rb = b.getBoundingClientRect(), rw = wm.getBoundingClientRect();
    const overlapY = Math.min(rb.bottom, rw.bottom) - Math.max(rb.top, rw.top);
    return { fixed: getComputedStyle(b).position === 'fixed',
             visible: rb.width > 40 && rb.height > 10,
             sameBand: overlapY > Math.min(rb.height, rw.height) * 0.5,
             rightOfMark: rb.left >= rw.left,
             top: Math.round(rb.top), wmTop: Math.round(rw.top) }; })()`;

  console.log('\nChat button placement and open behaviour\n');

  // ── ANALYST: header button, FULL SCREEN at both widths ─────────────────────────────────────
  for (const w of [1600, 430]) {
    await load('analyst-live.html', w);
    const h = await evalIn(HEADER);
    ok('analyst @' + w + ': the button is in the header beside the wordmark',
      !h.missing && h.visible && h.sameBand && h.rightOfMark && !h.fixed, JSON.stringify(h));

    const open = await evalIn(`(() => { window.novoAskOpen(1);
      const p = document.getElementById('novo-ask'); const r = p.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height),
               vw: innerWidth, vh: innerHeight, max: p.classList.contains('max') }; })()`);
    ok('analyst @' + w + ': it opens FULL SCREEN',
      open.max && open.w >= open.vw - 2 && open.h >= open.vh - 2, JSON.stringify(open));
  }

  // ── CRYPTO: header button; docked into #center on desktop, full screen on mobile ────────────
  await load('crypto-live.html', 1600);
  const ch = await evalIn(HEADER);
  ok('crypto @1600: the button is in the header beside the wordmark',
    !ch.missing && ch.visible && ch.sameBand && ch.rightOfMark && !ch.fixed, JSON.stringify(ch));

  const mid = await evalIn(`(() => { window.novoAskOpen(1);
    const p = document.getElementById('novo-ask'), c = document.getElementById('center');
    const rp = p.getBoundingClientRect(), rc = c.getBoundingClientRect();
    const inside = rp.left >= rc.left - 2 && rp.right <= rc.right + 2 &&
                   rp.top >= rc.top - 2 && rp.bottom <= rc.bottom + 2;
    const fills = rp.width >= rc.width - 4 && rp.height >= rc.height - 4;
    return { inside, fills, max: p.classList.contains('max'),
             panel: [Math.round(rp.left), Math.round(rp.width)],
             center: [Math.round(rc.left), Math.round(rc.width)],
             vw: innerWidth }; })()`);
  ok('crypto @1600: it opens INTO the middle section, not over the whole page',
    mid.inside && mid.fills && !mid.max && mid.center[1] < mid.vw - 100, JSON.stringify(mid));

  await load('crypto-live.html', 430);
  const cm = await evalIn(`(() => { window.novoAskOpen(1);
    const p = document.getElementById('novo-ask'); const r = p.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight,
             max: p.classList.contains('max') }; })()`);
  ok('crypto @430: it opens FULL SCREEN on mobile',
    cm.max && cm.w >= cm.vw - 2 && cm.h >= cm.vh - 2, JSON.stringify(cm));

  // ── ANALYST: the bias heading sits OUTSIDE its card, like the ticker strip's ────────────────
  await load('analyst-live.html', 1600);
  const bias = await evalIn(`(() => {
    const hd = document.querySelector('.bias-col .strip-hd');
    const card = document.getElementById('bias-card');
    const strip = document.querySelector('.lv-strip .strip-hd');
    if (!hd || !card) return { missing: true };
    const rh = hd.getBoundingClientRect(), rc = card.getBoundingClientRect();
    return { outside: !card.contains(hd),
             above: rh.bottom <= rc.top + 1,
             text: hd.textContent.trim(),
             alignedWithStripLabel: strip ? Math.abs(rh.top - strip.getBoundingClientRect().top) <= 2 : null,
             cardHasNoH2: !card.querySelector('h2') }; })()`);
  ok('analyst: the bias heading is OUTSIDE the card', !bias.missing && bias.outside && bias.cardHasNoH2, JSON.stringify(bias));
  ok('analyst: ...and sits ABOVE it', bias.above, JSON.stringify(bias));
  ok('analyst: ...on the same line as the ticker strip label it now matches',
    bias.alignedWithStripLabel === true || bias.alignedWithStripLabel === null, JSON.stringify(bias));

  // ── TRADER: pill gone, nav on the right, real wordmark ─────────────────────────────────────
  await load('trader-live.html', 1600);
  const tr = await evalIn(`(() => {
    const pill = document.getElementById('term-live-row');
    const nav = document.getElementById('saas-nav');
    const brand = document.querySelector('.tb-brand');
    const sess = document.getElementById('hdr-session-ts');
    const rn = nav && nav.getBoundingClientRect(), rs = sess && sess.getBoundingClientRect();
    const brandR = brand ? brand.getBoundingClientRect().right : 0;
    return { pillHidden: !pill || getComputedStyle(pill).display === 'none' || pill.getBoundingClientRect().width === 0,
             navLeftOfSession: !!(rn && rs && rn.right <= rs.left + 2),
             /* ⚠ NOT "is it past the midpoint". The nav sits in .tb-right, which is margin-left:auto
                — so it starts wherever that whole group starts, measured at 44% of a 1600px bar.
                The strict half-width test failed a layout that is exactly what was asked for. What
                Jake asked was that it move OFF the brand and sit beside the session readout, so
                that is what is asserted: inside the right-hand group, and clear of the wordmark. */
             navInRightGroup: !!(nav && nav.closest && nav.closest('.tb-right')),
             navClearOfBrand: !!(rn && rn.left > brandR + 40),
             brandImg: !!(brand && brand.querySelector('img')),
             brandWords: brand ? brand.textContent.replace(/\\s+/g,' ').trim() : null }; })()`);
  ok('trader: the Studying pill is gone', tr.pillHidden, JSON.stringify(tr));
  ok('trader: the view switchers sit in the right-hand group, beside the session readout',
    tr.navInRightGroup && tr.navClearOfBrand && tr.navLeftOfSession, JSON.stringify(tr));
  ok('trader: the real coin mark and two-line wordmark are in place',
    tr.brandImg && /NoVo/.test(tr.brandWords || '') && /Trading Dashboard/i.test(tr.brandWords || ''),
    JSON.stringify(tr));

  if (process.env.SHOT) {
    const out = process.env.SHOT_DIR || os.tmpdir();
    for (const [page, w, tag] of [['analyst-live.html', 1600, 'analyst'], ['crypto-live.html', 1600, 'crypto']]) {
      await load(page, w);
      await evalIn('window.novoAskOpen(0)');
      await new Promise((r) => setTimeout(r, 250));
      let png = (await send('Page.captureScreenshot', { format: 'png',
        clip: { x: 0, y: 0, width: w, height: 190, scale: 1 } }, sid)).result;
      fs.writeFileSync(path.join(out, 'place-' + tag + '-header.png'), Buffer.from(png.data, 'base64'));
      await evalIn('window.novoAskOpen(1)');
      await new Promise((r) => setTimeout(r, 400));
      png = (await send('Page.captureScreenshot', { format: 'png' }, sid)).result;
      fs.writeFileSync(path.join(out, 'place-' + tag + '-open.png'), Buffer.from(png.data, 'base64'));
    }
    console.log('  .. shots -> ' + out);
  }

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  ws.close(); proc.kill(); server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
