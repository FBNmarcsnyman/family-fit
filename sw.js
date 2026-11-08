// Keeps the front door on the device so Family Fit opens without signal. The app's own screens and the
// family's data are kept on the device by shell.js, never here. tools/build.mjs fills in the version and file list.
const VERSION = '2a174d71a8';
const FILES = ["./","img/av/cartoon-01.svg","img/av/cartoon-02.svg","img/av/cartoon-03.svg","img/av/cartoon-04.svg","img/av/cartoon-05.svg","img/av/cartoon-06.svg","img/av/cartoon-07.svg","img/av/cartoon-08.svg","img/av/cartoon-09.svg","img/av/cartoon-10.svg","img/av/cartoon-11.svg","img/av/cartoon-12.svg","img/av/cartoon-13.svg","img/av/cartoon-14.svg","img/av/cartoon-15.svg","img/av/cartoon-16.svg","img/av/cartoon-17.svg","img/av/cartoon-18.svg","img/av/hero-01.svg","img/av/hero-02.svg","img/av/hero-03.svg","img/av/hero-04.svg","img/av/hero-05.svg","img/av/hero-06.svg","img/av/hero-07.svg","img/av/hero-08.svg","img/av/hero-09.svg","img/av/hero-10.svg","img/av/hero-11.svg","img/av/hero-12.svg","img/av/hero-13.svg","img/av/hero-14.svg","img/av/hero-15.svg","img/av/hero-16.svg","img/av/hero-17.svg","img/av/hero-18.svg","img/av/pixel-01.svg","img/av/pixel-02.svg","img/av/pixel-03.svg","img/av/pixel-04.svg","img/av/pixel-05.svg","img/av/pixel-06.svg","img/av/pixel-07.svg","img/av/pixel-08.svg","img/av/pixel-09.svg","img/av/pixel-10.svg","img/av/pixel-11.svg","img/av/pixel-12.svg","img/av/pixel-13.svg","img/av/pixel-14.svg","img/av/pixel-15.svg","img/av/pixel-16.svg","img/av/pixel-17.svg","img/av/pixel-18.svg","img/av/robot-01.svg","img/av/robot-02.svg","img/av/robot-03.svg","img/av/robot-04.svg","img/av/robot-05.svg","img/av/robot-06.svg","img/av/robot-07.svg","img/av/robot-08.svg","img/av/robot-09.svg","img/av/robot-10.svg","img/av/robot-11.svg","img/av/robot-12.svg","img/av/robot-13.svg","img/av/robot-14.svg","img/av/robot-15.svg","img/av/robot-16.svg","img/av/robot-17.svg","img/av/robot-18.svg","img/hero-jump.webp","img/icon-180.png","img/icon-192.png","img/icon-512.png","img/icon-maskable-512.png","manifest.webmanifest","shell.css","shell.js"];
const CACHE = 'family-fit-' + VERSION;
const FONTS = 'family-fit-fonts';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('family-fit-') && k !== CACHE && k !== FONTS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Fonts: kept once fetched, so the app looks the same offline.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { c.put(req, res.clone()); return res; }))));
    return;
  }
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  // Opening the app: the newest page if there's signal, the saved one if not.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./', { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
