// App shell: network first so updates show up straight away, cache as the offline fallback.
// Radar, model and map-tile requests always go to the network.
const CACHE = 'nexthour-v3';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
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
