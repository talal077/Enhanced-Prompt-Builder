const CACHE_VERSION = "v1";
const SHELL_CACHE   = "app-shell-" + CACHE_VERSION;
const OFFLINE_URL   = "/offline.html";

// Resources to pre-cache on install (app shell)
const SHELL_ASSETS = [
  "/",
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// ── Install: pre-cache app shell ──────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: purge old caches ────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: routing strategy ───────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Never intercept API calls or download streams — always go to network
  if (url.pathname.startsWith("/api/")) {
    return; // fall through to browser default (network)
  }

  // 2. Never intercept non-GET requests
  if (request.method !== "GET") {
    return;
  }

  // 3. Never intercept cross-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // 4. Navigation requests (HTML pages) — network-first, offline fallback
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // 5. Static assets — cache-first, fallback to network
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        // Only cache valid responses for same-origin static assets
        if (
          response.ok &&
          response.type === "basic" &&
          (url.pathname.match(/\.(js|css|png|svg|ico|woff2?|ttf)$/) ||
           url.pathname === "/")
        ) {
          const toCache = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, toCache));
        }
        return response;
      });
    })
  );
});
