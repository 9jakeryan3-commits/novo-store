/* analysis-tab-fit-check.js — the trader Analysis tab fits, and everything it hides is reachable.
 *
 * Jake, 2026-09-06: "the trader analysis tab needs serious layout work...missing scrollers,
 * fitment and such."
 *
 * ⚠ THE PANELS ARE FILLED BEFORE ANYTHING IS MEASURED. An empty Analysis tab fits at every height
 * and hides nothing, so a check that loads the page and measures it passes while the tab is
 * visibly broken -- which is how this survived an earlier inventory pass on this very session.
 * The fill below is sized from Jake's screenshot.
 *
 * The three defects this locks down, all measured at a 1040px viewport (his 1080px window less
 * Chrome's own chrome):
 *   1. the brain row was `auto`, so What Dr. NoVo Knows took its full 498px content height and
 *      starved the feed row to 241px and the Line/Books row to 217px;
 *   2. .brain-grid only scrolled below a max-height:1010px media query, so at 1040 its overflow
 *      was unreachable -- clipped, with nothing to drag;
 *   3. #workspace was overflow:hidden despite a comment promising it scrolled, so once the rows
 *      hit their floors the bottom panel was simply cut off.
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
  const out = Object.keys(inner).map(id => {
    const c = document.getElementById(id);
    if (!c) return { id, missing: true };
    const r = c.getBoundingClientRect();
    const s = c.querySelector(inner[id]);
    const cs = s ? getComputedStyle(s) : null;
    return { id, h: Math.round(r.height),
      onScreen: r.width > 0 && r.height > 0,
      belowFold: r.bottom > innerHeight + 2 ? Math.round(r.bottom - innerHeight) : 0,
      hidden: s ? Math.max(0, s.scrollHeight - s.clientHeight) : 0,
      scrolls: cs ? (cs.overflowY === 'auto' || cs.overflowY === 'scroll') : false,
      barW: s ? Math.round(s.offsetWidth - s.clientWidth) : 0 };
  });
  const rows = ws ? getComputedStyle(ws).gridTemplateRows.split(' ').map(parseFloat) : [];
  return { vh: innerHeight, rows,
           wsScrollable: ws ? Math.max(0, ws.scrollHeight - ws.clientHeight) : 0,
           wsOverflowY: ws ? getComputedStyle(ws).overflowY : null, out }; })()`;

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
    await new Promise((r) => setTimeout(r, 600));
    return ev(MEASURE);
  };

  console.log('\nAnalysis tab: fitment and scrollers\n');

  /* ── Jake's own viewport ─────────────────────────────────────────────────────────────────── */
  const v = await openTab(1040);
  const rows = v.rows.filter((n) => n > 0);
  const total = rows.reduce((a, b) => a + b, 0);
  const biggest = Math.max.apply(null, rows);

  /* NO ROW EATS THE VIEW. Stated as a share of the grid rather than a pixel ceiling, because the
     defect was proportional: What Dr. NoVo Knows took 498 of 958px and left the feed 241. Three
     content rows means an even split is 33% each; 45% allows a deliberately dominant row and still
     fails the 52% the brain row was taking. */
  ok('no single row takes over the tab (the brain row was taking 52%)',
    biggest / total < 0.45,
    'rows=' + rows.map(Math.round).join(' / ') + '  biggest=' + Math.round(100 * biggest / total) + '%');

  /* Everything hidden must be reachable. This is the whole of "missing scrollers": a panel may hide
     content, but never without a way to get at it. */
  v.out.forEach((c) => {
    if (c.missing) return ok(c.id + ': panel exists', false, 'not in the DOM');
    ok(c.id + ': on screen, not pushed below the fold',
      c.onScreen && !c.belowFold, JSON.stringify(c));
    if (c.hidden > 4) {
      ok(c.id + ': hides ' + c.hidden + 'px and can be scrolled to it',
        c.scrolls, JSON.stringify(c));
      /* A 4px bar of #1e3255 on a near-black panel is present and unseeable, which is what made
         parked content read as cut content. The bar has to be findable, not merely to exist. */
      ok(c.id + ': ...and the scrollbar is wide enough to see and grab',
        c.barW >= 8, JSON.stringify(c));
    }
  });

  /* ── The safety net, at a height where the rows cannot all fit ───────────────────────────── */
  for (const vh of [700, 600]) {
    const s = await openTab(vh);
    ok(vh + 'px tall: the tab itself scrolls once the rows hit their floors',
      s.wsScrollable > 0 && s.wsOverflowY !== 'hidden',
      'workspace overflow-y=' + s.wsOverflowY + ' scrollable=' + s.wsScrollable +
      ' rows=' + s.rows.filter((n) => n > 0).map(Math.round).join(' / '));
    const stranded = s.out.filter((c) => !c.missing && c.hidden > 4 && !c.scrolls);
    ok(vh + 'px tall: ...and no panel is left holding content nothing can reach',
      stranded.length === 0, JSON.stringify(stranded));
  }

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  if (process.env.SHOT) {
    const out = process.env.SHOT_DIR || os.tmpdir();
    await openTab(1040);
    const png = (await send('Page.captureScreenshot', { format: 'png' }, sid)).result;
    fs.writeFileSync(path.join(out, 'analysis-tab-1040.png'), Buffer.from(png.data, 'base64'));
    console.log('  .. shot -> ' + path.join(out, 'analysis-tab-1040.png'));
  }
  ws.close(); proc.kill(); server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
