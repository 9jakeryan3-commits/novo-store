/* Measures the chart rail on the live trader page, desktop and phone, so "slimmer" is a number
   rather than an impression. Reuses the harness's own browser plumbing by shelling out to a tiny
   CDP session — same approach as scripts/mobile-nav-check.js. */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9337;
process.chdir(path.join(__dirname, '..'));

const server = http.createServer((req, res) => {
  let u = req.url.split('?')[0];
  if (u === '/' || u.endsWith('/live')) u = '/' + u.split('/')[1] + '-live.html';
  const f = path.join('public', u);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    const t = f.endsWith('.js') ? 'application/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { 'Content-Type': t }); res.end(d);
  });
});

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));

server.listen(8795, async () => {
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(require('os').tmpdir(), 'novo-chartmeasure'),
    '--no-first-run', '--disable-gpu', 'about:blank']);
  /* Node 24 ships a global WebSocket - the same one scripts/mobile-nav-check.js uses. */
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
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid);
  await send('Page.addScriptToEvaluateOnNewDocument',
    { source: "try{localStorage.setItem('novo_live_t','stub.token')}catch(e){}" }, sid);

  const evalIn = async (expr) => {
    const r = (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr }, sid)).result;
    return r.exceptionDetails ? { __err: String((r.exceptionDetails.exception || {}).description || '') } : r.result.value;
  };
  const goto = async (w, h, mobile) => {
    await send('Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 2, mobile: !!mobile }, sid);
    if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
    await send('Page.navigate', { url: 'http://127.0.0.1:8795/trader-live.html' }, sid);
    await new Promise((r) => setTimeout(r, 1600));
  };

  const PROBE = `(() => {
    const hero = document.querySelector('.spy-hero');
    const tb = document.getElementById('chart-toolbar');
    if (!hero) return { missing: true };
    const hr = hero.getBoundingClientRect();
    const btns = Array.from(document.querySelectorAll('.ctb-btn'))
      .filter(b => b.getBoundingClientRect().width > 0);
    const bh = btns.map(b => Math.round(b.getBoundingClientRect().height));
    const bordered = btns.filter(b => {
      const c = getComputedStyle(b);
      return ['Top','Right','Bottom','Left'].some(k =>
        parseFloat(c['border'+k+'Width']) > 0 && c['border'+k+'Style'] !== 'none');
    }).length;
    const cs = getComputedStyle(hero);
    // WHICH CHILD IS TALL. "The rail is 79px" is a symptom; the flex item that sets that height
    // is the fact. Measuring the container and then guessing at the cause is how the last four
    // hours went.
    const kids = Array.from(hero.children).map(c => ({
      cls: c.className || c.id, h: Math.round(c.getBoundingClientRect().height) }));
    return {
      heroH: Math.round(hr.height),
      heroBg: cs.backgroundImage === 'none' ? 'flat' : 'gradient',
      btnCount: btns.length,
      btnH: bh.length ? Math.max(...bh) : 0,
      borderedButtons: bordered,
      toolbarWrapped: tb ? tb.getBoundingClientRect().height > 40 : null,
      priceSize: Math.round(parseFloat(getComputedStyle(document.getElementById('t-spy')).fontSize)),
      kids: kids, pad: cs.paddingTop + '/' + cs.paddingBottom,
      // THE REAL ASSERTION: does the rail sit on ONE row? A height threshold is a proxy for this
      // and would pass a two-row rail that happened to be short.
      // ⚠ NOT offsetTop. align-items:center gives every child a different top on a SINGLE row,
      // so an offsetTop-distinct count reported "3 rows" for an unwrapped rail — a metric that
      // cannot tell the two apart. A flex row that has not wrapped is exactly as tall as its
      // tallest child, so compare against that.
      wrapped: Math.round(hr.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom))
               > Math.max.apply(null, Array.from(hero.children).map(c => c.getBoundingClientRect().height)) + 2,
      fitDebug: window.__ctbFit || null,
      // THE CHART ITSELF. Height in px and as a share of the viewport, plus whether the taller
      // pane has pushed anything off-screen — a chart that grows by shoving the tab bar past the
      // fold is not the change that was asked for.
      chartH: (function(){ var c = document.getElementById('novo-chart');
        return c ? Math.round(c.getBoundingClientRect().height) : 0; })(),
      chartPct: (function(){ var c = document.getElementById('novo-chart');
        return c ? Math.round(c.getBoundingClientRect().height / innerHeight * 100) : 0; })(),
      barBottom: (function(){ var b = document.querySelector('#mobile-tabs, .mob-tab');
        b = b && (b.id === 'mobile-tabs' ? b : b.parentElement);
        return b ? Math.round(b.getBoundingClientRect().bottom) : null; })(),
      docOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
      // WHAT ACTUALLY APPLIED, from the browser, rather than from reading the stylesheet.
      chartCss: (function(){ var c = document.getElementById('novo-chart'); if (!c) return null;
        var g = getComputedStyle(c);
        return { height: g.height, minH: g.minHeight, maxH: g.maxHeight, display: g.display,
                 inline: c.getAttribute('style') || '', parent: c.parentElement && (c.parentElement.id || c.parentElement.className) }; })(),
      // WHICH RULE WON. Reading the stylesheet by eye is how the last hour went; this walks the
      // live CSSOM for every rule that sets a height on #novo-chart and reports whether its media
      // condition currently matches. The winner is the last matching one by specificity order.
      chartRules: (function(){
        var out = [];
        for (var i = 0; i < document.styleSheets.length; i++) {
          var sh; try { sh = document.styleSheets[i].cssRules; } catch (e) { continue; }
          (function walk(rules, media){
            for (var j = 0; j < rules.length; j++) {
              var r = rules[j];
              if (r.media) { walk(r.cssRules, r.conditionText || r.media.mediaText); continue; }
              if (!r.selectorText || r.selectorText.indexOf('novo-chart') < 0) continue;
              var h = r.style && (r.style.getPropertyValue('height') || r.style.getPropertyValue('min-height'));
              if (!h) continue;
              out.push({ sel: r.selectorText.slice(0, 60), h: r.style.getPropertyValue('height'),
                         imp: r.style.getPropertyPriority('height'),
                         minH: r.style.getPropertyValue('min-height'),
                         media: media || '(none)',
                         matches: media ? matchMedia(media).matches : true });
            }
          })(sh, null);
        }
        return out; })(),
      folded: tb ? tb.classList.contains('ctb-compact') : null,
    }; })()`;

  await goto(1600, 1000, false);
  const desk = await evalIn(PROBE);
  await goto(430, 900, true);
  const phone = await evalIn(PROBE);

  console.log('\nCHART RAIL — measured, not eyeballed\n');
  console.log('  desktop 1600:', JSON.stringify(desk));
  console.log('  phone    430:', JSON.stringify(phone));
  let bad = 0;
  const ok = (n, c, d) => { console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '  ' + d)); if (!c) bad++; };
  ok('the rail sits on ONE row on desktop', desk.wrapped === false,
     JSON.stringify({ h: desk.heroH, kids: desk.kids, fit: desk.fitDebug, folded: desk.folded }));
  ok('...and is thin (<= 52px)', desk.heroH <= 52, 'h=' + desk.heroH);
  ok('...and flat, not a gradient band', desk.heroBg === 'flat', desk.heroBg);
  ok('no toolbar button draws a border', desk.borderedButtons === 0 && phone.borderedButtons === 0,
     JSON.stringify({ d: desk.borderedButtons, p: phone.borderedButtons }));
  ok('buttons stay tappable on a phone (>= 28px)', phone.btnH >= 28, 'h=' + phone.btnH);
  ok('the desktop toolbar still fits on one line', desk.toolbarWrapped === false, String(desk.toolbarWrapped));
  ok('the price is still the loudest thing on the rail', desk.priceSize >= 19, String(desk.priceSize));
  ok('the mobile chart is ~74% of the viewport', phone.chartPct >= 70 && phone.chartPct <= 78,
     JSON.stringify({ pct: phone.chartPct, px: phone.chartH, vh: 900 }));
  ok('...and the tab bar is still on screen, not pushed past the fold',
     phone.barBottom !== null && phone.barBottom <= 902, String(phone.barBottom));
  ok('...and nothing scrolls sideways', phone.docOverflowX === false, String(phone.docOverflowX));
  console.log('\n' + (bad ? 'FAIL ' + bad : 'OK') + '\n');
  try { proc.kill(); } catch (_) {}
  server.close();
  process.exit(bad ? 1 : 0);
});
