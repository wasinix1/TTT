/* The phone page's service worker: it is only here for Web Push (tt/push.py).
   It caches nothing — the page is live or it is wrong — and does one thing
   with a push: show it, so a locked phone still hears "Table 2 — you're on".
   A later call carries the same tag and replaces the earlier one. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'TTT', {
    body: d.body || '',
    tag: d.tag || 'ttt',
    renotify: true,
    requireInteraction: !!d.sticky,
    vibrate: [220, 90, 220, 90, 220],
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ('focus' in w) return w.focus();
    return self.clients.openWindow(url);
  }));
});
