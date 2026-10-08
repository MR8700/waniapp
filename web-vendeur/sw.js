const CACHE = 'wani-vendeur-v3';
const prefix = self.registration.scope.includes('/vendeur') ? '/vendeur' : '';
const ASSETS = [
  prefix + '/',
  prefix + '/style.css',
  prefix + '/app.js',
  prefix + '/keystore.js',
  prefix + '/config.js',
  prefix + '/manifest.json',
  prefix + '/icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/auth') || url.pathname === '/events' || url.pathname === '/realtime' || url.pathname.startsWith('/orders') || url.pathname.startsWith('/establishments') || url.pathname.startsWith('/products')) {
    return;
  }
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.status === 200 && e.request.method === 'GET') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
