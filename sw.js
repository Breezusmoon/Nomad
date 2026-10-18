/* NOMAD service worker — keeps the app shell available when signal drops */
const CACHE = 'nomad-v2-9-0';
const SHELL = ['./', 'index.html', 'manifest.json', 'logo.webp', 'logo-sm.webp', 'scene.webp', 'banner.webp', 'merch.webp', 'av-kombi.webp', 'favicon.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'nomad-tiles').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/tiles\.openfreemap\.org|arcgisonline\.com/.test(req.url)) {
    // Map tiles, style, fonts and icons: serve from cache instantly (works offline), refresh in background
    e.respondWith(caches.open('nomad-tiles').then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => { if (res.ok) { c.put(req, res.clone()); trimTiles(c); } return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
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

let _trimT = 0;
function trimTiles(c){ if (_trimT) return; _trimT = setTimeout(async () => { _trimT = 0; const k = await c.keys(); if (k.length > 3000) for (const r of k.slice(0, k.length - 3000)) await c.delete(r); }, 5000); }
