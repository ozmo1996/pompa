// Wspólny stan aplikacji, dostęp do Firebase i drobne pomocniki DOM.
import { isFresh } from "./logic.js";

export const $ = (id) => document.getElementById(id);

/** Funkcje i obiekty Firebase — uzupełniane w main.js po załadowaniu SDK. */
export const fb = {};
export const dbRef = (path) => fb.ref(fb.db, path);
export const user = () => fb.auth?.currentUser || null;

/** Stan z bazy, wspólny dla wszystkich zakładek. */
export const S = {
  status: null, // pompa/status
  limitCfg: null, // pompa/ustawienia/limitMocy
  alarms: [],
  connected: false, // .info/connected
  denied: false, // brak uprawnień do odczytu statusu
  serverOffset: 0, // .info/serverTimeOffset — różnica zegara telefonu i serwera
};

/** Czas serwera Firebase (odporny na źle ustawiony zegar telefonu). */
export const now = () => Date.now() + S.serverOffset;

/** Dane z Raspberry są świeże, a aplikacja ma połączenie i dostęp. */
export const isLive = () => S.connected && !S.denied && isFresh(Number(S.status?.aktualizacja), now());

/** Wykonuje fragment renderowania; błąd w jednej części nie blokuje pozostałych. */
export function safe(fn, ...args) {
  try {
    return fn(...args);
  } catch (e) {
    console.error(e);
  }
}

/** Element z tekstem — bezpieczna alternatywa dla innerHTML. */
export function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
}

// ---------- widoki (zakładki) ----------
export const VIEWS = ["overview", "control", "stats", "notes", "alarms"];
const viewHooks = {};
/** Moduł rejestruje, co zrobić przy pokazaniu swojej zakładki. */
export const onShowView = (name, fn) => (viewHooks[name] ||= []).push(fn);
export const currentView = () => VIEWS.find((v) => !$(v + "View").hidden) || "overview";
export function showView(name) {
  if (!VIEWS.includes(name)) name = "overview";
  for (const key of VIEWS) {
    $(key + "View").hidden = key !== name;
    $(key + "Tab").classList.toggle("active", key === name);
    $(key + "Tab").setAttribute("aria-pressed", String(key === name));
  }
  for (const fn of viewHooks[name] || []) safe(fn);
}
