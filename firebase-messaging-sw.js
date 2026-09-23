// Service worker aplikacji — musi leżeć w tym samym katalogu co index.html.
// 1) powiadomienia push w tle (Firebase Cloud Messaging),
// 2) praca bez sieci: pliki aplikacji zawsze najpierw z sieci, kopia z pamięci tylko gdy sieci brak.
//    Dzięki temu po wdrożeniu nowej wersji telefon nigdy nie zostaje na starej.
importScripts("config.js");
const CFG = self.POMPA_CONFIG;
// Błąd ładowania (np. brak sieci przy aktualizacji) przerywa instalację nowej wersji,
// więc telefon zostaje przy poprzedniej, działającej — powiadomienia nie znikną po cichu.
importScripts(
  `https://www.gstatic.com/firebasejs/${CFG.firebaseSdk}/firebase-app-compat.js`,
  `https://www.gstatic.com/firebasejs/${CFG.firebaseSdk}/firebase-messaging-compat.js`,
);

// ---------- praca bez sieci ----------
const CACHE = "pompa-" + CFG.wersja;
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "config.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "js/main.js",
  "js/logic.js",
  "js/state.js",
  "js/sensors.js",
  "js/control.js",
  "js/history.js",
  "js/stats.js",
  "js/paramChart.js",
  "js/alarms.js",
  "js/push.js",
  "js/heartbeat.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // pojedynczy brakujący plik nie może zablokować instalacji (powiadomienia są ważniejsze)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith("pompa-") && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request,
    url = new URL(req.url);
  // tylko własne pliki; Firebase i inne serwisy zawsze bezpośrednio przez sieć
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches
            .open(CACHE)
            .then((c) => c.put(req, copy))
            .catch(() => {});
        }
        return res;
      } catch (e) {
        const hit =
          (await caches.match(req, { ignoreSearch: true })) ||
          (req.mode === "navigate" && (await caches.match("index.html")));
        if (hit) return hit;
        throw e;
      }
    })(),
  );
});

// ---------- powiadomienia ----------
// Wiadomości przychodzą jako "data" — powiadomienie budujemy sami (gdy aplikacja jest w tle lub zamknięta).
firebase.initializeApp(CFG.firebase);
firebase.messaging().onBackgroundMessage(showAlarm);
function showAlarm(payload) {
  const d = payload.data || {};
  const awaria = d.poziom === "awaria";
  return self.registration.showNotification(d.tytul || "Pompa", {
    body: d.tresc || "",
    tag: d.typ || "pompa",
    renotify: true,
    requireInteraction: awaria,
    icon: "icon-192.png",
    badge: "icon-192.png",
    vibrate: awaria ? [400, 200, 400, 200, 400] : [200],
    timestamp: Number(d.czas) || Date.now(),
    data: { url: "./?tab=alarmy" },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope)) {
          c.postMessage({ typ: "otworzAlarmy" });
          return c.focus();
        }
      }
      return clients.openWindow(url);
    })(),
  );
});
