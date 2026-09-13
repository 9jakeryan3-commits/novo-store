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

  /* ⚠ novoFetch() ABOVE PROTECTS HEADERS ONLY, AND THAT IS DELIBERATE — BUT IT IS NOT ENOUGH FOR
     A POLL. `.finally(clearTimeout)` runs when the FETCH promise settles, which is when headers
     arrive. From that instant the request is unprotected, so `await r.json()` sits outside the
     deadline and a body that stalls mid-stream still hangs forever. That is a CDN or proxy dying
     mid-response, or a mobile connection dropping after the first packet — not an exotic case.

     Junie caught this against a real server that writes 200, calls flushHeaders(), then never
     sends a body. My own tests passed because my stub never resolved AT ALL — a headers stall —
     so they could not see the half of the deadline that was missing. A test that cannot produce
     the defect cannot find it.

     ⚠ SO WHY NOT JUST MOVE THE clearTimeout? Because /api/analyst-ask is a STREAMING SSE POST
     that reads its body incrementally for as long as the answer takes. A deadline armed through
     the body would abort every long chat answer mid-stream. Headers-only is CORRECT for that
     call and wrong for a poll that reads to completion. Hence two deadlines with different
     names, rather than one that is subtly wrong for somebody. */
  /* ⚠ THIS IS _tfetch's SHAPE, DELIBERATELY AND ALMOST VERBATIM. My first version invented a
     fresh one — `.finally(clearTimeout)` on the fetch promise plus `res.json()` — which is
     EXACTLY the pre-419f81c2c trader code, i.e. the bug Jake reported on 2026-09-02:

         "it freezes after its been minimized then reopened. this cant happen"

     live price, dead candles, a stuck "slow connection — retrying" veil, 18 minutes after a
     restore. A minimised window's resumed connection stalls mid-BODY; the headers had long since
     landed, so the timer was already cleared and `await r.json()` hung forever.

     Junie caught that I was about to consolidate three wrappers onto a regression. Both existing
     wrappers had independently converged on drain-the-body-inside-the-deadline, and `_tfetch`
     carries a fourteen-line post-mortem explaining why. **It was worth reading before rewriting.**

     Two properties here are load-bearing and neither is obvious:
       - r.text() then JSON.parse, not r.json(): the body is fully drained INSIDE the deadline and
         the timer clears only once it is in hand.
       - the {ok,status,headers,json()} shim, with headers exposed on 2026-09-04 because the pull
         path reads X-Novo-As-Of. Omitting it silently gave the wrapper no .headers, the read threw,
         and the caller fell back to the engine on EVERY poll — "a pull architecture that never
         actually pulled." Returning a real Response instead would cost trader and crypto a
         property they were bug-fixed into having.

     Keeping the shape identical is also what lets trader and crypto migrate with zero call-site
     changes, which is the whole point of consolidating. */
  novoFetch.json = function (url, opts, ms) {
    var ac = new w.AbortController();
    var limit = (typeof ms === 'number' && ms > 0) ? ms : DEFAULT_MS;
    var timer = w.setTimeout(function () { try { ac.abort(); } catch (_) {} }, limit);
    var clr = function () { if (timer) { w.clearTimeout(timer); timer = null; } };
    var o = { cache: 'no-store' };
    if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    o.signal = ac.signal;
    return w.fetch(url, o).then(function (r) {
      return r.text().then(function (t) {
        clr();
        return {
          ok: r.ok, status: r.status, headers: r.headers,
          json: function () { return JSON.parse(t); }
        };
      }, function (e) { clr(); throw e; });
    }, function (e) { clr(); throw e; });
  };

  novoFetch.timedOut = timedOut;
  novoFetch.DEFAULT_MS = DEFAULT_MS;
  w.NovoFetch = novoFetch;
}(window));
