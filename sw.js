const CACHE = 'adtmcplus-v4';
const TOOL_CACHE = 'adtmcplus-tool-html-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './apps/adtmc/',
  './apps/adtmc/index.html',
  './apps/msktool/',
  './apps/msktool/index.html'
];
const TOOL_URLS = new Set([
  'https://cdn.jsdelivr.net/gh/matthewdholtkamp/ADTMC@main/index.html',
  'https://cdn.jsdelivr.net/gh/matthewdholtkamp/MSKTool@main/index.html'
]);

self.addEventListener('install', evt => {
  evt.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => key !== CACHE && key !== TOOL_CACHE)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', evt => {
  const { request } = evt;
  if (request.method !== 'GET') return;

  if (TOOL_URLS.has(request.url)) {
    evt.respondWith(
      fetch(request).then(res => {
        const clone = res.clone();
        caches.open(TOOL_CACHE).then(cache => cache.put(request, clone));
        return res;
      }).catch(() => caches.match(request).then(cached => cached || new Response('Tool unavailable offline.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      })))
    );
    return;
  }

  evt.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(cache => cache.put(request, clone));
      return res;
    }).catch(() => {
      if (request.mode === 'navigate') return caches.match('./index.html');
      return new Response('Asset unavailable offline.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }))
  );
});
