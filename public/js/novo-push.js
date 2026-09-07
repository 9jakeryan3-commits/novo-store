/* novo-push.js — THE VAPID registration. One implementation, all three dashboards.
 *
 * Jake, 2026-09-07: "all 3 get this alerts tab ... analyst has the VAPID keys and technique to do
 * it in all 3", and "it is VAPID only no option to go to email or discord or whatever is pinged
 * from the app only."
 *
 * This is a MOVE, not a rewrite: the body of enable() is the analyst dashboard's subscribe(),
 * character for character, because it is the path that has been registering real devices for
 * weeks. Retyping it would be a rewrite wearing a port's name, and a subtly wrong applicationServerKey
 * produces a subscription that registers cleanly and never receives anything.
 *
 * WHAT MAKES ONE REGISTRATION COVER THREE DASHBOARDS: the subscription is stored against the
 * MEMBER, not the product. api/analyst-publish.js?push=subscribe indexes it at push:u:<emailhash>,
 * and api/_lib/alerts.js reads that same key when an alert fires. Each dashboard registers its own
 * service worker scope (/analyst/, /crypto/, /trader/ — all three are rewrites to *-sw.js in
 * vercel.json), and navigator.serviceWorker.ready resolves to whichever one owns the page. So the
 * endpoint differs per scope and the member index holds up to five of them.
 *
 * ⚠ THE ENDPOINT IS NAMED analyst-publish AND IS NOT ANALYST-GATED. It authenticates with the
 * member ticket alone (_verifyToken), with no plan claim consulted — so a crypto-only or
 * trader-only subscriber registers through it exactly like an analyst subscriber. The name is
 * history, not a scope.
 *
 * ⚠ THE LOCALSTORAGE FLAG IS STILL novo_analyst_push. It is per-BROWSER, it means "this browser
 * has registered", and thousands of analyst members already carry it. Renaming it would ask every
 * one of them for permission again on their next visit.
 */
(function () {
  var SUPPORTED = ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);

  function tok() { try { return localStorage.getItem('novo_live_t') || ''; } catch (_) { return ''; } }

  /* WHICH DASHBOARD THIS DEVICE REGISTERED FROM, taken from the service worker's own scope.
     Jake, 2026-09-07: "zero Dr. NoVo features are per app gated, Dr. NoVo can do all the same
     things in each app that is very important."
     Every per-member push — a fired alert, the morning digest — used to open /analyst/live, which
     a crypto-only or trader-only member cannot open at all. The endpoint is the wrong thing to ask,
     because it says nothing about the product; the SCOPE is exact, and it is per DEVICE, so a
     notification opens the dashboard the person was actually standing on when they turned push on.
     Falls back to null rather than guessing: the server treats a missing app as legacy. */
  function appOf(reg) {
    try {
      var m = String((reg && reg.scope) || '').match(/\/(analyst|crypto|trader)\//);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }

  function u2a(s) {
    var p = '='.repeat((4 - s.length % 4) % 4), b = (s + p).replace(/-/g, '+').replace(/_/g, '/');
    var r = atob(b), o = new Uint8Array(r.length);
    for (var i = 0; i < r.length; i++) o[i] = r.charCodeAt(i);
    return o;
  }

  async function enable() {
    if (!SUPPORTED) return false;
    try {
      var t = tok(); if (!t) return false;
      var perm = await Notification.requestPermission(); if (perm !== 'granted') return false;
      var kr = await fetch('/api/analyst-publish?push=key').then(function (r) { return r.json(); });
      if (!kr.key) return false;
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription()
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u2a(kr.key) });
      var res = await fetch('/api/analyst-publish?push=subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t, sub: sub, app: appOf(reg) }) });
      if (res.ok) localStorage.setItem('novo_analyst_push', '1');
      return res.ok;
    } catch (e) { return false; }
  }

  async function disable() {
    try {
      var reg = await navigator.serviceWorker.ready;
      var s = await reg.pushManager.getSubscription();
      if (s) await s.unsubscribe();
    } catch (_) {}
    try { localStorage.removeItem('novo_analyst_push'); } catch (_) {}
  }

  /* What THIS BROWSER believes. The authority on whether a route exists is the server — the alerts
     endpoint reports it from push:u:<hash> — and any surface that can ask the server should. This
     is for the cases that cannot: painting a toggle before a fetch returns. */
  function on() {
    try {
      return SUPPORTED && Notification.permission === 'granted'
        && localStorage.getItem('novo_analyst_push') === '1';
    } catch (_) { return false; }
  }

  /* Re-registering a browser that already said yes, so a rotated VAPID key or a dropped
     subscription silently repairs itself. Never prompts: getSubscription() already exists and
     requestPermission() returns 'granted' without UI once granted. */
  async function refresh() {
    if (!SUPPORTED || !tok() || !on()) return false;
    try {
      var kr = await fetch('/api/analyst-publish?push=key').then(function (r) { return r.json(); });
      if (!kr || !kr.key) return false;          // push not configured server-side — do nothing
    } catch (_) { return false; }
    return enable();
  }

  window.novoPush = { supported: SUPPORTED, enable: enable, disable: disable, on: on, refresh: refresh };
  /* The names the Alerts card already calls. Kept as aliases rather than renamed at the call
     sites, so this file can be dropped into a page without touching the page's own code. */
  window.novoEnablePush = enable;
  window.novoPushOn = on;

  window.addEventListener('load', function () { setTimeout(refresh, 1400); });
})();
