/* strip-and-accent-check.js — two defects Jake found on the desktop Trader dashboard.
 *
 * 1. THE MARKET-INTEL STRIP CLIPPED ITS LAST READOUT. The one-line layout above 1850px was sized
 *    against a measured content width for EIGHT readouts; Vanna and Charm/day were added later and
 *    nothing re-derived the number, so at 1920 the row overflowed and `overflow: hidden` ate the
 *    VIX value. The page's own comment records this being fixed once already.
 *
 *    ⚠ AND THE FIRST VERSION OF THIS CHECK COULD NOT SEE IT. Headless, every readout renders "—",
 *    so the strip fits at any width and the probe reported no overflow against a genuinely broken
 *    page. The tiles are FILLED with realistic values before measuring — the defect is a function
 *    of content, so a test with no content tests nothing.
 *
 * 2. THE TRADER CHAT WAS BLUE. Every accent now reads through --askacc, so the docked panel
 *    overrides one token. Asserted as COMPUTED colour on the controls a member actually sees.
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

/* Realistic values, taken from Jake's screenshot rather than invented — the widest states the strip
   actually renders, which is the only content that can reproduce the clip. */
const FILL = `(() => {
  const mi = document.getElementById('card-mktintel');
  if (!mi) return 0;
  const vals = ['Off-hrs','Off-hrs','Off-hrs','Off-hrs','-149.54M','61st pct of 33d',
                '98% of book \\u00b7 pin 768.00','+8.68B','-150.5M','Off-hrs','Off-hrs','14.52'];
  let i = 0;
  Array.from(mi.querySelectorAll('.dr, .bar-row')).forEach((row) => {
    const spans = row.querySelectorAll('span, b, div');
    const last = spans.length ? spans[spans.length - 1] : null;
    if (last && i < vals.length) { last.textContent = vals[i++]; }
  });
  return i;
})()`;

(async () => {
  const PORT = 8822;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9401', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'stripchk'), 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 120; i++) {
    try { wsUrl = (await (await fetch('http://127.0.0.1:9401/json/version')).json()).webSocketDebuggerUrl; break; }
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
  const evalIn = async (expr) => (await send('Runtime.evaluate', { returnByValue: true, expression: expr }, sid)).result.result.value;
  const load = async (w) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/trader-live.html' }, sid);
    await new Promise((r) => setTimeout(r, 1500));
  };

  console.log('\nMarket-intel strip + Trader chat accent\n');

  for (const w of [1920, 1800, 1600, 1440]) {
    await load(w);
    const filled = await evalIn(FILL);
    await new Promise((r) => setTimeout(r, 200));
    const m = await evalIn(`(() => {
      const mi = document.getElementById('card-mktintel');
      const rows = Array.from(mi.querySelectorAll('.dr, .bar-row'));
      const box = mi.getBoundingClientRect();
      let worst = 0, offender = '';
      rows.forEach((r) => {
        const b = r.getBoundingClientRect();
        const over = Math.round(b.right - box.right);
        if (over > worst) { worst = over; offender = (r.textContent||'').replace(/\\s+/g,' ').trim().slice(0,26); }
      });
      const contentW = rows.reduce((a, r) => a + r.getBoundingClientRect().width, 0);
      return { vw: window.innerWidth, rows: rows.length,
               stripW: Math.round(box.width), contentW: Math.round(contentW),
               clippedBy: worst, offender: offender,
               scrollOverflow: mi.scrollWidth - mi.clientWidth,
               wrap: getComputedStyle(mi).flexWrap,
               visibleLabels: rows.filter(r => r.getBoundingClientRect().width > 0)
                 .map(r => { const l = r.querySelector('.dk, .bar-lbl');
                             return l ? l.textContent.trim() : ''; }) }; })()`);
    console.log('  .. ' + w + 'px  rows=' + m.rows + ' filled=' + filled +
      ' clippedBy=' + m.clippedBy + ' scrollOverflow=' + m.scrollOverflow +
      ' wrap=' + m.wrap + ' stripW=' + m.stripW + ' contentW=' + m.contentW +
      (m.offender ? ' offender="' + m.offender + '"' : ''));
    // The two parked readouts must be gone from the Trader strip — and still present on the
    // Analyst dashboard, which is asserted separately below.
    ok(w + 'px: Gamma Squeeze and Analyst Score are parked',
      m.visibleLabels.indexOf('Gamma Squeeze') === -1 && m.visibleLabels.indexOf('Analyst Score') === -1,
      m.visibleLabels.join(' | '));
    ok(w + 'px: no readout is clipped off the right edge (filled with real values)',
      m.clippedBy <= 1 && m.scrollOverflow <= 1,
      JSON.stringify(m) + '  filledTiles=' + filled);
  }

  // ── the chat accent ────────────────────────────────────────────────────────────────────────
  await load(1600);
  await evalIn('window.setView("novo")');
  await new Promise((r) => setTimeout(r, 700));
  const c = await evalIn(`(() => {
    const g = getComputedStyle(document.querySelector('#novo-ask .go'));
    const q = getComputedStyle(document.getElementById('novo-ask-q'));
    const k = getComputedStyle(document.querySelector('#novo-ask .quick button'));
    const p = getComputedStyle(document.getElementById('novo-ask'));
    return { token: p.getPropertyValue('--askacc').trim(),
             ask: g.backgroundColor, input: q.borderColor, chip: k.borderColor }; })()`);
  const green = (s) => /52,\s*211,\s*153/.test(s || '');
  const blue = (s) => /34,\s*211,\s*238/.test(s || '');
  ok('the Trader chat token is green', c.token === '#34d399', JSON.stringify(c));
  ok('the Ask button is green, not blue', green(c.ask) && !blue(c.ask), JSON.stringify(c));
  ok('the input border is green, not blue', green(c.input) && !blue(c.input), JSON.stringify(c));
  ok('the quick chips are green, not blue', green(c.chip) && !blue(c.chip), JSON.stringify(c));

  /* Jake: "park them from the trader dashboard for now. (stays in analyst)". Parking only means
     anything if the other dashboard still has them — a rule that hid them everywhere would pass
     every check above and quietly lose two readouts. So the retention is asserted, not assumed. */
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/analyst-live.html' }, sid);
  await new Promise((r) => setTimeout(r, 1500));
  /* ⚠ NOT innerText. The analyst's squeeze hero is display:none until live data arrives, so with
     no feed it renders nothing and a text search reports it MISSING on a dashboard that has it.
     The question is whether the markup still exists, not whether today's session happens to be
     showing it — so the DOM is asked, not the rendered text. */
  const an = await evalIn(`(() => ({
    squeeze: !!document.getElementById('d-sqz-hero'),
    html: /gamma squeeze/i.test(document.documentElement.innerHTML) }))()`);
  ok('the Analyst dashboard still carries Gamma Squeeze',
    an.squeeze && an.html, JSON.stringify(an));

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  ws.close(); proc.kill(); server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
