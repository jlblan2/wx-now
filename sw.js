// App shell: network first so updates show up straight away, cache as the offline fallback.
// Radar, model and map-tile requests always go to the network.
const CACHE = 'nexthour-v17';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './forecast.js',
  './push.js',
  './doppler.js',
  './storms.js',
  './surge.js',
  './marine.js',
  './compare.js',
  './passage.js',
  './config.js',
  './nowcast.js',
  './radar.js',
  './model.js',
  './data.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const shell = url.origin === self.location.origin || url.hostname === 'unpkg.com';
  if (!shell) return;
  // no-cache: revalidate with the server, so a new release shows up without waiting out
  // GitHub Pages' 10-minute browser cache.
  event.respondWith(
    fetch(req.url, { cache: 'no-cache' })
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return resp;
      })
      .catch(() => caches.match(req))
  );
});

// Rain alerts from the alert server.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Next Hour', {
    body: d.body || '',
    tag: d.tag || 'nexthour',
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data && event.notification.data.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        return w.navigate(url);
      }
    }
    return self.clients.openWindow(url);
  })());
});
