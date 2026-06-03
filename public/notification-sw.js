self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  const targetUrl = String(event.notification?.data?.url || '/').trim() || '/';
  event.notification.close();

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    const normalizedTarget = new URL(targetUrl, self.location.origin).href;
    for (const client of allClients) {
      if ('focus' in client) {
        try {
          const clientUrl = new URL(client.url, self.location.origin).href;
          if (clientUrl === normalizedTarget) {
            await client.focus();
            return;
          }
        } catch {
          // Ignore malformed client URLs.
        }
      }
    }

    for (const client of allClients) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) {
          await client.navigate(normalizedTarget);
        }
        return;
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(normalizedTarget);
    }
  })());
});
