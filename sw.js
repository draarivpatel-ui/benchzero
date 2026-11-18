// Offline cache for BenchZero. Every path is relative to this file, so the app works at any
// subpath (for example /benchzero/). Stale-while-revalidate: serve the cache, refresh it quietly.
const CACHE = 'benchzero-v1';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './icon.svg',
  './manifest.webmanifest',
  './fonts/benchzero-segment.woff2',
  './src/app.js',
  './src/audio.js',
  './src/bridge.js',
  './src/compute.js',
  './src/fft.js',
  './src/mna.js',
  './src/presets.js',
  './src/schematic.js',
  './src/scope.js',
  './src/serialize.js',
  './src/theory.js',
  './src/units.js',
  './src/waves.js',
  './src/worker.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('benchzero-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req)
        .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      const res = await net;
      return res || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error());
    }),
  );
});
