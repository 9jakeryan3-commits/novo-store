/* BODY-STALL TEST, against a REAL server rather than a stub.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM test-novo-fetch.js. That suite passed 9/9 on a module that
 * did not protect the body at all, because its stub never resolved — a HEADERS stall. It could not
 * produce the defect, so it could not find it. Junie caught it with a real socket, and the only
 * honest fix is to test against one here too.
 *
 * Server B is the real-world case: 200, flushHeaders(), then nothing. A CDN dying mid-response, or
 * a phone dropping after the first packet.
 *
 * The two healthy controls are what give the failing rows meaning: without them, ran=1 is equally
 * consistent with a harness that simply never ticked twice.
 */
'use strict';
const fs = require('fs');
const http = require('http');

const w = { AbortController, setTimeout, clearTimeout, fetch };
global.window = w;
new Function('window', fs.readFileSync(__dirname + '/../public/js/novo-fetch.js', 'utf8'))(w);
const NovoFetch = w.NovoFetch;

let bad = 0;
const check = (name, ok, detail) => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(50) + (detail || ''));
  if (!ok) bad++;
};

/* A replica of analyst's real guard. The question is never "did it abort" — it is whether
   _polling is released so a LATER tick can run. */
async function drive(get, ticks, gap) {
  let polling = false, ran = 0, returned = 0, aborted = 0;
  for (let i = 0; i < ticks; i++) {
    (async () => {
      if (polling) return;
      polling = true;
      ran++;
      try { await get(); returned++; }
      catch (e) { if (NovoFetch.timedOut(e)) aborted++; }
      finally { polling = false; }
    })();
    await new Promise((r) => setTimeout(r, gap));
  }
  return { ran, returned, aborted };
}

const serve = (handler) => new Promise((res) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => res({ s, url: 'http://127.0.0.1:' + s.address().port + '/' }));
});

(async () => {
  const healthy = await serve((_q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"ok":true}'); });
  // 200 + headers flushed, body never sent. The case that killed the first version.
  const bodyStall = await serve((_q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.flushHeaders(); });

  const H = await drive(() => NovoFetch.json(healthy.url, {}, 300), 6, 60);
  check('CONTROL healthy: the harness can actually run', H.ran === 6 && H.returned === 6,
        'ran=' + H.ran + ' returned=' + H.returned);

  const bare = await drive(async () => {
    const r = await fetch(bodyStall.url); return r.json();
  }, 6, 60);
  check('CONTROL bare fetch on a BODY stall: latches', bare.ran === 1 && bare.returned === 0,
        'ran=' + bare.ran + '  <- so the harness can detect a latch');

  /* ⚠ RUN LONG ENOUGH THAT REPEATED POLLS CAN ACTUALLY FIT. A 150ms deadline on a 60ms tick can
     only start two polls in 360ms, so an earlier `ran >= 4` over 6 ticks demanded more than the
     clock allowed and failed on a CORRECT module. The property under test is "the latch releases
     and keeps releasing", which needs a window several deadlines long — 12 ticks is ~720ms, about
     four deadlines. Fixed by lengthening the run, never by lowering the bar. */
  const fixed = await drive(() => NovoFetch.json(bodyStall.url, {}, 150), 12, 60);
  check('NovoFetch.json on a BODY stall: RELEASES', fixed.ran > 1 && fixed.aborted > 0,
        'ran=' + fixed.ran + ' aborted=' + fixed.aborted);
  /* Every poll that STARTED must have aborted, except the one still in flight when the loop ended
     — so `aborted >= ran - 1`, not `aborted === ran`. Exact equality could only ever hold by luck
     of where the last tick fell, which makes it a timing artefact rather than the property. */
  check('it keeps releasing, not just once',
        fixed.ran >= 3 && fixed.aborted >= fixed.ran - 1,
        'ran=' + fixed.ran + ' aborted=' + fixed.aborted + ' vs bare ran=' + bare.ran + ' (latched)');

  // The headers-only entry point must STAY headers-only: SSE depends on it.
  const sse = await drive(async () => {
    const r = await NovoFetch(bodyStall.url, {}, 150);   // resolves on headers, by design
    return r.status;
  }, 3, 60);
  check('plain NovoFetch still resolves on HEADERS (SSE)', sse.returned === 3,
        'returned=' + sse.returned + ' <- a body deadline here would kill long chat answers');

  // A non-JSON body must not reject past the caller's status check.
  const html = await serve((_q, r) => { r.writeHead(502, { 'Content-Type': 'text/html' }); r.end('<html>502</html>'); });
  const shim = await NovoFetch.json(html.url, {}, 500);
  check('shim shape matches _tfetch: ok/status/headers/json()',
        shim.status === 502 && shim.ok === false && !!shim.headers && typeof shim.json === 'function',
        'status=' + shim.status);
  check('headers passthrough present (the 09-04 pull-path fix)',
        typeof shim.headers.get === 'function');

  [healthy, bodyStall, html].forEach((x) => x.s.close());
  console.log(bad ? '\n  ' + bad + ' FAILED' : '\n  all checks passed');
  process.exit(bad ? 1 : 0);
})();
