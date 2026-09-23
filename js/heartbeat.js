// Puls pogody: otwarta aplikacja ustawia pompa/ustawienia/pogoda/aktywnaDo, a Raspberry pobiera wtedy pogodę co 30 s.
// Zapis tylko, gdy do wygaśnięcia zostało mniej niż `zapisGdyZostaloMs` — przy kilku telefonach pisze zwykle jeden.
// Po zamknięciu aplikacji tryb wygasa sam (maks. `waznoscMs`), bez dodatkowego zapisu.
// W tle puls działa jeszcze przez `pulsWTleMaxMs` (np. krótkie przełączenie do innej aplikacji), potem się wstrzymuje.
import { CFG } from "./logic.js";
import { dbRef, fb, now, user } from "./state.js";

const W = CFG.pogoda;
let timer = null,
  activeUntil = 0,
  hiddenSince = null;

/** Wartość aktywnaDo z bazy (zapis z innego telefonu też się liczy). */
export const setWeatherActiveUntil = (v) => (activeUntil = Number(v) || 0);

async function beat() {
  if (!user()) return;
  if (document.hidden) {
    hiddenSince ??= Date.now();
    if (Date.now() - hiddenSince > W.pulsWTleMaxMs) return;
  } else hiddenSince = null;
  if (activeUntil - now() > W.zapisGdyZostaloMs) return;
  const until = now() + W.waznoscMs;
  activeUntil = until;
  try {
    await fb.set(dbRef("pompa/ustawienia/pogoda/aktywnaDo"), until);
  } catch {}
}

export function startHeartbeat() {
  clearInterval(timer);
  timer = null;
  hiddenSince = null;
  if (!user()) return;
  beat();
  timer = setInterval(beat, W.pulsCoMs);
}

export function initHeartbeat() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") startHeartbeat();
  });
}
