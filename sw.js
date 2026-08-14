// IMPORTANT: bump this version string (v1 -> v2 -> v3...) every single time
// you edit index.html, style.css, or app.js and push a new deploy. Changing
// this string is what forces the browser to notice sw.js changed, install a
// fresh service worker, and throw away old cached files — otherwise phones
// keep serving stale, possibly mismatched copies of your files indefinitely.
const CACHE = 'wren-v5';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      const resClone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, resClone));
      return res;
    }).catch(() => cached))
  );
});
