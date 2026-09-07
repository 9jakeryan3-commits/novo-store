/* chat-sync-check.js — the conversation follows the MEMBER, not the browser.
 *
 * Jake's flaw, stated exactly: "in all chats they are not the same from browser to phone".
 *
 * So the test is not "does an endpoint respond" — it is TWO SEPARATE BROWSER PROFILES, which is
 * what a desktop and a phone actually are. Profile A asks a question; profile B opens the chat and
 * must see it. Anything less (one profile, cleared storage) proves the storage round-trips, not
 * that a second device inherits the conversation.
 *
 * The KV store is stubbed in-process, so this runs offline and asserts the CLIENT contract — the
 * merge, the scopes, the fail-soft — rather than Upstash's behaviour.
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

/* The server side, stubbed: one store per scope, and the same union-merge the real endpoint does.
   Keyed on the token so a different member cannot read this one's transcript. */
const STORE = {};
function handleChatLog(req, res, bodyRaw) {
  const u = new URL(req.url, 'http://x');
  const body = bodyRaw ? JSON.parse(bodyRaw) : {};
  const tok = body.t || u.searchParams.get('t');
  if (!tok) { res.writeHead(401); res.end('{"error":"no token"}'); return; }
  const scope = body.scope || u.searchParams.get('scope') || 'equity';
  const key = tok + '|' + scope;
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, synced: true, turns: STORE[key] || [] }));
    return;
  }
  const seen = {}, out = [];
  [(STORE[key] || []), (body.turns || [])].forEach((l) => l.forEach((m) => {
    const k = m.t + '|' + m.r + '|' + String(m.x).slice(0, 120);
    if (!seen[k]) { seen[k] = 1; out.push(m); }
  }));
  out.sort((a, b) => a.t - b.t);
  STORE[key] = out;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, synced: true, turns: out }));
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/api/chat-log') {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => handleChatLog(req, res, b));
    return;
  }
  if (rel.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return;
  }
  const f = path.join(PUBLIC, rel === '/' ? 'trader-live.html' : rel);
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

/* One browser PROFILE = one device. Two profiles is the whole point of this file. */
function launch(port, tag) {
  return spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port, '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + path.join(os.tmpdir(), 'chatsync-' + tag + '-' + Date.now()),
    'about:blank'], { stdio: 'ignore' });
}

async function attach(port) {
  let wsUrl;
  for (let i = 0; i < 120; i++) {
    try { wsUrl = (await (await fetch('http://127.0.0.1:' + port + '/json/version')).json()).webSocketDebuggerUrl; break; }
    catch (_) { await new Promise((r) => setTimeout(r, 150)); }
  }
  const ws = new WebSocket(wsUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params, sessionId) => new Promise((r) => {
    const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  await new Promise((r) => { ws.onopen = r; });
  const t = (await send('Target.createTarget', { url: 'about:blank' })).result;
  const s = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result;
  const sid = s.sessionId;
  await send('Page.enable', {}, sid);
  await send('Page.addScriptToEvaluateOnNewDocument',
    { source: "try{localStorage.setItem('novo_live_t','member-alpha');}catch(e){}" }, sid);
  const evalIn = async (expr) => {
    const r = (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr }, sid)).result;
    if (r.exceptionDetails) return { __err: String((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text) };
    return r.result.value;
  };
  const goto = async (url, w) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 950, deviceScaleFactor: 1, mobile: w < 769 }, sid);
    await send('Page.navigate', { url }, sid);
    await new Promise((r) => setTimeout(r, 1600));
  };
  return { ws, send, sid, evalIn, goto };
}

(async () => {
  const PORT = 8814;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + PORT;
  const pA = launch(9391, 'desk'), pB = launch(9392, 'phone');
  const A = await attach(9391), B = await attach(9392);

  console.log('\nChat continuity across devices\n');

  // ── DEVICE A: the desktop. Ask on the Trader dashboard. ────────────────────────────────────
  await A.goto(base + '/trader-live.html', 1600);
  await A.evalIn('window.setView("novo")');
  await new Promise((r) => setTimeout(r, 500));
  const asked = await A.evalIn(`(async () => {
    // Write a turn the way the chat does, then let its own save path run.
    await window.novoAsk('what is the flip on SPY?');
    await new Promise(r => setTimeout(r, 2200));   // past the sync debounce
    return document.querySelectorAll('#novo-ask-log .m').length; })()`);
  ok('device A: the question is in the log', asked >= 1, JSON.stringify(asked));

  const pushed = Object.keys(STORE).length > 0 && (STORE['member-alpha|equity'] || []).length > 0;
  ok('device A: the turn reached the server', pushed,
    JSON.stringify(Object.keys(STORE)) + ' ' + JSON.stringify((STORE['member-alpha|equity'] || []).length));

  // ── DEVICE B: a DIFFERENT browser profile. Empty localStorage, same member. ─────────────────
  /* ⚠ MEASURE "EMPTY" BEFORE THE PAGE THAT FILLS IT. The first version read localStorage after
     goto() had already waited 1.6s on the dashboard — by which time the sync had pulled, so
     "device B started with nothing" reported 2 and failed against a working product. A
     before/after check has to take BEFORE at a moment when after cannot have happened yet.
     So: land on a plain asset on the same origin first — same localStorage, no chat, no sync. */
  await B.goto(base + '/js/novo-chat-sync.js', 430);
  const before = await B.evalIn(`(() => { try { return (JSON.parse(localStorage.getItem('novo_ask_log')||'{}').turns||[]).length; } catch(e){ return 0; } })()`);
  await B.goto(base + '/analyst-live.html', 430);
  await new Promise((r) => setTimeout(r, 2000));
  const after = await B.evalIn(`(() => {
    const t = (() => { try { return (JSON.parse(localStorage.getItem('novo_ask_log')||'{}').turns||[]); } catch(e){ return []; } })();
    return { n: t.length, first: t.length ? t[0].x : null,
             rendered: document.querySelectorAll('#novo-ask-log .m').length }; })()`);

  ok('device B started with nothing (a genuinely separate device)', before === 0, JSON.stringify(before));
  ok('device B receives the conversation from device A',
    after.n >= 1 && /flip on SPY/.test(after.first || ''), JSON.stringify(after));
  ok('...and it is RENDERED, not merely in storage', after.rendered >= 1, JSON.stringify(after));

  /* ── SCOPE: crypto is a different desk. ────────────────────────────────────────────────────
     Jake, 2026-09-07: "make sure you didnt blend crypto chats with the equities side ... crypto
     blend would be a loss."

     ⚠ THE ORIGINAL FORM OF THIS CHECK COULD NOT ANSWER THAT QUESTION. It asserted only that the
     crypto transcript was EMPTY — which is also exactly what you get if crypto's sync is broken, if
     the key name here has drifted, or if the page never loaded at all. An instrument that cannot
     find anything and one reporting that nothing is there look identical. So the negative gets a
     POSITIVE CONTROL beside it: a turn is pushed into the CRYPTO scope first, and the crypto page
     must receive THAT while still not receiving the equity one. Now it fails in both directions —
     if the desks blend, and if the crypto lane silently stops working. */
  const CQ = 'what is BTC funding doing?';
  await A.evalIn(`(async () => {
    window.novoChatSync.push('crypto', [{ r:'you', x:${JSON.stringify(CQ)}, t: Date.now() }]);
    await new Promise(r => setTimeout(r, 2200)); })()`);
  ok('control: a crypto-scoped turn reaches the server under its OWN key',
    (STORE['member-alpha|crypto'] || []).length === 1,
    JSON.stringify(Object.keys(STORE)));

  await B.goto(base + '/crypto-live.html', 430);
  await new Promise((r) => setTimeout(r, 2000));
  const cx = await B.evalIn(`(() => {
    const rd = (k) => { try { return (JSON.parse(localStorage.getItem(k)||'{}').turns||[]); } catch(e){ return []; } };
    const c = rd('novo_ask_log_crypto');
    return { n: c.length, text: c.map(m => m.x).join(' | '),
             rendered: document.querySelectorAll('#novo-ask-log .m').length,
             renderedText: [...document.querySelectorAll('#novo-ask-log .m')].map(e => e.textContent).join(' | ') }; })()`);

  ok('control: the crypto desk DOES receive its own transcript (so the instrument works)',
    cx.n >= 1 && cx.text.indexOf('BTC funding') >= 0, JSON.stringify(cx).slice(0, 240));
  ok('crypto stays its own desk — the equity transcript is not in it',
    cx.text.indexOf('flip on SPY') < 0 && cx.renderedText.indexOf('flip on SPY') < 0,
    JSON.stringify(cx).slice(0, 240) + '  (equity holds ' + (STORE['member-alpha|equity'] || []).length + ')');
  ok('...and the equity desk did not swallow the crypto turn either',
    ((STORE['member-alpha|equity'] || []).map((m) => m.x).join(' | ')).indexOf('BTC funding') < 0,
    JSON.stringify((STORE['member-alpha|equity'] || []).map((m) => m.x)));
  ok('...the two scopes are separate keys on the server, not one bucket',
    (STORE['member-alpha|crypto'] || []).length === 1 && (STORE['member-alpha|equity'] || []).length >= 1,
    JSON.stringify(Object.fromEntries(Object.entries(STORE).map(([k, v]) => [k, v.length]))));

  // ── FAIL SOFT: with the endpoint dead, the chat must behave exactly as before. ──────────────
  const C = A;
  await C.evalIn(`window.fetch = (u, o) => String(u).indexOf('/api/chat-log') >= 0
      ? Promise.reject(new Error('offline')) : Promise.resolve(new Response('{}', {status:200}));`);
  const soft = await C.evalIn(`(async () => { try {
      await window.novoChatSync.pull('equity', 'novo_ask_log');
      window.novoChatSync.push('equity', [{r:'you',x:'offline turn',t:Date.now()}]);
      await new Promise(r => setTimeout(r, 1600));
      return { threw: false, stillThere: document.querySelectorAll('#novo-ask-log .m').length };
    } catch (e) { return { threw: true, msg: String(e) }; } })()`);
  ok('a dead endpoint never throws into the page', soft.threw === false, JSON.stringify(soft));
  ok('...and the conversation in front of the member survives it',
    soft.stillThere >= 1, JSON.stringify(soft));

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  try { A.ws.close(); B.ws.close(); } catch (_) {}
  pA.kill(); pB.kill(); server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
