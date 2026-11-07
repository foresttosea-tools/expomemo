// アプリ本体のファイルをキャッシュして、起動を速くする。
// データ（GAS との通信）はキャッシュしない。
// ファイルを更新したら VERSION を上げると、利用者の端末にも新しい版が届く。
const VERSION = 'expomemo-v11';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/brand.css',
  './css/app.css',
  './js/app.js',
  './js/api.js',
  './js/config.js',
  './js/defaults.js',
  './js/estimate.js',
  './js/mock-backend.js',
  './js/ocr-parse.js',
  './icons/logo-mark.png',
  './icons/logo-horizontal.png',
  './icons/favicon-48.png',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 同じオリジンのファイルは「キャッシュを即返しつつ裏で更新」。外部（GAS など）は素通し。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: url.pathname.endsWith('.html') || url.pathname.endsWith('/') });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
