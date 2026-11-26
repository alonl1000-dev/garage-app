// Offline cache: the app shell and catalog are served from cache, refreshed in the background.
const CACHE = 'garage-v3';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'engine.js', 'services.js', 'manifest.json', 'icon.svg', 'cloud.js', 'config.js',
  'data/kits.json', 'data/models.json', 'data/jobs.json'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => {
    const net = fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; }).catch(() => hit);
    return hit || net;
  }));
});
