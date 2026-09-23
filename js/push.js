// Powiadomienia push (Firebase Cloud Messaging) na tym urządzeniu.
import { CFG } from "./logic.js";
import { $, S, dbRef, fb, now, onShowView, showView, user } from "./state.js";
import { showToast } from "./alarms.js";

const SW_FILE = "firebase-messaging-sw.js",
  KEY_STORE = "pompaPushKey";
let msgApi = null,
  supported = null, // null — sprawdzanie, false — brak obsługi
  tokenRec = null,
  tokenUnsub = null,
  testTimer = null;

const vapidOk = () => CFG.vapidKey.length > 60;
const isStandalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const deviceName = () =>
  (/Android/i.test(navigator.userAgent) ? "Android" : isIOS() ? "iPhone/iPad" : "Komputer") +
  (isStandalone() ? " · aplikacja" : " · przeglądarka");
const permission = () => (typeof Notification === "undefined" ? "default" : Notification.permission);

const storedKey = () => {
  try {
    return localStorage.getItem(KEY_STORE) || "";
  } catch {
    return "";
  }
};
function setStoredKey(k) {
  try {
    k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE);
  } catch {}
  watchToken();
}
async function tokenKey(token) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(h)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Service worker (powiadomienia w tle + praca bez sieci). Rejestracja jest idempotentna. */
export const registerSW = () => navigator.serviceWorker.register(SW_FILE);

export async function initMessaging(app) {
  try {
    if (!("serviceWorker" in navigator) || !("Notification" in window) || !isSecureContext) return (supported = false);
    const m = await import(`https://www.gstatic.com/firebasejs/${CFG.firebaseSdk}/firebase-messaging.js`);
    if (!(await m.isSupported())) return (supported = false);
    msgApi = { ...m, messaging: m.getMessaging(app) };
    m.onMessage(msgApi.messaging, (p) => showToast(p.data));
    navigator.serviceWorker.addEventListener("message", (e) => e.data?.typ === "otworzAlarmy" && showView("alarms"));
    supported = true;
  } catch {
    supported = false;
  } finally {
    renderPush();
  }
}

export function watchToken() {
  tokenUnsub?.();
  tokenUnsub = null;
  tokenRec = null;
  const k = storedKey();
  if (k && user())
    tokenUnsub = fb.onValue(
      dbRef("pompa/tokeny/" + k),
      (s) => {
        tokenRec = s.val();
        if (tokenRec && tokenRec.uid !== user()?.uid) tokenRec = null;
        renderPush();
      },
      () => {
        tokenRec = null;
        renderPush();
      },
    );
  renderPush();
}
export function stopPush() {
  tokenUnsub?.();
  tokenUnsub = null;
  tokenRec = null;
  clearTimeout(testTimer);
}

export function renderPush() {
  const st = $("pushState"),
    en = $("pushEnable"),
    on = !!tokenRec && permission() === "granted";
  en.hidden = true;
  en.className = "";
  $("pushTest").hidden = !on;
  $("pushWarnRow").hidden = !on;
  if (supported === null) return void (st.textContent = "Sprawdzanie obsługi powiadomień…");
  if (!supported)
    return void (st.textContent =
      isIOS() && !isStandalone()
        ? "Na iPhonie powiadomienia działają tylko w aplikacji dodanej do ekranu początkowego (Safari → Udostępnij → Do ekranu początkowego, iOS 16.4+). Otwórz ją z ikony i wróć tutaj."
        : "Ta przeglądarka nie obsługuje powiadomień push. Użyj Chrome na Androidzie.");
  if (!vapidOk())
    return void (st.textContent =
      "Powiadomienia nie są jeszcze skonfigurowane — w pliku config.js brakuje klucza VAPID.");
  if (permission() === "denied")
    return void (st.textContent =
      "Powiadomienia są zablokowane dla tej strony. Odblokuj je: Chrome → ⋮ → Ustawienia → Ustawienia witryn → Powiadomienia.");
  en.hidden = false;
  en.disabled = !S.connected;
  if (on) {
    st.textContent = "Włączone na tym urządzeniu. Awarie przychodzą zawsze, także przy zamkniętej aplikacji.";
    en.textContent = "Wyłącz na tym urządzeniu";
    en.className = "secondary";
    $("pushWarn").checked = tokenRec.ostrzezenia === true;
  } else {
    st.textContent = "Wyłączone na tym urządzeniu.";
    en.textContent = "Włącz powiadomienia";
  }
}

async function saveToken(token, prefs) {
  const k = await tokenKey(token),
    old = storedKey(),
    u = user();
  await fb.set(dbRef("pompa/tokeny/" + k), {
    token,
    uid: u.uid,
    email: u.email || "",
    awarie: true,
    ostrzezenia: prefs?.ostrzezenia ?? true,
    urzadzenie: deviceName(),
    czas: now(),
  });
  if (old && old !== k) fb.remove(dbRef("pompa/tokeny/" + old)).catch(() => {});
  if (old !== k) setStoredKey(k);
}
async function getFcmToken() {
  const reg = await registerSW();
  return msgApi.getToken(msgApi.messaging, { vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
}

async function togglePush() {
  if (!msgApi || !user()) return;
  const en = $("pushEnable"),
    msg = (t) => ($("pushMsg").textContent = t);
  en.disabled = true;
  msg("");
  try {
    if (tokenRec && permission() === "granted") {
      const k = storedKey();
      await msgApi.deleteToken(msgApi.messaging).catch(() => {});
      if (k) await fb.remove(dbRef("pompa/tokeny/" + k));
      setStoredKey("");
      msg("Powiadomienia wyłączone na tym urządzeniu.");
    } else {
      msg("Włączanie…");
      if ((await Notification.requestPermission()) !== "granted")
        return msg("Bez zgody przeglądarki powiadomienia nie zadziałają.");
      await saveToken(await getFcmToken(), { ostrzezenia: true });
      msg("Gotowe. Użyj „Wyślij test”, aby sprawdzić działanie.");
    }
  } catch (e) {
    msg("Nie udało się: " + (e?.code || e?.message || "nieznany błąd"));
  } finally {
    renderPush();
  }
}

/** Odnawia token raz na tydzień albo gdy się zmienił (FCM potrafi go wymienić). */
export async function refreshPushToken() {
  if (!msgApi || !vapidOk() || permission() !== "granted" || !storedKey() || !user()) return;
  try {
    const token = await getFcmToken(),
      prev = (await fb.get(dbRef("pompa/tokeny/" + storedKey()))).val();
    if (prev?.token === token && prev.uid === user().uid && now() - Number(prev.czas) < 7 * 86400e3) return;
    await saveToken(token, prev);
  } catch {}
}

async function sendTest() {
  const u = user();
  if (!u) return;
  $("pushTest").disabled = true;
  $("pushMsg").textContent = "Wysyłanie testu przez Raspberry…";
  clearTimeout(testTimer);
  testTimer = setTimeout(() => {
    $("pushTest").disabled = false;
    $("pushMsg").textContent =
      "Serwis alarmów na Raspberry nie odpowiedział w 20 s. Sprawdź, czy działa (systemctl status pompa-alarmy).";
  }, 20000);
  try {
    await fb.set(dbRef("pompa/testPowiadomienia"), { uid: u.uid, czas: now() });
  } catch {
    clearTimeout(testTimer);
    $("pushTest").disabled = false;
    $("pushMsg").textContent = "Nie udało się zapisać prośby o test. Sprawdź reguły bazy (pompa/testPowiadomienia).";
  }
}

/** Wynik testu zapisany przez Raspberry w pompa/testPowiadomienia. */
export function onTestResult(v) {
  const u = user();
  if (!v || !u || v.uid !== u.uid || !v.wynik || now() - v.czas > 120000) return;
  clearTimeout(testTimer);
  $("pushTest").disabled = false;
  $("pushMsg").textContent = String(v.wynik);
}

export function initPush() {
  onShowView("alarms", renderPush);
  $("pushEnable").addEventListener("click", togglePush);
  $("pushTest").addEventListener("click", sendTest);
  $("pushWarn").addEventListener("change", (e) => {
    const k = storedKey();
    if (k)
      fb.update(dbRef("pompa/tokeny/" + k), { ostrzezenia: e.target.checked }).catch(
        () => ($("pushMsg").textContent = "Nie udało się zapisać ustawienia."),
      );
  });
}
