// Permite abrir la app del jurado sin red (RT-6). Solo cachea la interfaz, nunca las respuestas de la API.
const CACHE = 'jurado-v1';
const SHELL = [
  '/jurado.html',
  '/app.css',
  '/js/jurado-page.js',
  '/js/jurado-client.js',
  '/js/outbox.js',
  '/js/backoff.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('fetch', (event) => {
  const { pathname } = new URL(event.request.url);
  if (event.request.method !== 'GET' || !SHELL.includes(pathname)) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
