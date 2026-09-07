/* novo-appfeel.js — the dashboards do not pinch-zoom like a web page.
 *
 * Jake, 2026-09-07: "zoom cam we lock it so you can pinch zoom on mobile really kills the app feel."
 *
 * THREE MECHANISMS, BECAUSE NO ONE OF THEM COVERS EVERY BROWSER:
 *   1. the viewport meta (maximum-scale=1, user-scalable=no) — in each page's head. Honoured by
 *      Android Chrome and by iOS in a home-screen PWA; IGNORED by iOS Safari since iOS 10, which is
 *      why it is not the whole answer.
 *   2. touch-action: pan-x pan-y on the root — the browser keeps scrolling and gives up its own
 *      pinch-zoom and double-tap zoom. This is the one that does the work on iOS Safari.
 *   3. the gesture events below, for the iOS cases the other two miss.
 *
 * ⚠ THE CHART IS EXEMPT, AND THAT IS THE POINT OF DOING THIS IN JS AT ALL. The trader's chart
 * implements its own touch handling — the file already carries a touch-action:pan-y rule written
 * around "the chart underneath and panning it" — so a blanket preventDefault would take pinch-zoom
 * away from the one surface where it is a feature rather than an accident. Anything inside a
 * canvas, or inside the chart container, is left alone.
 *
 * ⚠ AND THIS IS AN ACCESSIBILITY TRADE, MADE DELIBERATELY. Blocking zoom is a WCAG 1.4.4 failure
 * for anyone who pinches to read. It is Jake's call for an installed app, and it is written down
 * here rather than left implicit so the next person knows it was a decision and not an oversight.
 */
(function () {
  /* The chart, and anything drawing its own gestures. Kept as a selector list rather than a class
     so a new chart surface only has to name itself here. */
  var EXEMPT = '#novo-chart, .tv-lightweight-charts, canvas, [data-pinch]';

  function inExempt(el) {
    try { return !!(el && el.closest && el.closest(EXEMPT)); } catch (_) { return false; }
  }

  function root() {
    /* On the ROOT, not body: an ancestor's touch-action constrains everything under it, and body
       leaves the document background able to zoom on some builds. */
    try { document.documentElement.style.touchAction = 'pan-x pan-y'; } catch (_) {}
  }

  /* iOS Safari's non-standard gesture events. They fire for a two-finger pinch anywhere in the
     document; preventing the start is what stops the page scaling. */
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      if (inExempt(e.target)) return;
      e.preventDefault();
    }, { passive: false });
  });

  /* Double-tap zoom on older iOS, which ignores touch-action for it. Two taps inside 300ms on the
     same spot: the SECOND one is cancelled, so a single tap and a normal double-tap-to-select still
     behave. Nothing is blocked inside the chart or on a form control. */
  var lastTap = 0;
  document.addEventListener('touchend', function (e) {
    if (inExempt(e.target)) return;
    var t = Date.now();
    if (t - lastTap <= 300) {
      var tag = (e.target && e.target.tagName) || '';
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) e.preventDefault();
    }
    lastTap = t;
  }, { passive: false });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', root);
  else root();
})();
