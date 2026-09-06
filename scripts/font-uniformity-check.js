/* font-uniformity-check.js — the three dashboards render ONE type system.
 *
 * Jake: "you need to make sure the 3 dashboards are a uniform font do not worry about the store."
 * And, separately and explicitly: "dont change traders mono body."
 *
 * ⚠ document.fonts.check() IS NOT USED HERE, AND MUST NOT BE. It reported Space Grotesk as
 * available on dashboards where it demonstrably fell back — the obvious verification agreed with
 * the bug. Everything below measures GLYPH WIDTH against a font name that cannot exist
 * ("ZZ-No-Such-Face-9x"). If a named face measures the same width as the impossible one, it is not
 * rendering, whatever any API claims.
 *
 * ⚠ AND THE FONT IS REQUESTED BEFORE IT IS MEASURED. A @font-face no rule uses is never
 * downloaded, so measuring immediately reports a false "falls back" for a face that is delivered
 * perfectly well. That mistake made me tell Jake that Google does not serve Geist Mono. It does.
 *
 * The defect this locks down: analyst-live.html declared 'Space Grotesk','Inter' in nine places —
 * the login h1, every big value, the read title, the wordmark — and carried ZERO font links and
 * ZERO @font-face. All nine fell through to the visitor's OS default. It was invisible on any
 * machine with those fonts installed locally, which is why it survived.
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
let failures = 0, checks = 0;
const ok = (n, c, d) => { checks++; if (c) return console.log('  PASS  ' + n);
  failures++; console.log('  FAIL  ' + n + (d ? '\n        ' + d : '')); };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  const f = path.join(PUBLIC, rel === '/' ? 'index.html' : rel);
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(f));
});

const CHROME = process.env.CHROME_BIN || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome found; set CHROME_BIN'); process.exit(2); }

const BOARDS = ['trader-live.html', 'analyst-live.html', 'crypto-live.html'];

const MEASURE = `(async () => {
  const FACES = ['Space Grotesk', 'Inter', 'Geist Mono'];
  for (const f of FACES) { try { await document.fonts.load('40px "' + f + '"', '0123456789Handgloves'); } catch (e) {} }
  try { await document.fonts.ready; } catch (e) {}

  const w = (txt, css) => { const s = document.createElement('span');
    s.textContent = txt;
    s.style.cssText = 'position:absolute;left:-9999px;font-size:40px;white-space:pre;' + css;
    document.body.appendChild(s); const r = s.getBoundingClientRect().width; s.remove();
    return Math.round(r * 100) / 100; };

  const IMPOSSIBLE = '"ZZ-No-Such-Face-9x"';
  const control = w('Handgloves 0123456789', 'font-family:' + IMPOSSIBLE);
  const delivered = {};
  FACES.forEach((f) => {
    const x = w('Handgloves 0123456789', 'font-family:"' + f + '",' + IMPOSSIBLE);
    delivered[f] = Math.abs(x - control) > 0.5;
  });

  // digit stability: do numeric columns hold as values tick?
  const digitSpread = (css) => {
    const ws = ['0000000000', '1111111111', '8888888888', '1234567890'].map((d) => w(d, css));
    return Math.round((Math.max.apply(null, ws) - Math.min.apply(null, ws)) * 100) / 100;
  };
  const rs = getComputedStyle(document.documentElement);
  const tok = (n) => rs.getPropertyValue(n).trim();
  const bodyCS = getComputedStyle(document.body);

  return {
    delivered: delivered,
    tokens: { sans: tok('--sans'), display: tok('--display'), mono: tok('--mono'), font: tok('--font') },
    bodyFamily: bodyCS.fontFamily,
    // the brand lockup: both lines, because they are styled by different rules and drifted apart
    wm1: (function () { const e = document.querySelector('.wm-1');
      return e ? getComputedStyle(e).fontFamily.split(',')[0].replace(/['\"]/g, '').trim() : null; })(),
    wm2: (function () { const e = document.querySelector('.wm-2');
      return e ? getComputedStyle(e).fontFamily.split(',')[0].replace(/['\"]/g, '').trim() : null; })(),
    bodyNumeric: bodyCS.fontVariantNumeric,
    // measured through the page's OWN body style, so it reflects what a readout actually inherits
    spreadAtBody: digitSpread('font-family:' + bodyCS.fontFamily + ';font-variant-numeric:' + bodyCS.fontVariantNumeric),
    spreadDisplay: digitSpread('font-family:' + tok('--display') + ';font-variant-numeric:' + bodyCS.fontVariantNumeric),
    spreadSans: digitSpread('font-family:' + tok('--sans') + ';font-variant-numeric:' + bodyCS.fontVariantNumeric)
  }; })()`;

(async () => {
  const PORT = 8892;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9473', '--no-first-run',
    '--user-data-dir=' + path.join(os.tmpdir(), 'fontchk'), 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 120; i++) {
    try { wsUrl = (await (await fetch('http://127.0.0.1:9473/json/version')).json()).webSocketDebuggerUrl; break; }
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

  console.log('\nOne type system across the three dashboards\n');
  const seen = {};
  for (const page of BOARDS) {
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' + page }, sid);
    await new Promise((r) => setTimeout(r, 1800));
    const res = await send('Runtime.evaluate', { returnByValue: true, expression: MEASURE, awaitPromise: true }, sid);
    if (res.result.exceptionDetails) { ok(page + ': measured', false, res.result.exceptionDetails.text); continue; }
    const v = res.result.result.value;
    seen[page] = v;
    const name = page.replace('-live.html', '');

    ['Space Grotesk', 'Inter'].forEach((f) => {
      ok(name + ': ' + f + ' is actually delivered, not just declared',
        v.delivered[f], JSON.stringify(v.delivered));
    });
    ok(name + ': every number holds its column as values tick',
      v.spreadAtBody === 0 && v.spreadDisplay === 0 && v.spreadSans === 0,
      'body=' + v.spreadAtBody + 'px display=' + v.spreadDisplay + 'px sans=' + v.spreadSans + 'px');
  }

  /* UNIFORM means the three name the SAME faces. Compared against each other rather than against a
     literal, so the assertion still holds if the house face ever changes. */
  const names = Object.keys(seen);
  ['sans', 'display', 'mono'].forEach((k) => {
    const vals = names.map((n) => (seen[n].tokens[k] || '').replace(/\s+/g, ' ').replace(/, /g, ','));
    ok('--' + k + ' is identical on all three dashboards',
      vals.every((x) => x && x === vals[0]),
      names.map((n, i) => n.replace('-live.html', '') + '=' + vals[i]).join('   '));
  });

  /* Jake's explicit carve-out. The trader reads in a monospace face and that is the product's
     identity, not drift -- so this asserts it did NOT get unified away. */
  const tr = seen['trader-live.html'];
  ok('trader keeps its monospace body — Jake\u2019s explicit call, not an oversight',
    tr && /Geist Mono/i.test(tr.bodyFamily), tr && tr.bodyFamily);
  const an = seen['analyst-live.html'];
  ok('analyst does NOT read in mono — only the trader does',
    an && !/Geist Mono/i.test(an.bodyFamily), an && an.bodyFamily);

  /* THE BRAND MARK IS THE ONE ELEMENT THAT MUST NOT VARY BY PAGE, and it was varying two ways:
     crypto's first line rendered in Inter instead of the display face, and the trader's SECOND line
     rendered in Geist Mono because it sat inside .brand{font-family:var(--font)} and never
     overrode it. One two-line lockup, two faces, neither matching the store's. */
  const wm1s = names.map((n) => seen[n].wm1), wm2s = names.map((n) => seen[n].wm2);
  ok('the wordmark first line is the display face on all three',
    wm1s.every((x) => x === 'Space Grotesk'),
    names.map((n, i) => n.replace('-live.html', '') + '=' + wm1s[i]).join('  '));
  ok('...and its sub-line is the text face on all three, not the body face',
    wm2s.every((x) => x === 'Inter'),
    names.map((n, i) => n.replace('-live.html', '') + '=' + wm2s[i]).join('  '));

  /* JS-injected overlays bypass the tokens entirely and are invisible to any CSS-only audit. The
     sign-in gate is the FIRST thing an expired session sees on a paid surface, and it was rendering
     in the OS font. Counted by substring rather than regex: no escapes to get mangled. */
  BOARDS.forEach((f) => {
    const txt = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    const hard = txt.split('system-ui,sans-serif').length - 1;
    ok(f.replace('-live.html', '') + ': no JS overlay hard-codes the OS font past the tokens',
      hard === 0, hard + ' hard-coded system-ui font shorthand(s) remain');
  });

  console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'OK ' + checks + '/' + checks) + '\n');
  ws.close(); proc.kill(); server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
