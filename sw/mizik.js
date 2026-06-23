const CACHE_NAME = '5';
const urlsToCache = [
  '/v=4'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        return response || fetch(event.request);
      })
  );
});

self.addEventListener('message', event => {
  if (event.data.type === 'SHOW_NOTIFICATION') {
    const options = {
      body: event.data.body,
      icon: 'https://mizik.adamdh7.org/Mizik.png',
      badge: 'https://mizik.adamdh7.org/Mizik.png',
      tag: event.data.tag || Date.now().toString(),
      data: { tfid: event.data.tfid || '' }
    };
    self.registration.showNotification(event.data.title || "D'H7", options);
  }
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const tfid = event.notification.data ? event.notification.data.tfid : '';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      if (clientList.length > 0) {
        let client = clientList[0];
        if (tfid) client.navigate('/' + tfid);
        client.focus();
        return;
      }
      return clients.openWindow(tfid ? '/' + tfid : '/');
    })
  );
});
