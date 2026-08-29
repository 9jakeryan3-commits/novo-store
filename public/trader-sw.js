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
