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
