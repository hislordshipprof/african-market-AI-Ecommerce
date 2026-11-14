// Store-admin alerts only: no caching, no fetch handler.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "New order", {
      body: data.body || "",
      data: { url: data.url || "/store-admin/orders" },
      tag: data.tag || "new-order",
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/store-admin/orders", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).pathname === target.pathname);
      if (open) {
        open.navigate(target.href).catch(() => undefined);
        return open.focus();
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
