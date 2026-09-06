/* bias-layout-check.js — the NoVo's-bias row must not leave dead space beside the ticker strip.
 *
 * THE DEFECT (Jake, screenshot 2026-09-06): on DESKTOP the bias card is far taller than the two
 * ticker cards beside it, so the left column ends well above the chart with nothing in it. On
 * MOBILE the grid collapses to one column and the mismatch cannot appear — Jake's words were
 * "that works on mobile but not desktop", which is why this measures at three widths and asserts
 * the stacked path separately rather than assuming one fix serves both.
 *
 * Measured in headless Chrome against the REAL stylesheet extracted from analyst-live.html and the
 * REAL markup _biasRow() emits. A layout bug lives in the rendered box model and nowhere else;
 * reading the CSS and reasoning about it is what produced the bug in the first place.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HTML = path.join(__dirname, '..', 'public', 'analyst-live.html');
const src = fs.readFileSync(HTML, 'utf8');

// The page's own <style> blocks, verbatim. If the selectors change, this harness changes with them.
const css = (src.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || [])
  .map((b) => b.replace(/<\/?style[^>]*>/g, '')).join('\n');

// Exactly what _biasRow() emits for a scored premarket + hourly pair — the screenshot's content.
const biasRows =
  '<div class="bias-row"><span class="bk">Premarket</span>' +
  '<span class="bpill" style="background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.45);">BEARISH</span>' +
  '<span class="bage">2d ago</span>' +
  '<span class="bsc">Right <b>50%</b> of the time over <b>8</b> sessions, open to close.</span></div>' +
  '<div class="bias-row"><span class="bk">Hourly</span>' +
  '<span class="bpill" style="background:rgba(148,163,184,.12);color:#b3c2d6;border:1px solid rgba(148,163,184,.4);">NEUTRAL</span>' +
  '<span class="bage">2d ago</span>' +
  '<span class="bsc">Right <b>45.2%</b> of the time over <b>42</b> hours. Not yet a significant edge.</span></div>';

// Exactly what renderStrip() produces beside it: two ticker cards.
const strip =
  '<div class="lv-card lv-tick"><div class="t-h"><b>QQQ</b> $717.52</div>' +
  '<div class="t-s">dampening &middot; GEX +$424.7M &middot; EM &plusmn;0.6% &middot; skew +1.9</div></div>' +
  '<div class="lv-card lv-tick"><div class="t-h"><b>IWM</b> $295.53</div>' +
  '<div class="t-s">dampening &middot; GEX +$71.8M &middot; EM &plusmn;0.5% &middot; skew +1.2</div></div>';

const page = '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head>' +
  '<body><div class="wrap" style="max-width:1600px;margin:0 auto;padding:0 18px;">' +
  '<div class="lv-grid lv-grid-top">' +
  '<div class="lv-strip" id="strip">' + strip + '</div>' +
  '<div class="lv-card lv-bias" id="bias-card"><h2>NoVo&rsquo;s bias</h2>' +
  '<div id="bias-rows">' + biasRows + '</div></div>' +
  '</div>' +
  '<div class="lv-grid"><div class="lv-card" id="hero-l"><h2>SPY &middot; Session &amp; dealer levels</h2></div>' +
  '<div class="lv-card"><h2>SPY &middot; Dealer positioning</h2></div></div>' +
  '</div></body></html>';

const tmp = path.join(os.tmpdir(), 'bias-layout-check.html');
fs.writeFileSync(tmp, page);

const CHROME = process.env.CHROME_BIN || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome found; set CHROME_BIN'); process.exit(2); }

const PORT = 9333;
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + path.join(os.tmpdir(), 'bias-chrome-' + PORT),
  '--window-size=1600,1200', 'about:blank',
], { stdio: 'ignore' });

let failures = 0, checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log('  PASS  ' + name); return; }
  failures++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : ''));
}

const MEASURE = [
  '(() => {',
  '  const strip = document.getElementById("strip");',
  '  const bias  = document.getElementById("bias-card");',
  '  const heroL = document.getElementById("hero-l");',
  '  const cards = Array.from(strip.querySelectorAll(".lv-tick"));',
  '  const sb = strip.getBoundingClientRect();',
  '  const bb = bias.getBoundingClientRect();',
  '  const hb = heroL.getBoundingClientRect();',
  '  const contentBottom = cards.length',
  '    ? Math.max.apply(null, cards.map(c => c.getBoundingClientRect().bottom)) : sb.bottom;',
  '  const rowBottom = Math.max(sb.bottom, bb.bottom);',
  '  return {',
  '    stacked: Math.abs(sb.top - bb.top) > 4,',
  '    stripH: Math.round(sb.height), biasH: Math.round(bb.height),',
  '    gapUnderTickers: Math.round(rowBottom - contentBottom),',
  '    stripInternalGap: Math.round(sb.bottom - contentBottom),',
  '    biasRowsSideBySide: (function(){',
  '      var r = Array.from(bias.querySelectorAll(".bias-row"));',
  '      return r.length === 2 && Math.abs(r[0].getBoundingClientRect().top -',
  '                                        r[1].getBoundingClientRect().top) < 4;',
  '    })(),',
  '    gapToHero: Math.round(hb.top - contentBottom),',
  '  };',
  '})()',
].join('\n');

(async () => {
  const wsUrl = await new Promise((res, rej) => {
    const t = setInterval(async () => {
      try {
        const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
        const j = await r.json(); clearInterval(t); res(j.webSocketDebuggerUrl);
      } catch (_) { /* not up yet */ }
    }, 120);
    setTimeout(() => { clearInterval(t); rej(new Error('chrome never came up')); }, 15000);
  });

  const ws = new WebSocket(wsUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  };
  const send = (method, params, sessionId) => new Promise((res) => {
    const i = ++id; waiting.set(i, res);
    ws.send(JSON.stringify({ id: i, method: method, params: params, sessionId: sessionId }));
  });
  await new Promise((r) => { ws.onopen = r; });

  const t = (await send('Target.createTarget', { url: 'about:blank' })).result;
  const s = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result;
  const sid = s.sessionId;
  await send('Page.enable', {}, sid);

  console.log('\nNoVo bias row - layout checks\n');

  const widths = [
    { w: 1600, label: 'desktop 1600' },
    { w: 1200, label: 'desktop 1200' },
    { w: 820,  label: 'mobile 820' },
  ];

  for (let i = 0; i < widths.length; i++) {
    const w = widths[i].w, label = widths[i].label;
    await send('Emulation.setDeviceMetricsOverride',
      { width: w, height: 1200, deviceScaleFactor: 1, mobile: false }, sid);
    await send('Page.navigate', { url: 'file:///' + tmp.replace(/\\/g, '/') }, sid);
    await new Promise((r) => setTimeout(r, 400));

    const ev = (await send('Runtime.evaluate',
      { returnByValue: true, expression: MEASURE }, sid)).result;
    const m = ev.result.value;

    if (m.stacked) {
      // Jake: "that works on mobile but not desktop." The stacked path is the one that already
      // works, so it is asserted as UNCHANGED rather than improved — a desktop fix that quietly
      // reflows mobile would trade one complaint for another.
      // ⚠ THE FIRST VERSION OF THIS CHECK MEASURED THE WRONG THING and failed on a correct
      // layout: stacked, `rowBottom` is the bottom of the BIAS CARD sitting below the strip, so
      // "gap under the tickers" was really "the height of the card underneath". It reported 207px
      // of dead space where there is none. A measurement taken at the wrong width answers a
      // different question and still returns a number.
      ok(label + ': the strip has no dead space of its own',
        m.stripInternalGap <= 2, JSON.stringify(m));
      // The discriminating one: the desktop fix must NOT reach mobile. If the media query boundary
      // ever moves, the bias rows go side-by-side in a single narrow column and this catches it.
      ok(label + ': bias rows stay STACKED (the desktop 2-up must not leak down)',
        m.biasRowsSideBySide === false, JSON.stringify(m));
    } else {
      console.log('  .. ' + label + ': strip ' + m.stripH + 'px | bias ' + m.biasH +
                  'px | dead space under tickers ' + m.gapUnderTickers + 'px');
      ok(label + ': dead space under the ticker cards is under 24px',
        m.gapUnderTickers < 24, JSON.stringify(m));
      ok(label + ': the two columns finish within 12px of each other',
        Math.abs(m.stripH - m.biasH) <= 12, 'strip=' + m.stripH + ' bias=' + m.biasH);
      // What actually shortens the card. Without this the gap only shrinks by whatever the
      // stretch absorbs, and the fix would look done while the card is still 191px.
      ok(label + ': the two bias rows sit SIDE BY SIDE',
        m.biasRowsSideBySide === true, JSON.stringify(m));
    }
  }

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  ws.close(); proc.kill();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); proc.kill(); process.exit(2); });
