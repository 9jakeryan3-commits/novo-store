/* novo-token.js — the ONE owner of the live session credential, and of the DECISION about it.
 *
 * ⚠ LOAD THIS AS A BLOCKING TAG IN <head>, ABOVE THE AUTH BLOCK. The dashboards capture and read
 * the token in their first ~40 lines; the shared modules load ~8,600 lines later. Placed with the
 * other modules this file is not present when the only code that matters runs. It costs one small
 * request before first paint, which is the right trade on an auth-critical path.
 *
 * WHY THIS EXISTS. `novo_live_t` is a single localStorage key on a single origin, shared by all
 * three dashboards. Until 2026-09-12 all three also owned the logic for it, and each deleted it
 * unconditionally on a 401:
 *
 *     analyst-live.html:1787   removeItem(...)   no expiry check
 *     trader-live.html:99      removeItem(...)   no expiry check
 *     crypto-live.html:3252    removeItem(...)   no expiry check
 *
 * A spurious 401 comes from verifyToken() returning null — a rotated or briefly-missing
 * ANALYST_LIVE_SECRET — and that hits ALL THREE endpoints at once. So one bad deploy 401s every
 * dashboard simultaneously and whichever tab is open first wipes the credential for the rest. The
 * member cannot retry; they must return to the portal for a fresh magic link. The subscribers most
 * exposed are the ones with two dashboards open — bundle members.
 *
 * ⚠ THE FIX WENT TO CRYPTO ALONE FIRST AND ACHIEVED NOTHING. One of three copies fixed is worse
 * than none: the bug still fires from the other two and now LOOKS addressed. Three copies of one
 * decision caused this, so three copies of the fix was never the answer.
 *
 * ⚠ AND THIS MODULE RETURNS A DECISION, NOT A DECODER. An earlier draft exposed expiry()/expired()
 * and left each host to write its own `if`. Yuri's objection killed it and was right: that moves
 * the duplication rather than removing it, and the three `if`s drift the first time one is tuned.
 * What diverged was never the parsing — it was the POLICY. So the policy lives here, the hosts
 * switch on a word, and "what counts as expired" has exactly one definition for all three.
 *
 * WHAT MAKES KEEPING THE TOKEN SAFE, verified in api/crypto-map.js rather than assumed:
 *
 *     401  verifyToken failed  -- bad signature, or the payload's own x has passed
 *     402  ent === "no"        -- "the caller is who they say they are, they just have not bought this"
 *     503  ent === "unknown"   -- "a 402 upsell shown to a paying subscriber during an upstream
 *                                 outage is the worst thing this endpoint can do"
 *
 * Identity and ENTITLEMENT are answered on different status codes. A revoked subscriber never
 * reaches 401 — they get 402. So keeping the credential through a 401 whose `x` is still in the
 * future leaks no access: the only thing producing that combination is a server-side signature
 * failure, which is ours and not the member's.
 *
 * The payload is plain base64url JSON; the HMAC forges, it does not hide. That is what makes the
 * expiry readable client-side with no secret, and the distinction possible at all.
 */
(function (w) {
  'use strict';
  var KEY = 'novo_live_t';

  function get() {
    try { return w.localStorage.getItem(KEY) || null; } catch (_) { return null; }
  }

  function set(t) {
    try { w.localStorage.setItem(KEY, t); } catch (_) {}
  }

  function forget() {
    try { w.localStorage.removeItem(KEY); } catch (_) {}
  }

  /* The payload's own expiry in ms, or null if it cannot be read at all. */
  function expiry(t) {
    try {
      var p = String(t == null ? get() : t).split('.')[0];
      if (!p) return null;
      var x = JSON.parse(w.atob(p.replace(/-/g, '+').replace(/_/g, '/'))).x;
      return (typeof x === 'number' && isFinite(x)) ? x : null;
    } catch (_) { return null; }
  }

  /* THE DECISION. Call this on a 401 instead of removeItem(), and branch on the word.
   *
   *   'expired'  the credential is done. Cleared here. Tear down and say "sign in again".
   *   'transient'    the credential is good and the SERVER refused it. Kept. Do not tear down,
   *              do not latch anything one-way, show a retrying state and retry on a timer.
   *
   * ⚠ UNREADABLE COUNTS AS EXPIRED, and this reverses my first draft. I had it failing toward
   * KEEPING, reasoning that destroying a session over a parse failure is the worse error. Yuri
   * showed that is wrong, and the argument is about what happens NEXT rather than which error is
   * worse in the abstract: 'transient' means "retry, this may start working". A valid token rejected
   * by a broken secret may indeed start working. **A token we cannot parse can never start
   * working** — retrying it loops forever behind a "retrying" gate, and the member is never told
   * the one thing that would help, which is to sign in again. Fail closed on garbage.
   *
   * So the real test is not "which failure is safer" but "could retrying this ever succeed?"
   */
  function onAuthFailure(t) {
    var x = expiry(t);
    if (x === null || x <= Date.now()) { forget(); return 'expired'; }
    return 'transient';
  }

  /* A member-initiated sign-out. Deliberately separate, and deliberately not the thing a 401
     handler can reach for by accident. */
  function signOut() { forget(); }

  w.NovoToken = {
    KEY: KEY,
    get: get,
    set: set,
    expiry: expiry,
    onAuthFailure: onAuthFailure,
    signOut: signOut
  };
}(window));
