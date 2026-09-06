/* trader-settings-check.js — the trader Settings drawer is real, not decorative.
 *
 * Jake, 2026-09-06: "the settings menu is also missing alot." It was one item — "Back to portal" —
 * against seven on the analyst dashboard.
 *
 * ⚠ THE FAKE PREFS ENDPOINT ANSWERS email_optin:false ON PURPOSE. The button's own default text is
 * "On", so a check that merely asserts the toggle exists, is visible, or says something, passes a
 * control that never contacted the server at all. Answering with the OPPOSITE of the default is the
 * whole reason this check can fail.
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
let failures = 0, checks = 0, posted = null;
const ok = (n, c, d) => { checks++; if (c) return console.log('  PASS  ' + n);
  failures++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/api/analyst-publish') {
    if (req.method === 'POST') {
      let b = ''; req.on('data', (c) => b += c);
      req.on('end', () => {
        try { posted = JSON.parse(b); } catch (_) { posted = b; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ email_optin: posted && posted.email_optin }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ email_optin: false }));   // the opposite of the button's default
    return;
  }
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
  const PORT = 8858;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9437', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'setchk'), 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 120; i++) {
    try { wsUrl = (await (await fetch('http://127.0.0.1:9437/json/version')).json()).webSocketDebuggerUrl; break; }
    catch (_) { await new Promise((r) => setTimeout(r, 150)); }
  }
  const ws = new WebSocket(wsUrl); let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (me, pa, si) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: pa, sessionId: si })); });
  await new Promise((r) => { ws.onopen = r; });
  const t = (await send('Target.createTarget', { url: 'about:blank' })).result;
  const sid = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result.sessionId;
  await send('Page.enable', {}, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('novo_live_t','TESTTOKEN')}catch(e){}" }, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/trader-live.html' }, sid);
  await new Promise((r) => setTimeout(r, 1900));
  const ev = async (e) => (await send('Runtime.evaluate', { returnByValue: true, expression: e, awaitPromise: true }, sid)).result.result.value;

  console.log('\nTrader settings drawer\n');

  const shut = await ev(`(() => { const d = document.getElementById('set-drawer');
    if (!d) return { missing: true };
    return { off: Math.round(d.getBoundingClientRect().left) >= innerWidth - 2 }; })()`);
  ok('the drawer is off screen until it is asked for', shut && shut.off, JSON.stringify(shut));

  await ev("document.querySelector('.hdr-menu-btn').click()");
  await new Promise((r) => setTimeout(r, 900));
  const open = await ev(`(() => {
    const d = document.getElementById('set-drawer'), r = d.getBoundingClientRect();
    const links = Array.from(d.querySelectorAll('a')).map((a) => ({
      txt: a.textContent.replace(/\\s+/g, ' ').trim(), href: a.getAttribute('href') }));
    const eb = document.getElementById('tset-email');
    return { onScreen: r.left < innerWidth - 40 && r.width > 200,
             bodyLocked: getComputedStyle(document.body).overflow === 'hidden',
             links,
             email: { txt: eb.textContent.trim(), on: !!eb.dataset.on, disabled: eb.disabled } }; })()`);

  ok('the header control opens it', open.onScreen, JSON.stringify(open.onScreen));
  ok('...and the page behind it stops scrolling — which now matters, the Analysis tab is a document',
    open.bodyLocked, JSON.stringify(open.bodyLocked));
  /* Counted, not eyeballed, so an edit that guts the drawer back toward one item fails here. */
  ok('it carries the account links, not just a way out',
    open.links.length >= 5, JSON.stringify(open.links));
  ok('...and every link points somewhere, none are placeholders',
    open.links.every((l) => l.href && l.href !== '#' && l.href.length > 1), JSON.stringify(open.links));

  /* THE ONE THAT MATTERS. The server said OFF; the control's default text is "On". Reading "Off"
     proves it asked and listened. Reading "On" would mean it is decoration. */
  ok('the email toggle shows the value the SERVER holds, not its own default',
    open.email.txt === 'Off' && open.email.on === false && !open.email.disabled,
    JSON.stringify(open.email));

  await ev("document.getElementById('tset-email').click()");
  await new Promise((r) => setTimeout(r, 700));
  const after = await ev(`(() => { const eb = document.getElementById('tset-email');
    return { txt: eb.textContent.trim(), on: !!eb.dataset.on }; })()`);
  ok('...and clicking it writes the preference back, with the member token',
    after.txt === 'On' && posted && posted.email_optin === true && posted.token === 'TESTTOKEN',
    JSON.stringify(after) + '  posted=' + JSON.stringify(posted));

  /* Push is deliberately ABSENT: /trader/sw.js is an install-only PWA shell with no push handler,
     so the toggle would subscribe successfully and never deliver anything. Asserted so it cannot be
     added back without the handler that makes it true. */
  const push = await ev("!!document.querySelector('#set-drawer [id*=push], #set-drawer [id*=Push]')");
  ok('no push toggle while the trader service worker cannot receive push', !push, String(push));

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  ws.close(); proc.kill(); server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
