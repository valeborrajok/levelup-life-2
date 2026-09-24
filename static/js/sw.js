/*
 * sw.js — Service worker mínimo de LevelUp Life.
 *
 * Objetivo único: que la app abra (aunque sea con datos viejos) si no hay
 * conexión. No intenta cachear /api/* — esos siempre van a la red, porque
 * mostrar misiones/oro desactualizados sería peor que mostrar un error.
 *
 * Se sirve desde la raíz (/sw.js, ver la ruta dedicada en app.py) para que
 * su alcance ("scope") cubra toda la app y no solo /static/.
 */
const CACHE_NAME = "levelup-life-shell-v5";
const SHELL_URLS = [
  "/",
  "/static/css/style.css",
  "/static/js/app.js",
  "/static/manifest.json",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // La API nunca se cachea: siempre a la red. Si falla (sin conexión),
  // que falle explícitamente — el frontend ya sabe mostrar ese error.
  if (request.url.includes("/api/")) {
    return;
  }

  // Resto del shell: cache-first con actualización en segundo plano.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
