/* Nido service worker — the app opens offline; online it always fetches the newest version. */
const CACHE = "nido-shell-" + new URL(self.registration.scope).pathname;
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  // static libraries & fonts: cache first
  if (["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }));
    return;
  }
  // the app itself: network first, fall back to the saved copy
  if (url.origin === scope.origin && url.pathname.startsWith(scope.pathname)) {
    // don't let the prod worker swallow the test environment
    if (scope.pathname !== url.pathname && url.pathname.startsWith(scope.pathname + "test/") && !scope.pathname.endsWith("/test/")) return;
    e.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match("./"))));
  }
});
