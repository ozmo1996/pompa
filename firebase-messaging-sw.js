// Service worker powiadomień — musi leżeć w tym samym katalogu co index.html
importScripts('https://www.gstatic.com/firebasejs/12.2.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.2.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyC7jEuVnRgWDx6RpE_hc_rQ5udomIYkmtU',
  authDomain: 'pompa-bdd30.firebaseapp.com',
  databaseURL: 'https://pompa-bdd30-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'pompa-bdd30',
  messagingSenderId: '992311940364',
  appId: '1:992311940364:web:12541fac7e9ff6e0ffe529',
});

const messaging = firebase.messaging();

// Wiadomości przychodzą jako "data" — powiadomienie budujemy sami (gdy aplikacja jest w tle lub zamknięta)
messaging.onBackgroundMessage(payload => {
  const d = payload.data || {};
  const awaria = d.poziom === 'awaria';
  return self.registration.showNotification(d.tytul || 'Pompa', {
    body: d.tresc || '',
    tag: d.typ || 'pompa',
    renotify: true,
    requireInteraction: awaria,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    vibrate: awaria ? [400, 200, 400, 200, 400] : [200],
    timestamp: Number(d.czas) || Date.now(),
    data: { url: './?tab=alarmy' },
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) {
        c.postMessage({ typ: 'otworzAlarmy' });
        return c.focus();
      }
    }
    return clients.openWindow(url);
  })());
});
