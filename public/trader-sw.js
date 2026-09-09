// NoVo Trader — service worker (PWA install).
//
// Network-only pass-through, deliberately: this dashboard streams a live dealer map at ~2Hz and a
// cached app shell would show a subscriber a stale gamma flip and call it live. Mirrors
// crypto-sw.js and analyst-sw.js so all three dashboards install the same way.
//
// No push handler: Trader alerts are not part of this product yet. Adding one that never fires would
// ask for a notification permission the page does nothing with.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => { e.waitUntil((async () => {
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (_) {}
  await self.clients.claim();
})()); });

// CROSS-ORIGIN REQUESTS ARE NOT OURS TO HANDLE.
//
// This dashboard is the only one of the three whose DATA lives on another origin: the page is served
// from novo-options.trade and the chart socket and its APIs are on the box. A controlled page routes
// EVERY fetch through this worker, cross-origin included, and the catch below turns any hiccup into a
// synthetic 504 — which is what a failure looks like to the page, so /api/spy-chart came back 504 and
// the chart rendered blank.
//
// It also only bites after the first load, because the worker is not controlling the page yet on the
// visit that installs it. So the chart draws once, then never again — which reads as an intermittent
// bug rather than a worker that should never have been in the path.
//
// Returning without calling respondWith() hands the request straight to the network.
self.addEventListener('fetch', e => {
  let sameOrigin = false;
  try { sameOrigin = new URL(e.request.url).origin === self.location.origin; } catch (_) {}
  if (!sameOrigin) return;
  e.respondWith(fetch(e.request).catch(() => new Response('', { status: 504 })));
});

/* PUSH. The trader worker never had this (found 2026-09-08). Jake had alerts ON in the Trader
   app and heard nothing all session, while the same level-break arrived on Crypto - because the
   Trader PWA was registering a subscription, receiving the push, and then having no listener to
   show it. A device that subscribes and cannot display is worse than one that never subscribed:
   the toggle says on, the server says delivered, and nothing reaches the person.

   This is the ANALYST handler, unchanged except for the icon, the deep link and the tag prefix -
   same payload, same fields, same behaviour. Jake, same day: "make sure you are pull data from
   the same places if its displaying in one place putting it in another is basically the same."

   THE TAG IS NAMESPACED per app. Every push carries one tag ('novo-analyst-line'), and a tag
   REPLACES an existing notification. Three PWAs on one origin all showing the same tag is how a
   Crypto alert can quietly take the place of the Trader one - which is exactly what Jake
   suspected when only Crypto buzzed. Prefixing makes them independent whatever the platform
   does with same-origin registrations. */
self.addEventListener('push', function (e) {
  let d = {}; try { d = e.data.json(); } catch (_) { d = { title: 'NoVo Trader', body: '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'NoVo Trader', {
    body: d.body || '', tag: 'trader:' + (d.tag || 'novo-trader'), renotify: true,
    icon: '/icon-192.png?v=10', badge: '/icon-192.png?v=10', data: { url: d.url || '/trader/live' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  const u = (e.notification.data && e.notification.data.url) || '/trader/live';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (let i = 0; i < cs.length; i++) { if (cs[i].url.indexOf(u) > -1 && 'focus' in cs[i]) return cs[i].focus(); }
    if (clients.openWindow) return clients.openWindow(u);
  }));
});
