// NoVo Crypto Market Map — service worker (PWA install).
// Network-only pass-through, deliberately: this dashboard renders a snapshot that changes
// every few minutes and a cached app shell would show a subscriber stale positioning and
// call it live. Mirrors analyst-sw.js so both dashboards install the same way.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => { e.waitUntil((async () => {
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (_) {}
  await self.clients.claim();
})()); });
self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(() => new Response('', { status: 504 }))));
self.addEventListener('push', function (e) {
  let d = {}; try { d = e.data.json(); } catch (_) { d = { title: 'NoVo Crypto', body: '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'NoVo Crypto', {
    body: d.body || '', tag: d.tag || 'novo-crypto', renotify: true,
    icon: '/icon-192.png?v=7', badge: '/icon-192.png?v=7', data: { url: d.url || '/crypto/live' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  const u = (e.notification.data && e.notification.data.url) || '/crypto/live';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (let i = 0; i < cs.length; i++) { if (cs[i].url.indexOf(u) > -1 && 'focus' in cs[i]) return cs[i].focus(); }
    if (clients.openWindow) return clients.openWindow(u);
  }));
});
