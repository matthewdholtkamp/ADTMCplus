const CACHE = 'adtmcplus-v2';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './apps/adtmc/index.html',
  './apps/msktool/index.html'
];

self.addEventListener('install', (evt) => {
  evt.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (evt) => {
  if (evt.request.method !== 'GET') return;
  evt.respondWith(
    caches.match(evt.request).then((cached) => cached || fetch(evt.request).catch(() => caches.match('./index.html')))
  );
});
