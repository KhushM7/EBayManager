// The service worker: shows approval pushes and acts on Approve / Reject from the notification,
// and keeps the app shell available offline. API data is never cached.

const SHELL = "shell-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon-192.png"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/decide/") || url.pathname.startsWith("/oauth/")) return;

  // Pages: network first, the cached shell when offline. Hashed assets: cache first.
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(event.request, copy));
            return res;
          }),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  let msg = { title: "New update", body: "" };
  try {
    msg = event.data.json();
  } catch {}
  const actionable = Boolean(msg.approveUrl && msg.rejectUrl);
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      tag: msg.tag,
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      requireInteraction: actionable,
      data: { approveUrl: msg.approveUrl, rejectUrl: msg.rejectUrl },
      actions: actionable
        ? [
            { action: "approve", title: "Approve" },
            { action: "reject", title: "Reject" },
          ]
        : [],
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const url = event.action === "approve" ? n.data?.approveUrl : event.action === "reject" ? n.data?.rejectUrl : null;
  n.close();

  if (!url) {
    // Tapping the notification body opens the Inbox to review it there.
    event.waitUntil(
      self.clients.matchAll({ type: "window" }).then((wins) => {
        const open = wins.find((w) => new URL(w.url).origin === location.origin);
        return open ? open.focus() : self.clients.openWindow("/");
      }),
    );
    return;
  }

  // The signed decide link, POSTed: the same path as tapping the button on the confirmation page.
  event.waitUntil(
    fetch(url, { method: "POST", headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(({ result }) => self.registration.showNotification(result, { body: n.title, tag: n.tag, icon: "/icon-192.png", badge: "/badge-96.png" }))
      .catch((e) =>
        self.registration.showNotification("Not done: open the app to retry", {
          body: `${n.title} (${e.message})`,
          tag: n.tag,
          icon: "/icon-192.png",
          badge: "/badge-96.png",
        }),
      ),
  );
});
