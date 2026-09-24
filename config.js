// Jedno źródło konfiguracji dla aplikacji (import w modułach JS) i service workera (importScripts).
// Plik celowo nie używa import/export, żeby działał w obu kontekstach.
globalThis.POMPA_CONFIG = Object.freeze({
  wersja: "2.13",

  zbiornik: Object.freeze({ wysokoscCm: 250 }), // zakres sondy 0–2,5 m; do kalibracji po montazu

  // Wersja Firebase JS SDK — zmieniaj tylko tutaj.
  firebaseSdk: "12.2.1",
  firebase: Object.freeze({
    apiKey: "AIzaSyC7jEuVnRgWDx6RpE_hc_rQ5udomIYkmtU",
    authDomain: "pompa-bdd30.firebaseapp.com",
    databaseURL: "https://pompa-bdd30-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "pompa-bdd30",
    messagingSenderId: "992311940364",
    appId: "1:992311940364:web:12541fac7e9ff6e0ffe529",
  }),
  // Firebase Console → Ustawienia projektu → Cloud Messaging → Certyfikaty Web Push
  vapidKey: "BEFA0lzTQ_aJuBbWtvhAaQUW01iPyb8wjb3iY7MyDdM7KJR0ARVihQDyG1KDSSYq5PWcY--t9broNysc_4QolBo",

  // Dane tabliczki znamionowej silnika i falownika.
  silnik: Object.freeze({
    mocZnamionowaKw: 90,
    pradZnamionowyA: 159,
    cosPhi: 0.91,
    mocSkaliKw: 110, // koniec skali licznika mocy
    maxHz: 50,
  }),

  // Zakresy dopuszczalne w formularzach.
  limity: Object.freeze({ limitKwMin: 10, limitKwMax: 110 }),

  // Progi ostrzeżeń i czasy (ms).
  progi: Object.freeze({
    swiezoscStatusuMs: 30000, // status starszy niż to = dane nieaktualne
    swiezoscPogodyMs: 12 * 60000,
    tolerancjaPrzyszlosciMs: 60000, // znacznik czasu z przyszłości (zegar Raspberry) nadal akceptowany
    potwierdzeniePoleceniaMs: 20000,
    ostrzezenieSkokuHz: 5,
    blizkoLimituMocy: 0.97,
    temperaturaZamarzaniaC: 1,
    termometrMokryMaxC: -2, // powyżej — gorsze warunki do naśnieżania
    cisnienieStacjiHpa: 920, // ok. 800 m n.p.m.
  }),

  // Puls pogody: otwarta aplikacja prosi Raspberry o częstsze pobieranie pogody.
  pogoda: Object.freeze({
    stacjaDomyslna: "IBYSTR6",
    pulsCoMs: 15000,
    waznoscMs: 60000,
    zapisGdyZostaloMs: 35000,
    pulsWTleMaxMs: 10 * 60000, // aplikacja w tle dłużej niż to przestaje podtrzymywać tryb 30 s
  }),

  historia: Object.freeze({
    maxDni: 30,
    probekNaDzien: 1440, // Raspberry zapisuje podsumowanie co ok. 1 min
    oknoWykresuParametruMs: 6 * 3600e3,
  }),
});
