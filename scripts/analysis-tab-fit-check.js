/* analysis-tab-fit-check.js — the trader Analysis tab is a scrolling document and nothing is cut.
 *
 * Jake, 2026-09-06, after two failed attempts at this: "i see no difference maybe worse. fix the
 * damn tab... make it all fit and look right." And: "this is not the analysis tab of a $200
 * product."
 *
 * ⚠ THIS FILE ASSERTS THE OPPOSITE OF WHAT IT ASSERTED THIS MORNING, ON PURPOSE. The first version
 * checked that each panel could scroll its own overflow -- it passed 16/16 while the tab was still
 * visibly broken, because "the content is reachable if you find the scrollbar inside the panel" was
 * never what Jake asked for. The model changed: the Analysis tab is reading material, so the PAGE
 * scrolls and every panel is its content's full height. The check now says exactly that, and the
 * old assertions would fail against it.
 *
 * ⚠ PANELS ARE FILLED FIRST. An empty tab fits at any height and hides nothing.
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

const FILL = `(() => {
  const set = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
  set('intel-output', Array.from({length: 40}, (_, i) =>
    'LEVEL ' + (7700 + i * 3) + '.25 (PML) SUPPORT ' + (7711 + i) + '.75 (LOCAL LOW)').join('<br>'));
  set('read2-body', '<p>' + Array.from({length: 14}, () =>
    'Gamma Flip = where dealer hedging flips from dampening to amplifying moves. Call/Put Walls are the largest call/put gamma strikes.').join('</p><p>') + '</p>');
  const lf = document.getElementById('line-feed');
  if (lf) lf.innerHTML = Array.from({length: 12}, (_, i) =>
    '<div style="padding:8px 0">Confirmed break ' + i + ' -- SPY held beyond 770.3' + i + '.</div>').join('');
  const tb = document.querySelector('#b3-table tbody');
  if (tb) tb.innerHTML = ['SPOT','NET GEX /1%','GAMMA FLIP','CALL WALL','PUT WALL','GRAVITY',
    'EXP. MOVE','SKEW PUT-CALL','0DTE BOOK','CHARM /DAY','VANNA','RVOL','TAPE IMBALANCE']
    .map(k => '<tr><td>' + k + '</td><td>770.19</td><td>718.96</td><td>296.01</td></tr>').join('');
  const rows = (n) => Array.from({length: n}, (_, i) =>
    '<div class="brain-row"><span class="bl">Metric ' + i + '</span><span class="bv">+0.0' + i + '%</span></div>').join('');
  ['brain-setup','brain-record','brain-today'].forEach((id, j) => {
    const e = document.getElementById(id);
    if (e) e.insertAdjacentHTML('beforeend', rows([14, 18, 12][j]));
  });
  const bc = document.getElementById('card-brain');
  if (bc) bc.classList.remove('brain-empty');
  return true; })()`;

const MEASURE = `(() => {
  const inner = { 'card-intel':'.log-area', 'card-read':'.read2-body', 'card-line':'.lf-area',
                  'card-board':'.b3-wrap', 'card-brain':'.brain-grid' };
  const ws = document.getElementById('workspace');
  const panels = Object.keys(inner).map(id => {
    const c = document.getElementById(id);
    if (!c) return { id, missing: true };
    const r = c.getBoundingClientRect();
    const s = c.querySelector(inner[id]);
    return { id, h: Math.round(r.height),
      // a panel is CUT when its own box is shorter than the content inside it
      cut: Math.max(0, c.scrollHeight - c.clientHeight),
      innerCut: s ? Math.max(0, s.scrollHeight - s.clientHeight) : 0,
      innerScrolls: s ? ['auto','scroll'].includes(getComputedStyle(s).overflowY) : false };
  });
  const tb = document.getElementById('topbar'), sh = document.getElementById('saas-header');
  return { vh: innerHeight, doc: document.documentElement.scrollHeight,
           wsH: ws ? Math.round(ws.getBoundingClientRect().height) : 0,
           topbarPos: tb ? getComputedStyle(tb).position : null,
           stripPos: sh ? getComputedStyle(sh).position : null,
           panels }; })()`;

(async () => {
  const PORT = 8854;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9433', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'anafit'), 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 120; i++) {
    try { wsUrl = (await (await fetch('http://127.0.0.1:9433/json/version')).json()).webSocketDebuggerUrl; break; }
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
  const ev = async (e) => (await send('Runtime.evaluate', { returnByValue: true, expression: e }, sid)).result.result.value;

  const openTab = async (vh) => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: vh, deviceScaleFactor: 1, mobile: false }, sid);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/trader-live.html' }, sid);
    await new Promise((r) => setTimeout(r, 1900));
    await ev("window.setView('feeds')");
    await new Promise((r) => setTimeout(r, 700));
    await ev(FILL);
    await new Promise((r) => setTimeout(r, 700));
    return ev(MEASURE);
  };

  console.log('\nAnalysis tab: a scrolling document, nothing cut\n');

  for (const vh of [1040, 900, 700]) {
    const v = await openTab(vh);

    ok(vh + 'px: the PAGE scrolls — the tab is not pinned to the viewport',
      v.doc > v.vh + 4, 'document=' + v.doc + ' viewport=' + v.vh + ' workspace=' + v.wsH);

    /* THE CORE CLAIM. Every panel is its content's height. This is what "make it all fit" means,
       and it is the assertion the previous version of this file got wrong: it accepted a cut panel
       so long as the panel could be scrolled inside. */
    v.panels.forEach((c) => {
      if (c.missing) return ok(vh + 'px: ' + c.id + ' exists', false, 'not in the DOM');
      if (c.id === 'card-intel') {
        /* The one deliberate exception: an unbounded session log. It is allowed to be shorter than
           its content precisely BECAUSE it can scroll, so both halves are asserted together. */
        return ok(vh + 'px: card-intel is the one bounded panel, and it scrolls',
          c.innerScrolls, JSON.stringify(c));
      }
      ok(vh + 'px: ' + c.id + ' shows all of its content, nothing cut',
        c.cut <= 2 && c.innerCut <= 2, JSON.stringify(c));
    });

    ok(vh + 'px: the topbar and market strip stay put while the reading scrolls',
      v.topbarPos === 'sticky' && v.stripPos === 'sticky',
      'topbar=' + v.topbarPos + ' strip=' + v.stripPos);
  }

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  if (process.env.SHOT) {
    const out = process.env.SHOT_DIR || os.tmpdir();
    const v = await openTab(1040);
    const png = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1920, height: Math.min(v.doc, 4000), scale: 0.5 } }, sid)).result;
    fs.writeFileSync(path.join(out, 'analysis-tab.png'), Buffer.from(png.data, 'base64'));
    console.log('  .. shot -> ' + path.join(out, 'analysis-tab.png'));
  }
  ws.close(); proc.kill(); server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
