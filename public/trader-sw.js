// NoVo Trader — service worker (PWA install).
// Network-only pass-through, deliberately: this dashboard streams a live dealer map at ~2Hz and a
// cached app shell would show a subscriber a stale gamma flip and call it live. Mirrors
// crypto-sw.js and analyst-sw.js so all three dashboards install the same way.
//
// No push handler: Trader alerts are not part of this product yet. Adding one that never fires
// would ask for a notification permission the page does nothing with.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => { e.waitUntil((async () => {
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (_) {}
  await self.clients.claim();
})()); });
self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(() => new Response('', { status: 504 }))));
