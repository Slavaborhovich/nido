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

/* ---------- push notifications ---------- */
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { data: { body: e.data && e.data.text() } }; }
  const data = d.data || {}, n = d.notification || {};
  const title = data.title || n.title || "Nido";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || n.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    dir: "rtl", lang: "he",
    data: { tab: data.tab || "" },
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const tab = (e.notification.data || {}).tab || "";
  const url = self.registration.scope + (tab ? "?tab=" + tab : "");
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) { c.postMessage({ tab }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
