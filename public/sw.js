// Offline cache for the stall laptop.
//
// This file is a template: on `vite build`, the precache plugin in
// vite.config.ts rewrites dist/sw.js, replacing the PRECACHE expression with
// the real list of emitted assets + MediaPipe files and the BUILD token with a
// content hash, so every changed build gets a fresh cache name. Unbuilt, it is
// still valid JS and just precaches the page.
//
// Navigations are network-first (a redeploy is picked up when online, cache
// when not); everything else is cache-first (hashed assets and models never
// change under the same URL).
const BUILD = '__BUILD__';
const CACHE = `ppc-${BUILD}`;
const PRECACHE = self.__PRECACHE__ || ['./'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put('./', copy));
          }
          return res;
        })
        .catch(() => caches.match('./', { cacheName: CACHE }).then((hit) => hit || Response.error())),
    );
    return;
  }

  e.respondWith(
    caches.match(req, { cacheName: CACHE }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
