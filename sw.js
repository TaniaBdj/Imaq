/* Imaq service worker: precaches the app shell so the app runs with no Internet. */
const CACHE = 'imaq-v8';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './css/roles.css',
  './js/app.js',
  './js/session.js',
  './js/detection.js',
  './js/analysis.js',
  './js/sensor-data.js',
  './js/storage.js',
  './js/i18n.js',
  './js/core/tank.js',
  './js/ops/store.js',
  './js/ops/api-repository.js',
  './js/ops/selectors.js',
  './js/ops/priority.js',
  './js/ops/routes.js',
  './js/ui/common.js',
  './js/ui/welcome.js',
  './js/ui/resident.js',
  './js/ui/driver.js',
  './js/ui/admin.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate: answer instantly from cache (works offline), and
// refresh the cache in the background when a network is available so that
// updated app files arrive on the next launch.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Live operational data is never served from the service-worker cache.
  // (The app keeps its own last-synced copy and labels it as such when offline.)
  if (url.pathname.includes('/api/')) return;
  const key = req.mode === 'navigate' ? './index.html' : req;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const res = await network;
      return res || new Response('Offline and not cached', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }),
  );
});
