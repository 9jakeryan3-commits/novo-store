/* ──────────────────────────────────────────────────────────────────────────────
   polish.js — the motion half of the fit-and-finish layer.

   Two jobs: elevate the nav once the page has scrolled, and reveal sections as
   they arrive. Both are decoration, so both fail silently and neither is allowed
   to leave the page in a worse state than not running at all.
   ────────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── the scored-session count ─────────────────────────────────────────────
  // 1,031 was written into nine pages by hand, so it was correct on the day and
  // wrong every day after. The number the site quotes is now the number the API
  // reports. Ships with the last known value in the HTML, so it is right for
  // crawlers and for anyone whose fetch fails -- this only ever corrects it.
  var slots = document.querySelectorAll('[data-live-sessions]');
  if (slots.length) {
    fetch('/api/track-record', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var n = d && d.sessions_scored;
        if (!n || typeof n !== 'number') return;      // never blank a good value with a bad one
        var txt = n.toLocaleString('en-US');
        slots.forEach(function (el) { if (el.textContent.trim() !== txt) el.textContent = txt; });
      })
      .catch(function () {});                          // stale-but-correct beats empty
  }

  // ── nav elevation ────────────────────────────────────────────────────────
  // rAF-throttled: scroll fires far faster than the screen repaints, and doing
  // class work on every event is how a page starts feeling heavy on a phone.
  var nav = document.querySelector('nav');
  if (nav) {
    var ticking = false;
    var apply = function () {
      nav.classList.toggle('is-scrolled', window.scrollY > 12);
      ticking = false;
    };
    apply();
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; window.requestAnimationFrame(apply); }
    }, { passive: true });
  }

  // ── reveal on scroll ─────────────────────────────────────────────────────
  // Content ships visible. We only add .rv (which hides it) once we know an
  // observer exists to take it back off — so a browser without
  // IntersectionObserver, or a JS error above this line, leaves a fully
  // readable page rather than a blank one.
  if (still || !('IntersectionObserver' in window)) return;

  var targets = [];
  document.querySelectorAll('section').forEach(function (sec) {
    // The hero is already on screen at load; animating it just delays the first
    // thing the visitor came to read.
    if (sec.classList.contains('hero')) return;
    if (sec.getBoundingClientRect().top < window.innerHeight) return;
    targets.push(sec);
  });
  if (!targets.length) return;

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('rv-in');
      io.unobserve(e.target);          // one-shot: re-animating on scroll-back is nausea, not polish
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.05 });

  targets.forEach(function (t) { t.classList.add('rv'); io.observe(t); });

  // Belt and braces: if anything above wedges, un-hide everything after a beat
  // so no visitor is ever left looking at an empty page.
  window.setTimeout(function () {
    document.querySelectorAll('.rv:not(.rv-in)').forEach(function (el) {
      if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('rv-in');
    });
  }, 1200);
})();

/* ---- Discord link-up result -------------------------------------------------------------
   /api/discord finishes by bouncing the member back to /analyst?discord=… or /crypto?discord=…
   Nothing on either page ever read that parameter, so the flow ended on a page that looked
   exactly like the one they left: no confirmation on success, and no explanation on failure.
   A member who saw nothing would reasonably click Connect again. ---------------------------- */
(function () {
  var st;
  try { st = new URLSearchParams(window.location.search).get('discord'); } catch (e) { return; }
  if (st !== 'connected' && st !== 'failed' && st !== 'expired' && st !== 'error') return;

  var ok = st === 'connected';
  var msg = ok
    ? 'Discord connected — your members role is live. Open Discord to see the private channels.'
    : st === 'expired'
      ? 'That link belongs to a subscription that is no longer active. Re-subscribe and the members channels come back.'
      : 'We could not finish linking Discord. Try the Connect link in your welcome email again, or reply to it and we will sort it out.';

  var el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:9999;' +
    'max-width:min(520px,calc(100vw - 32px));padding:13px 18px;border-radius:11px;font-size:14px;' +
    'line-height:1.5;font-weight:600;color:#eaf3ff;background:rgba(20,21,25,.96);backdrop-filter:blur(8px);' +
    'border:1px solid ' + (ok ? 'rgba(88,101,242,.55)' : 'rgba(245,158,11,.5)') + ';' +
    'box-shadow:0 0 30px -8px ' + (ok ? 'rgba(88,101,242,.6)' : 'rgba(245,158,11,.45)') + ';';
  el.textContent = msg;
  document.body.appendChild(el);

  // Drop the parameter so a refresh or a shared URL does not replay the banner.
  try {
    var u = new URL(window.location.href);
    u.searchParams.delete('discord');
    window.history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
  } catch (e) { /* older browser: leaving the param is harmless */ }

  window.setTimeout(function () {
    el.style.transition = 'opacity .4s ease';
    el.style.opacity = '0';
    window.setTimeout(function () { el.remove(); }, 450);
  }, ok ? 6000 : 11000);
})();
