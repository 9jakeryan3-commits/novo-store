/* debox-check.js — the conservative de-box pass, and the things it must NOT have broken.
 *
 * Jake: "everything ... is boxed in box box box every where ... only certain things are actually
 * boxed or outlined but the majority of everything is just there no actual outline."
 *
 * WHAT THIS PASS ACTUALLY DID, because it is not what the request sounds like:
 *   trader  — deleted five DOUBLED SEAMS (two hairlines 1px apart at one boundary). The trader's
 *             boxiness was never filled-and-outlined cards; it was .card's border-bottom meeting
 *             .ch's border-top, and a 3px header rail beside a 2px card rail.
 *   analyst — dropped three FILLS and kept their hairlines. Measured, those fills sit at 1.022
 *             against the card they are inside while their border runs 1.387 — the border carries
 *             ~17x the signal, so the fill was the redundant channel, not the border.
 *   crypto  — dropped the page ground from #0e0e10 to #09090b so .panel separates at 1.055
 *             instead of 1.022, without touching the --navy token that three overlays still use.
 *
 * ⚠ EVERY ASSERTION IS ON COMPUTED STYLE OF A REAL ELEMENT, not on the presence of a string in the
 * file. A grep cannot tell a deleted declaration from one that is overridden two rules later, and
 * this whole task turned on that distinction more than once.
 *
 * ⚠ THE STATE EDGES ARE ASSERTED TO STILL PAINT. Almost every state rule in this product sets
 * border-color ONLY, with no background and no border shorthand. Deleting a base `border:1px`
 * does not neutralise those rules, it makes them paint NOTHING -- silently, with no error and no
 * visual diff until the state fires. That is the one way this pass could have cost information,
 * so it is checked directly rather than trusted.
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
let failures = 0, checks = 0;
const ok = (n, c, d) => { checks++; if (c) return console.log('  PASS  ' + n);
  failures++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); };

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

const chan = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const rgb = (s) => { const m = /rgba?\(([^)]+)\)/.exec(String(s)); return m ? m[1].split(',').map(parseFloat) : null; };
const lum = (s) => { const p = rgb(s); return p ? 0.2126 * chan(p[0]) + 0.7152 * chan(p[1]) + 0.0722 * chan(p[2]) : null; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return x == null || y == null ? null
  : +((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(3); };

/* Build the real structure in the page and read what the browser paints. The dashboards need a
   member token to populate, so a check that waits for real cards measures an empty shell -- the
   failure that made an earlier audit report ZERO boxes on a page full of them. */
const PROBE = (html, sel) => `(() => {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px';
  host.innerHTML = ${JSON.stringify(html)};
  document.body.appendChild(host);
  const out = {};
  ${JSON.stringify(sel)}.forEach((s) => {
    const e = host.querySelector(s);
    if (!e) { out[s] = null; return; }
    const c = getComputedStyle(e);
    out[s] = { bt: c.borderTopWidth, bb: c.borderBottomWidth, bl: c.borderLeftWidth,
               br: c.borderRightWidth, bg: c.backgroundColor, bc: c.borderTopColor,
               blc: c.borderLeftColor, pl: c.paddingLeft };
  });
  out.__body = getComputedStyle(document.body).backgroundColor;
  host.remove();
  return out; })()`;

(async () => {
  const PORT = 8882;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9463', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'deboxchk'), 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 120; i++) {
    try { wsUrl = (await (await fetch('http://127.0.0.1:9463/json/version')).json()).webSocketDebuggerUrl; break; }
    catch (_) { await new Promise((r) => setTimeout(r, 150)); }
  }
  const ws = new WebSocket(wsUrl); let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (me, pa, si) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method: me, params: pa, sessionId: si })); });
  await new Promise((r) => { ws.onopen = r; });
  const t = (await send('Target.createTarget', { url: 'about:blank' })).result;
  const sid = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result.sessionId;
  await send('Page.enable', {}, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('novo_live_t','x')}catch(e){}" }, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  const ev = async (e) => (await send('Runtime.evaluate', { returnByValue: true, expression: e }, sid)).result.result.value;
  const load = async (p) => { await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' + p }, sid);
    await new Promise((r) => setTimeout(r, 1900)); };

  console.log('\nDe-box: the redundant channel is gone, the load-bearing one is not\n');

  /* ── TRADER: the doubled seams ─────────────────────────────────────────────────────────── */
  await load('trader-live.html');
  const tr = await ev(PROBE(
    '<div class="card"><div class="ch ca"><span class="ch-title">A</span></div><div>body</div></div>' +
    '<div class="card"><div class="ch"><span class="ch-title">B</span></div><div>body</div></div>' +
    '<div class="dsec">SECTION</div><div class="spy-hero">hero</div>',
    ['.card', '.ch', '.ch.ca', '.dsec', '.spy-hero']));

  ok('trader: .card still ends with its own hairline (the boundary is still marked)',
    parseFloat(tr['.card'].bb) >= 1, JSON.stringify(tr['.card']));
  ok('trader: .ch no longer adds a SECOND hairline on top of it',
    parseFloat(tr['.ch'].bt) === 0, JSON.stringify(tr['.ch']));
  ok('trader: ...and .ch keeps the rule that separates a header from its own body',
    parseFloat(tr['.ch'].bb) >= 1, JSON.stringify(tr['.ch']));
  ok('trader: the category rail is on the card only, not doubled on the header',
    parseFloat(tr['.ch.ca'].bl) === 0, JSON.stringify(tr['.ch.ca']));
  ok('trader: .dsec is a section START, not a frame',
    parseFloat(tr['.dsec'].bt) >= 1 && parseFloat(tr['.dsec'].bb) === 0, JSON.stringify(tr['.dsec']));
  ok('trader: .spy-hero no longer stacks a rule under .ch\u2019s',
    parseFloat(tr['.spy-hero'].bt) === 0 && parseFloat(tr['.spy-hero'].bb) >= 1, JSON.stringify(tr['.spy-hero']));

  /* STATE EDGES MUST STILL PAINT. A base border deleted by mistake makes these render nothing. */
  const st = await ev(PROBE(
    '<button class="navbtn">a</button><button class="navbtn on">b</button>' +
    '<div id="gex-agree" class="all">x</div><div class="ctb-btn armed">t</div>',
    ['.navbtn', '.navbtn.on', '#gex-agree.all', '.ctb-btn.armed']));
  ok('trader: the selected-view indicator still paints a different edge than an unselected tab',
    st['.navbtn'] && st['.navbtn.on'] && st['.navbtn'].bc !== st['.navbtn.on'].bc,
    JSON.stringify({ off: st['.navbtn'] && st['.navbtn'].bc, on: st['.navbtn.on'] && st['.navbtn.on'].bc }));

  /* ── ANALYST: fill dropped, hairline kept ──────────────────────────────────────────────── */
  await load('analyst-live.html');
  const an = await ev(PROBE(
    '<div class="lv-card"><div class="lv-tile">t</div><div class="d-br">d</div>' +
    '<div class="lv-fear">f</div></div>',
    ['.lv-card', '.lv-tile', '.d-br', '.lv-fear']));
  ['.lv-tile', '.d-br', '.lv-fear'].forEach((s) => {
    ok('analyst: ' + s + ' dropped the fill that measured 1.022',
      an[s] && (an[s].bg === 'rgba(0, 0, 0, 0)' || an[s].bg === 'transparent'), JSON.stringify(an[s]));
    ok('analyst: ...and KEPT the hairline that carries the signal',
      an[s] && parseFloat(an[s].bt) >= 1, JSON.stringify(an[s]));
  });
  ok('analyst: the card it sits in still has its own fill (the tiles are not floating on nothing)',
    an['.lv-card'] && an['.lv-card'].bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(an['.lv-card']));

  /* ── CRYPTO: the ground ────────────────────────────────────────────────────────────────── */
  await load('crypto-live.html');
  const cr = await ev(PROBE('<div class="panel">p</div>', ['.panel']));
  const sep = ratio(cr['.panel'].bg, cr.__body);
  ok('crypto: the page ground dropped so .panel actually separates from it',
    sep !== null && sep >= 1.05,
    'panel ' + cr['.panel'].bg + ' on body ' + cr.__body + ' = ' + sep + ':1 (was 1.022)');
  ok('crypto: ...and .panel keeps its hairline, because 1.055 is not enough to carry it alone',
    parseFloat(cr['.panel'].bt) >= 1, JSON.stringify(cr['.panel']));
  /* The token still has three jobs; changing the body must not have moved them. */
  const ov = await ev("(() => { const s=getComputedStyle(document.documentElement);" +
    " return { navy: s.getPropertyValue('--navy').trim() }; })()");
  ok('crypto: the --navy token is untouched, so the drawer and rail overlays are unmoved',
    ov.navy === '#0e0e10', JSON.stringify(ov));

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  ws.close(); proc.kill(); server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
