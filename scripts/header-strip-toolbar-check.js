/* header-strip-toolbar-check.js — Jake's 2026-09-06 layout round, on all three dashboards.
 *
 *   "move the novo chat button and command buttons over beside the logo wordmark... and the chart
 *    and analysis buttons over beside the market indicator. seperated."
 *   "both analyst and crypto just need the command button moved over beside the settings buttons."
 *   "what if the strip just scrolled like a market strip does anywhere else?"
 *   "the chart tool bar needs the same tools menu as mobile on desktop to smaller monitors crunch"
 *
 * Every assertion here is GEOMETRIC and RELATIVE, because that is the only kind that can fail. A
 * check that the markup contains #saas-nav-l passes while the cluster renders on the far side of
 * the bar; "beside the wordmark" is a statement about distance, so distance is what gets measured.
 *
 * ⚠ THE STRIP IS FILLED BEFORE IT IS MEASURED. It loads with em-dash placeholders that fit at any
 * width, so an unfilled strip proves nothing about overflow — that is exactly how the wrap bug
 * survived earlier passes.
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
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

/* Realistic values, from Jake's own screenshot. Long enough that the strip genuinely overflows a
   narrow bar — which is the condition under test. */
const FILL = `(() => {
  const mi = document.getElementById('card-mktintel'); if (!mi) return 0;
  const vals = ['Off-hrs','Off-hrs','Off-hrs','Off-hrs','-149.54M','61st pct of 33d',
                '98% of book \\u00b7 pin 768.00','+8.68B','-150.5M','14.52'];
  let i = 0;
  Array.from(mi.querySelectorAll('.dr, .bar-row')).forEach((row) => {
    const sp = row.querySelectorAll('span, b, div');
    const last = sp.length ? sp[sp.length - 1] : null;
    if (last && i < vals.length) last.textContent = vals[i++];
  });
  return i; })()`;

(async () => {
  const PORT = 8842;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9421', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'hstchk'), 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 120; i++) {
    try { wsUrl = (await (await fetch('http://127.0.0.1:9421/json/version')).json()).webSocketDebuggerUrl; break; }
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
  const ev = async (e) => (await send('Runtime.evaluate', { returnByValue: true, expression: e, awaitPromise: true }, sid)).result.result.value;
  const load = async (page, w, fill) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 950, deviceScaleFactor: 1, mobile: false }, sid);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' + page }, sid);
    await new Promise((r) => setTimeout(r, 1500));
    if (fill) { await ev(FILL); await new Promise((r) => setTimeout(r, 1400)); }  // let the 1s re-measure tick run
  };

  const BOX = `const B = s => { const e = typeof s === 'string' ? document.querySelector(s) : s;
    if (!e) return null; const r = e.getBoundingClientRect();
    return r.width ? { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) } : null; };`;

  console.log('\nHeader clusters, scrolling strip, folding toolbar\n');

  /* ── 1. TRADER: two clusters, at OPPOSITE ends ─────────────────────────────────────────────── */
  await load('trader-live.html', 1600, false);
  const h = await ev(`(() => { ${BOX}
    return { vw: innerWidth, brand: B('.tb-brand'), novo: B('.navbtn-novo'),
             hint: B('#novo-keys-hint'), chart: B('.navbtn[data-v="overview"]'),
             analysis: B('.navbtn[data-v="feeds"]'), sess: B('#hdr-session-ts'),
             novoCount: document.querySelectorAll('.navbtn-novo').length,
             hintCount: document.querySelectorAll('#novo-keys-hint').length }; })()`);

  ok('trader: Dr. NoVo sits beside the wordmark, not across the bar',
    h.novo && h.brand && (h.novo.l - h.brand.r) < 60 && h.novo.l < h.vw / 3,
    JSON.stringify(h));
  ok('trader: the command buttons sit with Dr. NoVo',
    h.hint && h.novo && (h.hint.l - h.novo.r) < 40, JSON.stringify(h));
  ok('trader: Chart/Analysis sit against the session readout, at the other end',
    h.chart && h.sess && h.analysis && (h.sess.l - h.analysis.r) < 60 && h.chart.l > h.vw / 2,
    JSON.stringify(h));
  /* SEPARATED is the actual word Jake used, twice. Two clusters that drifted back together would
     satisfy every "is beside" test above, so the gap between them is asserted on its own. */
  ok('trader: the two clusters are SEPARATED, not one group',
    h.hint && h.chart && (h.chart.l - h.hint.r) > h.vw / 4, JSON.stringify(h));
  ok('trader: exactly one Dr. NoVo button and one hint (the split did not duplicate)',
    h.novoCount === 1 && h.hintCount === 1, JSON.stringify(h));

  /* ── 2. THE STRIP: one row at every width, and it says when it is cut ──────────────────────── */
  for (const w of [1920, 1440, 1152, 1024, 900]) {
    await load('trader-live.html', w, true);
    const s = await ev(`(() => { ${BOX}
      const mi = document.getElementById('card-mktintel');
      const tops = new Set();
      Array.from(mi.querySelectorAll('.dr, .bar-row')).forEach(c => {
        const r = c.getBoundingClientRect(); if (r.width > 0) tops.add(Math.round(r.top)); });
      const over = mi.scrollWidth - mi.clientWidth;
      const cs = getComputedStyle(mi);
      return { rows: tops.size, over, wrap: cs.flexWrap, ox: cs.overflowX,
               canScroll: mi.classList.contains('can-scroll'),
               edge: ['at-start','at-mid','at-end'].filter(c => mi.classList.contains(c)).join('+') }; })()`);

    ok(w + 'px: the strip is ONE row — nothing can be orphaned onto a second',
      s.rows === 1, JSON.stringify(s));
    /* The fade and the pan only exist when there is something off-screen; asserting them
       unconditionally would fail on a wide screen for the right reason and teach nothing. */
    if (s.over > 2) ok(w + 'px: ...and it declares itself scrollable, with the cut edge marked',
      s.canScroll && s.edge === 'at-start' && s.ox === 'auto', JSON.stringify(s));
    else ok(w + 'px: ...and claims no scroll, because it all fits',
      !s.canScroll && s.over <= 2, JSON.stringify(s));
  }

  /* Panning must actually move it — a scroll container nothing can drive is a clipped strip with
     extra CSS. Driven through the same wheel path a trackpad uses. */
  await load('trader-live.html', 1024, true);
  const pan = await ev(`(() => {
    const mi = document.getElementById('card-mktintel');
    const before = mi.scrollLeft;
    mi.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    return { before, after: mi.scrollLeft, max: mi.scrollWidth - mi.clientWidth }; })()`);
  ok('the strip actually pans on a plain wheel (no shift key, no visible scrollbar)',
    pan.after > pan.before, JSON.stringify(pan));
  const edge = await ev(`(() => { const mi = document.getElementById('card-mktintel');
    mi.scrollLeft = mi.scrollWidth;
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() =>
      r({ edge: ['at-start','at-mid','at-end'].filter(c => mi.classList.contains(c)).join('+') })))); })()`);
  ok('...and the fade follows the scroll to the far end',
    edge && edge.edge === 'at-end', JSON.stringify(edge));

  /* ── 3. THE TOOLBAR: never two rows; folded means TOOLS works ──────────────────────────────── */
  for (const w of [1920, 1600, 1440, 1152, 900]) {
    await load('trader-live.html', w, false);
    const tbv = await ev(`(() => { ${BOX}
      const tb = document.getElementById('chart-toolbar');
      const tops = new Set();
      Array.from(tb.querySelectorAll('.ctb-btn')).forEach(b => {
        const r = b.getBoundingClientRect(); if (r.width > 0) tops.add(Math.round(r.top)); });
      return { rows: tops.size, compact: tb.classList.contains('ctb-compact'),
               more: B('#ctb-more') ? 'shown' : 'hidden',
               tools: B('#ctb-tools') ? 'shown' : 'hidden' }; })()`);

    /* The invariant, stated so it can fail either way: unfolded means it genuinely fits on one row;
       folded means the fold is REACHABLE. A bar that wrapped without folding fails the first; a bar
       that folded but hid its own TOOLS button fails the second. */
    if (tbv.compact) ok(w + 'px: toolbar folded, and TOOLS is there to open it',
      tbv.more === 'shown' && tbv.tools === 'hidden', JSON.stringify(tbv));
    else ok(w + 'px: toolbar unfolded because it genuinely fits on one row',
      tbv.rows === 1 && tbv.tools === 'shown', JSON.stringify(tbv));
  }

  await load('trader-live.html', 1600, false);
  const opened = await ev(`(() => { ${BOX}
    const tb = document.getElementById('chart-toolbar');
    if (!tb.classList.contains('ctb-compact')) return { skip: true };
    document.getElementById('ctb-more').click();
    const t = B('#ctb-tools'), g = B('#ctb-tog');
    return { open: tb.classList.contains('tools-open'), tools: !!t, tog: !!g,
             n: Array.from(tb.querySelectorAll('.ctb-btn')).filter(b => b.getBoundingClientRect().width > 0).length }; })()`);
  ok('clicking TOOLS on a folded desktop bar reveals the drawing tools AND the overlays',
    opened.skip ? true : (opened.open && opened.tools && opened.tog && opened.n > 15),
    JSON.stringify(opened));
  if (opened.skip) console.log('        (skipped: the bar fit at 1600px in this environment)');

  /* ── 4. ANALYST + CRYPTO: the hint rides beside Settings ───────────────────────────────────── */
  for (const page of ['analyst-live.html', 'crypto-live.html']) {
    await load(page, 1600, false);
    const g = await ev(`(() => { ${BOX}
      const hint = B('#novo-keys-hint'), gear = B('.lv-gear');
      // The gear's OWN PARENT, not a guessed 'header, .lv-head' selector -- that matched a
      // zero-width element on analyst, B() returned null for it, and the assertion below failed
      // on a page that was laid out correctly. An instrument that cannot see the thing it is
      // asked about reports a defect in the subject.
      const hd = document.querySelector('.lv-gear');
      return { vw: innerWidth, hint, gear, hdr: hd ? B(hd.parentElement) : null }; })()`);
    ok(page + ': the command buttons sit right beside Settings',
      g.hint && g.gear && (g.gear.l - g.hint.r) < 24 && g.gear.l > g.hint.l, JSON.stringify(g));
    /* Both must be at the RIGHT END. If the auto margin were simply deleted rather than moved, the
       pair would sit together in the middle of the header and pass the adjacency test alone. */
    ok(page + ': ...and the pair is still anchored to the right edge',
      g.gear && g.hdr && (g.hdr.r - g.gear.r) < 40 && g.gear.r > g.vw * 0.9, JSON.stringify(g));
  }

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  if (process.env.SHOT) {
    const out = process.env.SHOT_DIR || os.tmpdir();
    for (const [page, w] of [['trader-live.html', 1600], ['trader-live.html', 1024],
                             ['analyst-live.html', 1600], ['crypto-live.html', 1600]]) {
      await load(page, w, true);
      const png = (await send('Page.captureScreenshot',
        { format: 'png', clip: { x: 0, y: 0, width: w, height: 210, scale: 1 } }, sid)).result;
      fs.writeFileSync(path.join(out, 'hdr-' + w + '-' + page.replace('.html', '') + '.png'), Buffer.from(png.data, 'base64'));
    }
    console.log('  .. shots -> ' + out);
  }
  ws.close(); proc.kill(); server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
