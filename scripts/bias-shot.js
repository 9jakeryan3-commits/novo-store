/* bias-shot.js — render the bias row and save a PNG, so the layout is LOOKED AT and not only
 * measured. A box model can report zero dead space while the result still reads badly. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const width = Number(process.argv[2] || 1600);
const out = process.argv[3] || path.join(os.tmpdir(), 'bias-' + width + '.png');
const tmp = path.join(os.tmpdir(), 'bias-layout-check.html');
if (!fs.existsSync(tmp)) { console.error('run bias-layout-check.js first'); process.exit(2); }

const CHROME = process.env.CHROME_BIN || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
const PORT = Number(process.env.SHOT_PORT || 9341);
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--no-first-run',
  '--user-data-dir=' + path.join(os.tmpdir(), 'bias-shot-' + PORT),
  '--window-size=' + width + ',900', 'about:blank',
], { stdio: 'ignore' });

(async () => {
  const wsUrl = await new Promise((res, rej) => {
    const t = setInterval(async () => {
      try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
        const j = await r.json(); clearInterval(t); res(j.webSocketDebuggerUrl); } catch (_) {}
    }, 120);
    setTimeout(() => { clearInterval(t); rej(new Error('no chrome')); }, 15000);
  });
  const ws = new WebSocket(wsUrl);
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params, sessionId) => new Promise((res) => {
    const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  await new Promise((r) => { ws.onopen = r; });

  const t = (await send('Target.createTarget', { url: 'about:blank' })).result;
  const s = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result;
  const sid = s.sessionId;
  await send('Page.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride',
    { width, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Page.navigate', { url: 'file:///' + tmp.replace(/\\/g, '/') }, sid);
  await new Promise((r) => setTimeout(r, 500));
  // Clip to the bias row plus a little of the hero beneath, which is where the gap showed.
  const box = (await send('Runtime.evaluate', { returnByValue: true, expression:
    '(() => { const g = document.querySelector(".lv-grid-top").getBoundingClientRect();' +
    ' return {x:0, y:Math.max(0,g.top-12), width:' + width + ', height:g.height+120}; })()' }, sid)).result.result.value;
  const shot = (await send('Page.captureScreenshot',
    { format: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } }, sid)).result;
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(out);
  ws.close(); proc.kill();
  process.exit(0);
})().catch((e) => { console.error(e); proc.kill(); process.exit(2); });
