/* Typerider service worker.
   The shell is cached so an installed copy opens instantly and plays offline;
   the leaderboard API is always network-only so scores are never stale. */
const CACHE = 'typerider-v1';
const SHELL = [
  '/',
  '/play',
  '/styles.css',
  '/tracks.js',
  '/game.js',
  '/home.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // always live
  // The admin surface is same-origin on a single-host deployment, and this
  // worker's scope is the whole origin. Caching an authenticated page into
  // the shared shell cache -- and falling back to /play when it 404s or the
  // network drops -- is wrong on both counts.
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;

  // Network first, cache as the offline fallback: an update goes live on the
  // next load instead of after a manual cache clear.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/play')))
  );
});
