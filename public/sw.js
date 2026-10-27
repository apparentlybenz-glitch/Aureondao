// AureonX offline shell. Precaches only /offline. The fetch handler touches
// navigation requests only: network first, and /offline when the network fails.
// It never caches app pages, /_next assets, Supabase, /md/v1 or market data.
// Bump VERSION to replace the cached page; old caches are deleted on activate.
const VERSION = "v1";
const CACHE = `aureonx-offline-${VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cached = await caches.match(OFFLINE_URL, { cacheName: CACHE });
      return cached ?? Response.error();
    }),
  );
});
