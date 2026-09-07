/* novo-settings.js — the two notification toggles, wired ONCE for all three dashboards.
 *
 * Jake, 2026-09-07: "just check all the settings panels in the dashboards they should be similar
 * and working toggles, when toggle them they switch back after i reopen the app ... make sure
 * these dashboard havent drifted apart in the ways that matter."
 *
 * They had drifted exactly the way three inline copies drift: the analyst wired push and email in
 * initNotif, the trader wired email alone in tsetEmailInit and had no push row at all, and the
 * crypto map had neither toggle — a crypto subscriber literally could not reach the switch that
 * governs whether their own alerts and digest can be delivered. This file is the one wiring; the
 * pages carry only the rows.
 *
 * THE CONTRACT, and it is the fix for "they switch back":
 *   - The rendered state is the SERVER'S answer, never the click. Email renders from
 *     ?prefs=1 (Resend's unsubscribed flag — the flag the actual sends consult) and re-renders
 *     from the POST's response. The revert bug was half server (an opt-out with no contact record
 *     was a silent no-op, fixed in analyst-publish.js) and half UI pattern (a toggle painting the
 *     wish instead of the record). Both ends now hold the same rule.
 *   - Push renders from novoPush.on() — per-browser by nature, since a push subscription IS
 *     per-browser — and flipping it goes through the same novoPush the Alerts card uses.
 *
 * Buttons are found by id (#nf-push, #nf-email) so the pages' existing markup and CSS stand. A
 * page missing one of them simply doesn't get that toggle wired — no error, no fake row.
 */
(function () {
  function tok() { try { return localStorage.getItem('novo_live_t') || ''; } catch (_) { return ''; } }

  function paint(b, on) {
    b.textContent = on ? 'On' : 'Off';
    b.classList.toggle('on', !!on);
    b.dataset.on = on ? '1' : '';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // ── push: the VAPID registration, one per browser, via the shared module ──────────────────
  function wirePush() {
    var b = document.getElementById('nf-push');
    if (!b || b._ns || !window.novoPush) return;
    b._ns = 1;
    function set(on) {
      b.textContent = on ? 'On' : 'Enable';
      b.classList.toggle('on', !!on);
      b.dataset.on = on ? '1' : '';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    set(window.novoPush.on());
    b.onclick = async function () {
      b.disabled = true;
      if (b.dataset.on) { await window.novoPush.disable(); set(false); }
      else { set(await window.novoPush.enable()); }
      b.disabled = false;
    };
  }

  // ── email: the Resend flag, read before painted ───────────────────────────────────────────
  function wireEmail() {
    var b = document.getElementById('nf-email');
    if (!b || b._ns) return;
    b._ns = 1;
    var t = tok();
    if (!t) { b.disabled = true; b.textContent = '—'; b.title = 'Sign in to change this'; return; }
    b.disabled = true; b.textContent = '…';
    fetch('/api/analyst-publish?prefs=1&t=' + encodeURIComponent(t))
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (d) { paint(b, d.email_optin !== false); b.disabled = false; })
      .catch(function () {
        /* An unreadable preference is a dash, never a guess — a toggle that renders "On" without
           having asked the server is stating a preference it does not know. */
        b.textContent = '—'; b.title = 'Could not reach the preferences service'; b._ns = 0;
      });
    b.onclick = function () {
      if (b.disabled) return;
      var want = !b.dataset.on;
      b.disabled = true;
      fetch('/api/analyst-publish?prefs=1', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t, email_optin: want }) })
        .then(function (r) { if (!r.ok) throw 0; return r.json(); })
        .then(function (d) { paint(b, d.email_optin !== false); })
        /* The server refusing the write leaves the toggle where it WAS — flipping it anyway is
           the exact lie the old flow told. */
        .catch(function () {})
        .then(function () { b.disabled = false; });
    };
  }

  function wire() { wirePush(); wireEmail(); }
  window.novoSettings = { wire: wire };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
  window.addEventListener('load', wire);
})();
