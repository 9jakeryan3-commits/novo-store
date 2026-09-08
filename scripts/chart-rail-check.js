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

  /* userGesture:true — requestFullscreen is gesture-gated, and without it the promise rejects
     and a fullscreen test silently "passes" by never entering fullscreen at all. */
  const evalGesture = async (expr) => {
    const r = (await send('Runtime.evaluate',
      { returnByValue: true, awaitPromise: true, userGesture: true, expression: expr }, sid)).result;
    return r.exceptionDetails ? { __err: String((r.exceptionDetails.exception || {}).description || '') } : r.result.value;
  };
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
      chartBottom: (function(){ var c = document.getElementById('novo-chart');
        return c ? Math.round(c.getBoundingClientRect().bottom) : 0; })(),
      // THE SHEET. Collapsed it shows its handle and nothing else; the cards it swallowed must
      // actually be inside it, or the chart tab just lost content instead of reorganising it.
      sheet: (function(){ var sh = document.getElementById('chart-sheet');
        if (!sh) return null; var r = sh.getBoundingClientRect();
        var hnd = sh.querySelector('.sh-handle');
        return { top: Math.round(r.top), visible: Math.round(innerHeight - r.top),
                 handleH: hnd ? Math.round(hnd.getBoundingClientRect().height) : 0,
                 open: sh.classList.contains('open'),
                 kids: sh.querySelectorAll('.sh-body > *').length,
                 kidList: Array.from(sh.querySelectorAll('.sh-body > *')).map(function(k){
                   return (k.id || k.className || k.tagName) + ':' + Math.round(k.getBoundingClientRect().height); }),
                 hasIntel: !!sh.querySelector('#card-mktintel'),
                 chartInside: !!sh.querySelector('#novo-chart') }; })(),
      // THE CHART ITSELF MUST NOT BE A BOX. Border, radius and shadow on the biggest surface in
      // the app, plus the inset margin that framed it — all four are what fullscreen inherits.
      chartBox: (function(){ var c = document.getElementById('novo-chart'); if (!c) return null;
        var g = getComputedStyle(c);
        var sides = ['Top','Right','Bottom','Left'].filter(function(k){
          return parseFloat(g['border'+k+'Width']) > 0 && g['border'+k+'Style'] !== 'none'; });
        var wrap = c.closest('#card-spy > div');
        return { sides: sides.length, radius: parseFloat(g.borderTopLeftRadius) || 0,
                 shadow: g.boxShadow && g.boxShadow !== 'none',
                 wrapMargin: wrap ? getComputedStyle(wrap).marginLeft : 'n/a',
                 left: Math.round(c.getBoundingClientRect().left),
                 right: Math.round(innerWidth - c.getBoundingClientRect().right) }; })(),
      colKids: (function(){ var c = document.getElementById('col-intel');
        return c ? Array.from(c.children).map(function(k){
          return (k.id || k.className || k.tagName) + ':' + Math.round(k.getBoundingClientRect().height); }) : null; })(),
      intelWhere: (function(){ var e = document.getElementById('card-mktintel');
        if (!e) return 'absent';
        var path = [], n = e;
        while (n && n !== document.body) { path.push(n.id || n.className || n.tagName); n = n.parentElement; }
        return path.join(' < '); })(),
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
  /* SHORT PHONES ARE THE CASE THAT BREAKS. A min-height floor beats a percentage on any viewport
     small enough, so the pane that lands perfectly on a tall handset can overhang the fold on an
     SE. Measure the real spread rather than trusting one device. */
  const sizes = [[375, 667, 'iPhone SE'], [390, 844, 'iPhone 14'], [412, 915, 'Pixel 7'], [430, 932, 'Pro Max']];
  const fleet = [];
  for (const [w, h, name] of sizes) {
    await goto(w, h, true);
    await evalIn('try{window.sizeChartToPhone()}catch(e){}');
    await new Promise((r) => setTimeout(r, 250));
    const d = await evalIn(PROBE);
    // PEEK: how much non-chart surface is left below the pane and above the tab bar. This is the
    // scroll handle, and a chart that fills it perfectly is a chart the page cannot be scrolled
    // past — so it is asserted, not merely observed.
    fleet.push({ name, w, h, chart: d.chartH, pct: d.chartPct, bottom: d.chartBottom,
                 peek: (h - 52) - d.chartBottom, over: d.chartBottom > h - 52 });
  }
  console.log(String.fromCharCode(10) + '  fleet:'); fleet.forEach(f => console.log('   ', JSON.stringify(f)));

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

  /* THE FLEET. One handset is not evidence: the height that landed perfectly on a tall phone
     overhung the fold on an SE by 62px, and only measuring the spread showed it. */
  ok('the chart clears the tab bar on every phone size, short ones included',
     fleet.every((f) => !f.over), JSON.stringify(fleet.filter((f) => f.over)));
  ok('...and leaves the SAME grabbable strip below it on all of them',
     new Set(fleet.map((f) => f.peek)).size === 1 && fleet[0].peek >= 40,
     JSON.stringify(fleet.map((f) => f.name + ':' + f.peek)));
  ok('...with the chart still the dominant thing on screen (>= 58%)',
     fleet.every((f) => f.pct >= 58), JSON.stringify(fleet.map((f) => f.name + ':' + f.pct + '%')));

  /* THE SHEET actually holds the intel. The first build moved whatever happened to be a sibling
     at that instant and caught a single status card, leaving the panels in place — a tab that
     looks reorganised while nothing moved. Assert the content, not the container. */
  ok('the intel sheet exists, collapsed, showing only its handle',
     !!phone.sheet && phone.sheet.open === false && phone.sheet.handleH >= 40
       && phone.sheet.visible <= phone.sheet.handleH + 56,
     JSON.stringify(phone.sheet));
  ok('...and it actually swallowed the Market Intel panel',
     !!phone.sheet && phone.sheet.hasIntel === true,
     JSON.stringify(phone.sheet && phone.sheet.kidList));
  ok('the chart is not a box on DESKTOP either — the objection was to the box, not to its size',
     !!desk.chartBox && desk.chartBox.sides === 0 && desk.chartBox.radius === 0
       && desk.chartBox.shadow === false,
     JSON.stringify(desk.chartBox));
  ok('the chart is not a box: no border, no radius, no shadow',
     !!phone.chartBox && phone.chartBox.sides === 0 && phone.chartBox.radius === 0
       && phone.chartBox.shadow === false,
     JSON.stringify(phone.chartBox));
  ok('...and it runs edge to edge on a phone',
     !!phone.chartBox && phone.chartBox.left <= 1 && phone.chartBox.right <= 1,
     JSON.stringify(phone.chartBox && { l: phone.chartBox.left, r: phone.chartBox.right, m: phone.chartBox.wrapMargin }));
  /* FULLSCREEN, ACTUALLY ENTERED. The complaint was that the button did not fill the screen, so
     asserting the CSS exists would be asserting the wrong thing — enter it and measure the pane. */
  await goto(412, 915, true);
  const fs = await evalGesture(`(async () => {
    const card = document.getElementById('card-spy');
    if (!card || !card.requestFullscreen) return { unsupported: true };
    try { await card.requestFullscreen(); } catch (e) { return { rejected: String(e && e.message) }; }
    await new Promise(r => setTimeout(r, 400));
    const c = document.getElementById('novo-chart');
    const r = c.getBoundingClientRect();
    const out = { entered: !!document.fullscreenElement, h: Math.round(r.height),
                  vh: innerHeight, covers: Math.round(r.height / innerHeight * 100) };
    try { await document.exitFullscreen(); } catch (e) {}
    return out; })()`);
  if (fs && (fs.unsupported || fs.rejected)) {
    console.log('  SKIP  fullscreen not available in this browser context: ' + JSON.stringify(fs));
  } else {
    ok('fullscreen actually fills the screen with the chart (>= 80% of it)',
       fs.entered === true && fs.covers >= 80, JSON.stringify(fs));
  }

  ok('...and the chart did NOT get swept into it',
     !!phone.sheet && phone.sheet.chartInside === false, JSON.stringify(phone.sheet && phone.sheet.chartInside));
  /* ══ THE DESK PANEL ══════════════════════════════════════════════════════════════════════
     Jake, 2026-09-07: option 2 "if its collapsible..not interested in permanently losing chart
     view." So the assertions are about the COST: the chart's width with the panel closed must be
     what it was before the panel existed, and every surface must actually be reachable. */
  await goto(1600, 1000, false);
  const deskShut = await evalIn(`(() => {
    const rail = document.getElementById('desk-rail');
    const chart = document.getElementById('novo-chart');
    return { rail: !!rail && rail.getBoundingClientRect().width > 20,
             buttons: document.querySelectorAll('#desk-rail button').length,
             open: !!document.body.getAttribute('data-desk'),
             chartW: chart ? Math.round(chart.getBoundingClientRect().width) : 0 }; })()`);
  ok('the desk rail is there on desktop, one button per surface',
     deskShut.rail === true && deskShut.buttons === 9, JSON.stringify(deskShut));
  ok('...and it starts CLOSED — the chart keeps its width until you ask',
     deskShut.open === false && deskShut.chartW > 300, JSON.stringify(deskShut));
  /* ⚠ THE CHECK THAT WOULD HAVE CAUGHT IT. The first version asserted the chart's width and
     nothing else, and passed while nine panel columns poured their contents into the desktop
     grid - the desktop terminal flattens .col with `display: contents !important`, so a plain
     `#col-x { display: none }` lost to it and the element vanished while its CHILDREN stayed.
     "Is it hidden" asked of the element says yes; the page says otherwise. So ask for RENDERED
     BOXES instead: with the panel closed, none of the nine may occupy any space at all. */
  const leak = await evalIn(`(() => {
    const names = ['alerts','digest','predict','readings','futures','history','flow','sweeps','read'];
    const bad = [];
    names.forEach((n) => {
      const c = document.getElementById('col-' + n);
      if (!c) return;
      const boxes = [c, ...c.querySelectorAll('*')]
        .filter((e) => e.getBoundingClientRect().height > 4).length;
      if (boxes) bad.push(n + ':' + boxes);
    });
    return { leaking: bad }; })()`);
  ok('...and NOTHING from the nine renders while it is closed',
     leak.leaking.length === 0, JSON.stringify(leak));

  const deskOpen = await evalIn(`(() => {
    deskOpen('futures');
    return new Promise((r) => setTimeout(() => {
      const col = document.getElementById('col-futures');
      const chart = document.getElementById('novo-chart');
      r({ open: document.body.getAttribute('data-desk'),
          shown: col ? getComputedStyle(col).display !== 'none' : false,
          panelW: col ? Math.round(col.getBoundingClientRect().width) : 0,
          // Assert real CONTENT, not a class: mount() adds its class to the target itself, so
          // the descendant selector I first wrote could never match even on a perfect mount.
          hasContent: (document.querySelector('#col-futures-body') || {}).textContent
            ? document.querySelector('#col-futures-body').textContent.trim().length > 40 : false,
          chartW: chart ? Math.round(chart.getBoundingClientRect().width) : 0 }); }, 500)); })()`);
  ok('...opening one shows that surface, with its content mounted',
     deskOpen.open === 'futures' && deskOpen.shown === true && deskOpen.panelW > 300
       && deskOpen.hasContent === true,
     JSON.stringify(deskOpen));
  ok('...and the chart gives up room rather than being covered by it',
     deskOpen.chartW < deskShut.chartW,
     JSON.stringify({ closed: deskShut.chartW, open: deskOpen.chartW }));

  const deskShut2 = await evalIn(`(() => {
    deskOpen('futures');
    return new Promise((r) => setTimeout(() => {
      const chart = document.getElementById('novo-chart');
      r({ open: document.body.getAttribute('data-desk'),
          chartW: chart ? Math.round(chart.getBoundingClientRect().width) : 0 }); }, 500)); })()`);
  /* THE WHOLE CONDITION HE SET. If closing does not return the width exactly, the panel is a
     permanent cost dressed as a toggle. */
  ok('...and clicking it again closes it, giving the chart back every pixel',
     !deskShut2.open && deskShut2.chartW === deskShut.chartW,
     JSON.stringify({ before: deskShut.chartW, after: deskShut2.chartW }));

  const reach = await evalIn(`(async () => {
    const names = [...document.querySelectorAll('#desk-rail button')].map((b) => b.dataset.desk);
    const bad = [];
    for (const n of names) {
      deskOpen(n);
      await new Promise((r) => setTimeout(r, 260));
      const col = document.getElementById('col-' + n);
      if (!col || getComputedStyle(col).display === 'none') bad.push(n);
      deskOpen(n);
      await new Promise((r) => setTimeout(r, 120));
    }
    return { names: names.length, unreachable: bad }; })()`);
  ok('...every one of the nine surfaces is actually reachable on desktop',
     reach.unreachable.length === 0, JSON.stringify(reach));

  /* ⚠ THE PATH THAT ACTUALLY BROKE, AND THAT NO CHECK HERE EXERCISED. Everything above clicks a
     rail button on a page that has been open for two seconds. A member arrives with a panel
     already remembered, so deskOpen runs from the load handler - and there the mount ran before
     its module existed, marked itself done, and left a permanently blank panel. Clicking works;
     arriving did not. Reload with the panel remembered and assert CONTENT. */
  await evalIn(`try{localStorage.setItem('novo_desk','futures')}catch(e){}`);
  await goto(1600, 1000, false);
  await new Promise((r) => setTimeout(r, 1800));
  const restored = await evalIn(`(() => {
    const body = document.getElementById('col-futures-body');
    return { desk: document.body.getAttribute('data-desk'),
             kids: body ? body.children.length : -1,
             text: body ? body.textContent.trim().length : -1 }; })()`);
  ok('...and a remembered panel comes back WITH ITS CONTENT after a reload',
     restored.desk === 'futures' && restored.kids > 0 && restored.text > 40,
     JSON.stringify(restored));
  await evalIn(`try{localStorage.removeItem('novo_desk')}catch(e){}`);


  console.log('\n' + (bad ? 'FAIL ' + bad : 'OK') + '\n');
  try { proc.kill(); } catch (_) {}
  server.close();
  process.exit(bad ? 1 : 0);
});
