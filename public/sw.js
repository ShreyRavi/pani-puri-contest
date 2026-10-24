// Offline cache for the stall laptop.
//
// This file is a template: on `vite build`, the precache plugin in
// vite.config.ts rewrites dist/sw.js, replacing the PRECACHE expression with
// the real list of emitted assets + MediaPipe files, the BUILD token with a
// hash of that list (and file contents), and the MODELS token with a hash of the
// model files' contents. Unbuilt, it is still valid JS and just precaches the page.
//
// Two caches:
//  - ppc-<BUILD>: page + hashed assets, replaced every deploy.
//  - ppc-models-<MODELS>: the ~24 MB MediaPipe files, kept across deploys until they change.
//
// A new version waits (no automatic skipWaiting) so an open stall page never
// loses the files it is running. The page asks it to take over only when no
// round is in progress, then reloads.
//
// Navigations are network-first with a short timeout (a redeploy is picked up
// when online; weak venue wifi or a captive portal falls back to the cache fast);
// everything else is cache-first.
const BUILD = '__BUILD__';
const MODELS = '__MODELS__';
const CACHE = `ppc-${BUILD}`;
const MODEL_CACHE = `ppc-models-${MODELS}`;
const PRECACHE = self.__PRECACHE__ || ['./'];
const isModel = (path) => path.includes('/mediapipe/');
const NAV_TIMEOUT_MS = 3000;

self.addEventListener('install', (e) => {
  const models = PRECACHE.filter(isModel);
  const app = PRECACHE.filter((p) => !isModel(p));
  e.waitUntil(
    Promise.all([
      caches.open(CACHE).then((c) => c.addAll(app)),
      caches.open(MODEL_CACHE).then(async (c) => {
        // Skip models this cache already holds from an earlier deploy.
        const have = await Promise.all(models.map((m) => c.match(m)));
        return c.addAll(models.filter((_, i) => !have[i]));
      }),
    ]),
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('ppc-') && k !== CACHE && k !== MODEL_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    const cached = () => caches.match('./', { cacheName: CACHE });
    let servedCache = false;
    const network = fetch(req).then((res) => {
      // Only the app's own page may become the offline shell, never another URL opened in a tab, and only
      // when it is the page that rendered: a late page from a newer deploy would not match this cache's assets.
      const isShell = new URL('./', self.location.href).pathname === url.pathname || url.pathname.endsWith('/index.html');
      if (!servedCache && res.ok && isShell && (res.headers.get('content-type') || '').includes('text/html')) {
        const copy = res.clone();
        void caches.open(CACHE).then((c) => c.put('./', copy));
      }
      return res;
    });
    // Whichever comes first: the network page, or the cached page once NAV_TIMEOUT_MS passes.
    const slow = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS))
      .then(() => cached())
      .then((hit) => {
        if (!hit) return network;
        servedCache = true;
        return hit;
      });
    e.respondWith(
      Promise.race([network, slow]).catch(() => cached().then((hit) => hit || Response.error())),
    );
    return;
  }

  const store = isModel(url.pathname) ? MODEL_CACHE : CACHE;
  e.respondWith(
    caches.match(req, { cacheName: store }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(store).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
