// NoVo Analyst live dashboard — service worker (PWA install + Web Push).
// Network-only pass-through (never caches a stale app shell) + push / notification handlers.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => { e.waitUntil((async () => {
  try { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } catch (_) {}
  await self.clients.claim();
})()); });
self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(() => new Response('', { status: 504 }))));
self.addEventListener('push', function (e) {
  let d = {}; try { d = e.data.json(); } catch (_) { d = { title: 'NoVo Analyst', body: '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'NoVo Analyst', {
    body: d.body || '', tag: d.tag || 'novo-analyst', renotify: true,
    icon: '/icon-192.png?v=4', badge: '/icon-192.png?v=4', data: { url: d.url || '/analyst/live' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  const u = (e.notification.data && e.notification.data.url) || '/analyst/live';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (let i = 0; i < cs.length; i++) { if (cs[i].url.indexOf(u) > -1 && 'focus' in cs[i]) return cs[i].focus(); }
    if (clients.openWindow) return clients.openWindow(u);
  }));
});
