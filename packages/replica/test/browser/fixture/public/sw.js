/**
 * Test-only fixture service worker (TC-19): caches the page shell, the Vite
 * bundle and the replica worker so an offline reload still boots the app and
 * exercises IndexedDB reads. Cache-on-read (no precache manifest needed);
 * cross-origin traffic — the node — is never touched.
 */
const CACHE = "tc-replica-fixture-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request, response.clone());
        return response;
      } catch (error) {
        const cached = await cache.match(event.request, { ignoreSearch: true });
        if (cached !== undefined) return cached;
        throw error;
      }
    })(),
  );
});
