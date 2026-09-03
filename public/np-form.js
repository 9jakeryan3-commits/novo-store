// Newsletter capture — one delegated handler for every form.np-form on the site.
// POSTs to /api/subscribe (the long-built backend: Resend audience, rate limit, welcome email,
// signed unsubscribe). Forms with id="np-subscribe" are EXCLUDED here — plans.html
// carries its own inline handler for that id, and binding twice would double-submit.
//
// GA4's generate_lead fires from HERE (2026-09-02): this file is the one thing all 1,413
// capture pages already load, where ga-events.js is on 6 — so the lead event lived on 6 of
// 1,413 pages that collect leads. ga-events.js's np-form clause was removed in the same
// commit so the 4 pages loading both files cannot double-fire. Guarded: three pages have no
// gtag at all (404, embed-pulse, trader-live) and analytics must never break the signup.
(function () {
  document.addEventListener('submit', async function (e) {
    var f = e.target;
    if (!f || !f.classList || !f.classList.contains('np-form') || f.id === 'np-subscribe') return;
    e.preventDefault();
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'generate_lead', { currency: 'USD', value: 0 });
      }
    } catch (_) { /* analytics is best-effort; the signup must proceed regardless */ }
    var input = f.querySelector('input[type="email"]');
    var msg = f.parentElement ? f.parentElement.querySelector('.np-msg') : null;
    if (!input) return;
    var email = input.value.trim();
    if (msg) { msg.style.color = '#8aacc8'; msg.textContent = '…'; }
    var btn = f.querySelector('button'); if (btn) btn.disabled = true;
    try {
      var r = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      });
      if (r.ok) {
        if (msg) { msg.style.color = '#10b981'; msg.textContent = 'You’re in — check your inbox for the welcome note.'; }
        f.reset();
      } else {
        var d = await r.json().catch(function () { return {}; });
        if (msg) { msg.style.color = '#f43f5e'; msg.textContent = d.error || 'Something went wrong — try again.'; }
      }
    } catch (_) {
      if (msg) { msg.style.color = '#f43f5e'; msg.textContent = 'Network error — try again.'; }
    }
    if (btn) btn.disabled = false;
  }, true);
})();
