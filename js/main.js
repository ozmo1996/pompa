// Start aplikacji: ładowanie Firebase, logowanie, subskrypcje bazy i odświeżanie widoków.
import { CFG } from "./logic.js";
import { $, S, VIEWS, dbRef, el, fb, isLive, safe, showView } from "./state.js";
import { renderSensors } from "./sensors.js";
import { fillLimit, initControl, onCommandUpdate, renderControl, resetControl, syncFromStatus } from "./control.js";
import { initStats, resetStats } from "./stats.js";
import { resetHistory } from "./history.js";
import { closeParamChart, initParamChart, refreshParamChart } from "./paramChart.js";
import { alarmsDenied, initAlarms, renderAlarms, setAlarms } from "./alarms.js";
import {
  initMessaging,
  initPush,
  onTestResult,
  refreshPushToken,
  registerSW,
  renderPush,
  stopPush,
  watchToken,
} from "./push.js";
import { initHeartbeat, setWeatherActiveUntil, startHeartbeat } from "./heartbeat.js";
import { initNotes, notesDenied, resetNotes, setNotes } from "./notes.js";

const SDK = (name) => `https://www.gstatic.com/firebasejs/${CFG.firebaseSdk}/firebase-${name}.js`;

/** Pełne odświeżenie widoku; każda część osobno, żeby błąd w jednej nie zatrzymał reszty. */
function render() {
  const live = isLive();
  safe(renderSensors, live);
  safe(renderControl, live);
}

let unsub = [];
function subscribe(path, onData, onError = () => {}) {
  unsub.push(fb.onValue(typeof path === "string" ? dbRef(path) : path, onData, onError));
}

function renderEvents(snapshot) {
  const events = [];
  snapshot?.forEach((c) => {
    const v = c.val();
    if (v && typeof v === "object") events.push(v);
  });
  $("events").replaceChildren(
    ...(events.length
      ? events
          .reverse()
          .map((e) =>
            el(
              "li",
              {},
              el("time", { textContent: typeof e.czas === "number" ? new Date(e.czas).toLocaleString("pl-PL") : "" }),
              String(e.opis || e.typ || "Zdarzenie"),
            ),
          )
      : [el("li", { textContent: "Brak zapisanych zdarzeń." })]),
  );
}

function onUser(u) {
  // wyczyść wszystko po poprzednim użytkowniku
  unsub.forEach((fn) => safe(fn));
  unsub = [];
  Object.assign(S, { status: null, limitCfg: null, alarms: [], connected: false, denied: false });
  resetControl();
  resetHistory();
  resetStats();
  resetNotes();
  closeParamChart();
  stopPush();
  renderAlarms();
  renderEvents(null);
  $("password").value = "";
  $("login").hidden = !!u;
  $("dashboard").hidden = !u;
  $("logout").hidden = !u;
  render();
  startHeartbeat();
  if (!u) return;

  const q = (path, n) => fb.query(dbRef(path), fb.orderByChild("czas"), fb.limitToLast(n));
  subscribe(".info/connected", (s) => {
    S.connected = s.val() === true;
    render();
    renderPush();
    renderAlarms();
  });
  subscribe(".info/serverTimeOffset", (s) => {
    S.serverOffset = Number(s.val()) || 0;
    render();
  });
  subscribe(
    "pompa/status",
    (s) => {
      const v = s.val();
      S.status = v && typeof v === "object" ? v : null;
      S.denied = false;
      syncFromStatus();
      render();
      refreshParamChart();
    },
    () => {
      S.denied = true;
      S.status = null;
      render();
    },
  );
  subscribe("pompa/ustawienia/limitMocy", (s) => {
    const v = s.val();
    S.limitCfg = v && typeof v === "object" ? v : null;
    fillLimit();
    render();
  });
  subscribe("pompa/ustawienia/pogoda/aktywnaDo", (s) => setWeatherActiveUntil(s.val()));
  subscribe("pompa/polecenie", (s) => onCommandUpdate(s.val()));
  subscribe(q("pompa/alarmy", 300), setAlarms, alarmsDenied);
  subscribe("pompa/notatki", setNotes, notesDenied);
  subscribe(q("pompa/zdarzenia", 20), renderEvents, () =>
    $("events").replaceChildren(el("li", { textContent: "Brak dostępu do historii zdarzeń." })),
  );
  subscribe("pompa/testPowiadomienia", (s) => onTestResult(s.val()));
  unsub.push(stopPush);
  watchToken();
  refreshPushToken();
  if (/tab=alarmy/.test(location.search) || location.hash === "#alarmy") showView("alarms");
}

function initLogin() {
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("submit").disabled = true;
    $("loginMessage").textContent = "Logowanie…";
    try {
      await fb.signInWithEmailAndPassword(fb.auth, $("email").value.trim(), $("password").value);
      $("loginMessage").textContent = "";
    } catch (err) {
      $("loginMessage").textContent =
        err?.code === "auth/network-request-failed"
          ? "Brak połączenia z internetem. Spróbuj ponownie."
          : err?.code === "auth/too-many-requests"
            ? "Zbyt wiele prób. Odczekaj chwilę."
            : "Nie udało się zalogować. Sprawdź adres i hasło lub ustaw nowe hasło.";
    } finally {
      $("submit").disabled = false;
    }
  });
  $("reset").addEventListener("click", async () => {
    if (!$("email").reportValidity()) return;
    $("reset").disabled = true;
    try {
      await fb.sendPasswordResetEmail(fb.auth, $("email").value.trim());
      $("loginMessage").textContent =
        "Jeśli konto istnieje, wiadomość z linkiem do ustawienia hasła została wysłana. Sprawdź skrzynkę i folder Spam.";
    } catch {
      $("loginMessage").textContent = "Nie udało się wysłać wiadomości. Sprawdź połączenie i spróbuj ponownie.";
    } finally {
      $("reset").disabled = false;
    }
  });
  $("logout").addEventListener("click", () =>
    fb.signOut(fb.auth).catch(() => ($("dataMessage").textContent = "Nie udało się wylogować. Spróbuj ponownie.")),
  );
}

async function loadFirebase() {
  const [app, auth, db] = await Promise.all([import(SDK("app")), import(SDK("auth")), import(SDK("database"))]);
  Object.assign(fb, app, auth, db);
  fb.app = app.initializeApp(CFG.firebase);
  fb.auth = auth.getAuth(fb.app);
  fb.auth.languageCode = "pl";
  fb.db = db.getDatabase(fb.app);
}

function loadFailed() {
  $("loginMessage").textContent = "Nie udało się załadować aplikacji. Sprawdź internet i spróbuj ponownie.";
  $("retryLoad").hidden = false;
}

async function boot() {
  $("appVersion").textContent = "Pompa · Panel mobilny · v" + CFG.wersja;
  $("retryLoad").addEventListener("click", () => location.reload());
  // Praca bez sieci i powiadomienia w tle — ten sam service worker.
  if ("serviceWorker" in navigator && isSecureContext) registerSW().catch(() => {});
  for (const v of VIEWS) $(v + "Tab").addEventListener("click", () => showView(v));
  initControl();
  initStats();
  initNotes();
  initParamChart();
  initAlarms();
  initPush();
  initHeartbeat();
  initLogin();

  try {
    await loadFirebase();
  } catch (e) {
    console.error(e);
    loadFailed();
    // po odzyskaniu internetu spróbuj automatycznie
    window.addEventListener("online", () => location.reload(), { once: true });
    return;
  }
  fb.onAuthStateChanged(fb.auth, (u) => safe(onUser, u));
  $("submit").disabled = false;
  $("reset").disabled = false;
  $("loginMessage").textContent = "";
  initMessaging(fb.app);
  setInterval(render, 5000); // świeżość danych zależy od upływu czasu, nie tylko od zmian w bazie
}

window.addEventListener("unhandledrejection", (e) => console.error("Nieobsłużony błąd:", e.reason));
boot().catch((e) => {
  console.error(e);
  loadFailed();
});
