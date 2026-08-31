// Newsletter capture — one delegated handler for every form.np-form on the site.
// POSTs to /api/subscribe (the long-built backend: Resend audience, rate limit, welcome email,
// signed unsubscribe). GA4's generate_lead fires from ga-events.js on the same class, so this
// file never touches analytics. Forms with id="np-subscribe" are EXCLUDED here — plans.html
// carries its own inline handler for that id, and binding twice would double-submit.
(function () {
  document.addEventListener('submit', async function (e) {
    var f = e.target;
    if (!f || !f.classList || !f.classList.contains('np-form') || f.id === 'np-subscribe') return;
    e.preventDefault();
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
