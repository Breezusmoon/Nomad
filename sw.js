/* NOMAD service worker — keeps the app, map engine, map tiles and places available when signal drops.
   Caches:
     CACHE        app shell (replaced on each release)
     nomad-libs   map engine + fonts (kept across releases)
     nomad-tiles  map tiles/styles/glyphs (kept across releases, capped)
     nomad-data   places database tiles (kept across releases, capped) */
const CACHE = 'nomad-v2-51-0';
const KEEP = ['nomad-libs', 'nomad-tiles', 'nomad-data', 'nomad-fuel'];
const SHELL = ['./', 'index.html', 'manifest.json', 'logo.webp', 'logo-sm.webp', 'scene.webp', 'banner.webp', 'av-kombi.webp', 'favicon.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && !KEEP.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const cacheFirst = (name, req, cap) => caches.open(name).then(async c => {
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) { c.put(req, res.clone()); if (cap) trim(c, cap); }
  return res;
});
const staleWhileRevalidate = (name, req, cap) => caches.open(name).then(async c => {
  const hit = await c.match(req);
  const net = fetch(req).then(res => { if (res.ok) { c.put(req, res.clone()); if (cap) trim(c, cap); } return res; }).catch(() => hit);
  return hit || net;
});
const networkFirst = (name, req) => fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(name).then(c => c.put(req, copy)); } return res; })
  .catch(() => caches.open(name).then(c => c.match(req, {ignoreSearch: true})));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles, styles, fonts, icons: instant from cache, refreshed in the background
  if (/tiles\.openfreemap\.org|arcgisonline\.com/.test(req.url)) { e.respondWith(staleWhileRevalidate('nomad-tiles', req, 3000)); return; }

  if (url.origin !== location.origin) {
    // Map engine + web fonts: keep forever (versioned URLs)
    if (/fonts\.(googleapis|gstatic)\.com|unpkg\.com\/(leaflet|maplibre)/.test(req.url)) e.respondWith(cacheFirst('nomad-libs', req));
    return; // never cache live APIs (weather, routing, search, fuel)
  }

  if (url.pathname.endsWith('.mp4')) return; // let the browser stream video

  // Places database: index always checked fresh; tiles are versioned, so cache-first and keep
  if (/\/data\/meta\.json$/.test(url.pathname)) { e.respondWith(networkFirst('nomad-data', req)); return; }
  if (/\/data\/(t\/|fuel_osm)/.test(url.pathname)) { e.respondWith(cacheFirst('nomad-data', req, 600)); return; }

  // App pages: network first so updates land, cached copy when offline
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req, {ignoreSearch: true}).then(hit => hit || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; })));
});

const _trimT = {};
function trim(c, cap){
  const k = cap; if (_trimT[k]) return;
  _trimT[k] = setTimeout(async () => { _trimT[k] = 0; const keys = await c.keys(); if (keys.length > cap) for (const r of keys.slice(0, keys.length - cap)) await c.delete(r); }, 5000);
}
