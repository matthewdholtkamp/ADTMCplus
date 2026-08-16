const CACHE = 'adtmcplus-v18-freshness';

// Precached so the app works fully offline / from a network drive.
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './ask-dr-holtkamp.css',
  './ask-dr-holtkamp.js'
];

// Clinical content lives in these files. They are served network-first so a
// published correction reaches users on their next load. A cache-first policy
// here would pin clients to whatever version they happened to cache first,
// which for algorithm content means silently serving withdrawn guidance.
const CONTENT = ['/', '/index.html', '/ask-dr-holtkamp.js', '/ask-dr-holtkamp.css'];

function isContentRequest(request) {
  if (request.mode === 'navigate') return true;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  return CONTENT.some(path => url.pathname.endsWith(path));
}

self.addEventListener('install', evt => {
  evt.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => key !== CACHE)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', evt => {
  const { request } = evt;
  if (request.method !== 'GET') return;

  // Network-first for clinical content: fresh when online, cached when not.
  if (isContentRequest(request)) {
    evt.respondWith(
      fetch(request)
        .then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(cache => cache.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request).then(cached => (
          cached ||
          caches.match('./index.html') ||
          new Response('Asset unavailable offline.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          })
        )))
    );
    return;
  }

  // Cache-first for static assets (icons, manifest) — these do not carry
  // clinical guidance and benefit from the faster path.
  evt.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(res => {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(cache => cache.put(request, clone));
      }
      return res;
    }).catch(() => new Response('Asset unavailable offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })))
  );
});
