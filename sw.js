/* NOMAD service worker — keeps the app shell available when signal drops */
const CACHE = 'nomad-v2-6-0';
const SHELL = ['./', 'index.html', 'manifest.json', 'logo.webp', 'logo-sm.webp', 'scene.webp', 'banner.webp', 'merch.webp', 'buddy.webp', 'buddy-hero.webp', 'favicon.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) {
    // Cache fonts and Leaflet so the app still looks right offline; never cache live data APIs.
    if (/fonts\.(googleapis|gstatic)\.com|unpkg\.com\/(leaflet|maplibre)/.test(req.url)) {
      e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })));
    }
    return;
  }
  if (url.pathname.endsWith('.mp4')) return; // let the browser stream video normally
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then(hit => hit || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })));
});
