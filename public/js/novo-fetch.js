/* novo-fetch.js — fetch WITH A DEADLINE, in one place for all three dashboards.
 *
 * ⚠ LOAD AS A BLOCKING TAG IN <head>, beside novo-token.js and above the auth block. Trader's
 * handshake fires around line 76; the shared modules load ~8,600 lines later.
 *
 * WHY. `fetch()` resolves on HEADERS. A body that stalls mid-stream never settles, never rejects,
 * and never times out on its own — the promise simply hangs for the life of the page. Trader fixed
 * that on 2026-09-02 with `_tfetch`, crypto on 09-03 with `_cmFetch`, and analyst-live never did:
 * four fetch sites, zero AbortControllers.
 *
 * ⚠ AND ON ANALYST A SINGLE STALL IS PERMANENT, which is what makes this more than a slow load:
 *
 *     async function _pollGuarded(){ if(_polling) return; _polling = true;
 *                                    try { await poll(); } finally { _polling = false; } }
 *     setInterval(_pollGuarded, 15000)
 *
 * `await poll()` never returns -> `finally` never runs -> `_polling` stays true forever -> every
 * later tick hits `if(_polling) return` and does nothing. The dashboard freezes on whatever it last
 * painted, or on a bare shell if it stalled on first load, and never recovers. No error, no message,
 * no retry — only a reload. **The in-flight guard, whose job is to stop two polls overlapping, is
 * what converts one stall into permanent death.** (Found by Junie, 09-12.)
 *
 * ⚠ THE ABORT IS WHAT MAKES A SAFETY NET WORK — NOT THE NET. Analyst's `_neverBlank()` is good code
 * and cannot catch this: both its call sites sit downstream of `await fetch`, and a stall never
 * rejects. Crypto escapes only because `_cmFetch` aborts at 20s and thereby CONVERTS the stall into
 * a rejection its catch can handle. Any dashboard adding a catch-based net without a deadline has
 * built a net with a hole exactly where stalls live.
 *
 * SEPARATE FROM novo-token.js ON PURPOSE. The token module owns the CREDENTIAL decision; this owns
 * the DEADLINE. Merging them would put two concerns in one wrapper, and splitting them across hosts
 * would give analyst a private `_afetch` beside crypto's `_cmFetch` and trader's `_tfetch` — which
 * is the same three-copies drift we are here to remove. Hosts keep their own UI; neither module
 * decides what a member sees.
 */
(function (w) {
  'use strict';

  /* ⚠ THE DEADLINE MUST BE SHORTER THAN THE CALLER'S POLL INTERVAL, or a slow request is still
     in flight when the next tick fires and two polls overlap — which is the thing the in-flight
     guard exists to prevent. Analyst polls every 15s, so crypto's 20s would be WRONG there.
     12s is trader's value and fits a 15s cadence with room. Callers on a different cadence must
     pass their own; this default is not a universal truth, it is a fit for a 15s loop. */
  var DEFAULT_MS = 12000;

  function timedOut(e) { return !!e && e.name === 'AbortError'; }

  /* Rejects on timeout rather than resolving with a sentinel, deliberately: the caller's existing
     catch/finally is what clears its in-flight flag and shows its own message, and a sentinel
     would sail past both. On analyst specifically, THE REJECTION IS THE FIX — it is what lets
     `finally { _polling = false }` run at all. */
  function novoFetch(url, opts, ms) {
    var ac = new w.AbortController();
    var limit = (typeof ms === 'number' && ms > 0) ? ms : DEFAULT_MS;
    var timer = w.setTimeout(function () { try { ac.abort(); } catch (_) {} }, limit);
    var o = {};
    if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    o.signal = ac.signal;
    return w.fetch(url, o).finally(function () { w.clearTimeout(timer); });
  }

  novoFetch.timedOut = timedOut;
  novoFetch.DEFAULT_MS = DEFAULT_MS;
  w.NovoFetch = novoFetch;
}(window));
