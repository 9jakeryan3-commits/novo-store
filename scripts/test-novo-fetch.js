/* Does NovoFetch actually convert a stall into a rejection?
 *
 * The claim the whole fix rests on: a hung body must REJECT, because the rejection is what lets a
 * caller's `finally { _polling = false }` run. If it resolves, or hangs, analyst still dies
 * permanently on one stall. So the central assertion is not "it aborts" but "the caller's finally
 * RUNS" -- asserted against a replica of analyst's real _pollGuarded.
 */
'use strict';
const fs = require('fs');

const w = {
  AbortController, setTimeout, clearTimeout,
  fetch: null,   // installed per case
};
global.window = w;
new Function('window', fs.readFileSync('C:/Trading Algo/novo-store/public/js/novo-fetch.js', 'utf8'))(w);
const NovoFetch = w.NovoFetch;

let bad = 0;
const check = (name, ok, detail) => {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(56) + (detail || ''));
  if (!ok) bad++;
};

// A body that never settles, exactly like a stalled stream -- unless aborted.
const hang = (_u, o) => new Promise((_res, rej) => {
  if (o && o.signal) o.signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
  });
});

(async () => {
  // ── 1. the stall rejects, and is identifiable ──────────────────────────────────────────────
  w.fetch = hang;
  const t0 = Date.now();
  let caught = null;
  try { await NovoFetch('/x', {}, 150); } catch (e) { caught = e; }
  const took = Date.now() - t0;
  check('a stalled body REJECTS instead of hanging', !!caught, caught ? 'after ' + took + 'ms' : '<-- hangs forever');
  check('the rejection is identifiable as a timeout', NovoFetch.timedOut(caught));
  check('it fires at the deadline, not later', took >= 140 && took < 600, took + 'ms for a 150ms limit');

  // ── 2. THE ASSERTION THAT MATTERS: the caller's finally runs ───────────────────────────────
  // Replica of analyst's real guard. Without a deadline _polling latches true forever.
  let _polling = false, ticks = 0, ran = 0;
  const pollGuarded = async () => {
    ticks++;
    if (_polling) return;
    _polling = true;
    try { ran++; await NovoFetch('/poll', {}, 120); } catch (_) {} finally { _polling = false; }
  };
  await pollGuarded();
  check('_polling released after a stall', _polling === false, '<-- the permanent-death latch');
  await pollGuarded();
  check('the NEXT poll actually runs', ran === 2, 'ran=' + ran + ' of ticks=' + ticks);

  // ── 3. NEGATIVE CONTROL: bare fetch must FAIL both of those ────────────────────────────────
  let n_polling = false, n_ran = 0;
  const naive = async () => {
    if (n_polling) return;
    n_polling = true;
    try { n_ran++; await w.fetch('/poll', {}); } catch (_) {} finally { n_polling = false; }
  };
  naive();                                             // never settles; deliberately not awaited
  await new Promise((r) => setTimeout(r, 200));
  check('CONTROL: bare fetch LEAVES the latch stuck', n_polling === true,
        n_polling ? 'so the module is doing the work' : '<-- control broken, test proves nothing');
  naive();
  check('CONTROL: the next naive poll is skipped', n_ran === 1, 'ran=' + n_ran + ' (stuck at 1)');

  // ── 4. a healthy response is untouched ─────────────────────────────────────────────────────
  w.fetch = async () => ({ ok: true, status: 200 });
  const r = await NovoFetch('/ok', {}, 5000);
  check('a normal response passes through', r && r.status === 200);

  // ── 5. caller options survive; the signal is added, not swapped ────────────────────────────
  let seen = null;
  w.fetch = async (_u, o) => { seen = o; return { ok: true, status: 200 }; };
  await NovoFetch('/x', { method: 'POST', headers: { A: '1' } }, 5000);
  check('caller opts preserved and signal added',
        seen.method === 'POST' && seen.headers.A === '1' && !!seen.signal);

  console.log(bad ? '\n  ' + bad + ' FAILED' : '\n  all checks passed');
  process.exit(bad ? 1 : 0);
})();
