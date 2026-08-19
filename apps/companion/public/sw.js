// Minimal Tarmoto companion service worker, ported from tabletap's PWA
// (Studio81Labs/tabletap apps/pwa/public/sw.js).
//
// Goal: meet PWA install criteria + give a usable shell when offline. We
// deliberately stay hand-rolled and tiny: full Workbox-style asset caching
// and offline mutations are out of scope. This file is what makes the
// "Install app" affordance appear (desktop Chrome's omnibox icon included)
// and what lets a dead connection in the garage fall back to a cached shell
// instead of a browser error page.
//
// We precache `/explore` (the public map entry + manifest start_url), NOT
// `/`: the root route redirects (to /login for signed-out visitors), and the
// Cache API rejects `cache.addAll`/`put` for redirected responses —
// precaching `/` would make the whole install handler reject and the service
// worker would never install (losing the offline shell and installability).

// Bump on any change to a precached/cache-first asset (e.g. an icon rebrand)
// so existing installs reinstall the worker, re-precache the fresh assets,
// and the activate handler drops the stale cache.
const CACHE_VERSION = "tarmoto-v1";
// `/login` is precached alongside `/explore`: an offline-launched install
// whose session has lapsed lands on the sign-in surface instead of a
// network-error page.
const PRECACHE_URLS = [
  "/explore",
  "/login",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigation requests: network-first. On failure serve the cached copy of
  // the *requested* route when we have one (e.g. /login is precached, so it
  // stays reachable offline), falling back to the /explore shell for anything
  // else so a dropped connection lands on a recognizable surface instead of
  // "no internet".
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => {
        const cached = await caches.match(req, { ignoreSearch: true });
        return cached ?? caches.match("/explore");
      }),
    );
    return;
  }

  // Static assets: cache-first with a background network refresh that we tie
  // to the fetch event's lifetime via event.waitUntil so the SW isn't
  // terminated before the put resolves (otherwise the "fresh" copy may
  // never land and the cache stays stale on low-resource devices).
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/icon.svg"
  ) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) {
          const refresh = (async () => {
            try {
              const res = await fetch(req);
              if (res.ok) {
                const cache = await caches.open(CACHE_VERSION);
                await cache.put(req, res.clone());
              }
            } catch {
              // Network unavailable — keep the cached copy.
            }
          })();
          event.waitUntil(refresh);
          return cached;
        }
        // No cache hit — populate the cache and return the network response.
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE_VERSION);
          await cache.put(req, res.clone());
        }
        return res;
      })(),
    );
  }
});
