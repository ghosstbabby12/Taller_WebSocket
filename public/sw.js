// Permite abrir la app del jurado sin red (RT-6). Cachea la interfaz y el catálogo; nunca resultados ni envíos.
const CACHE = 'jurado-v2';
const SHELL = [
  '/jurado.html',
  '/app.css',
  '/js/jurado-page.js',
  '/js/jurado-client.js',
  '/js/outbox.js',
  '/js/backoff.js',
  '/js/catalog.js',
  '/api/public/catalog',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const { pathname } = new URL(event.request.url);
  if (event.request.method !== 'GET' || !SHELL.includes(pathname)) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
