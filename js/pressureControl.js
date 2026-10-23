import "../raspberry/pressure-control-schema.js";
import { $, S, fb, dbRef, user, now, isLive } from "./state.js";
import { fmt, isFresh, parseDecimal } from "./logic.js";
const A = globalThis.POMPA_PRESSURE_CONTROL;
let dirty = false,
  busy = false,
  denied = false;
export const pressureMode = () => S.pressureCfg?.wlaczony === true || S.pressureBackend?.wlaczony === true;
export function pressureBackendReady() {
  const b = S.pressureBackend;
  return (
    b?.wersja === 1 &&
    isFresh(b.aktualizacja, now(), A.backendAgeMs) &&
    b.ustawieniaId === (S.pressureCfg?.id || "domyslne")
  );
}
export function pressureCanStart() {
  if (S.pressureBackend?.awaria) return false;
  const p = S.status?.cisnienieTloczenia;
  return (
    !pressureMode() ||
    (!!S.pressureCfg &&
      pressureBackendReady() &&
      !S.pressureBackend.awaria &&
      S.status?.pracuje !== true &&
      p?.polaczony === true &&
      isFresh(p.aktualizacja, now(), A.pressureAgeMs) &&
      typeof p.bar === "number" &&
      typeof p.napiecieV === "number" &&
      p.napiecieV >= 0.5 &&
      p.napiecieV <= 4.5 &&
      p.bar >= 0 &&
      p.bar < S.pressureCfg.maxBar)
  );
}
export function setPressureConfig(value) {
  const c = value && typeof value === "object" ? value : null;
  S.pressureCfg = c;
  denied = false;
  fill();
  renderPressureControl();
}
export function pressureConfigDenied() {
  S.pressureCfg = null;
  denied = true;
  renderPressureControl();
}
export function setPressureBackend(value) {
  S.pressureBackend = value;
  renderPressureControl();
}
function fill() {
  if (dirty) return;
  const c = S.pressureCfg || A.defaults();
  $("pressureAutoOn").checked = c.wlaczony === true;
  for (const [id, key] of [
    ["pressureSetBar", "bar"],
    ["pressureMinHz", "minHz"],
    ["pressureMaxHz", "maxHz"],
    ["pressureStopBar", "maxBar"],
  ])
    $(id).value = c[key];
}
export function resetPressureControl() {
  dirty = false;
  busy = false;
  denied = false;
  S.pressureCfg = null;
  S.pressureBackend = null;
  fill();
  $("pressureControlMessage").textContent = "";
}
export function renderPressureControl() {
  const b = S.pressureBackend,
    ready = pressureBackendReady(),
    on = pressureMode();
  $("pressureControlState").textContent = !ready
    ? "Oczekiwanie na potwierdzenie regulatora Raspberry"
    : b.awaria
      ? "BLOKADA: " + b.awaria
      : on
        ? "Automat: " + b.stan
        : "Tryb ręczny — regulator wyłączony";
  $("pressureControlState").classList.toggle("warn", !!b?.awaria || !ready);
  $("pressureControlState").classList.toggle("status-danger", !!b?.awaria);
  $("pressureControlState").classList.toggle("status-warning", !b?.awaria && !ready);
  const p = S.status?.cisnienieTloczenia,
    valid = S.connected && p?.polaczony === true && isFresh(p.aktualizacja, now(), A.pressureAgeMs);
  $("pressureControlActual").textContent = fmt(valid ? p.bar : null, " bar");
  $("pressureControlTarget").textContent = on ? fmt(S.pressureCfg?.bar, " bar") : "—";
  $("pressureControlHz").textContent = fmt(isLive() ? S.status?.czestotliwoscZadana : null, " Hz");
  $("savePressureControl").disabled = !user() || !S.connected || S.denied || denied || busy;
  for (const id of ["pressureAutoOn", "pressureSetBar", "pressureMinHz", "pressureMaxHz", "pressureStopBar"])
    $(id).disabled = !user() || denied || busy;
}
async function save() {
  const c = {
    wersja: 1,
    id: crypto.randomUUID(),
    wlaczony: $("pressureAutoOn").checked,
    bar: parseDecimal($("pressureSetBar").value),
    minHz: parseDecimal($("pressureMinHz").value),
    maxHz: parseDecimal($("pressureMaxHz").value),
    maxBar: parseDecimal($("pressureStopBar").value),
    zmieniono: now(),
    zmienil: user()?.email || "",
  };
  const error = A.validate(c);
  if (error) {
    $("pressureControlMessage").textContent = error;
    return;
  }
  if (c.wlaczony) {
    if (!pressureBackendReady() || !isLive() || !S.status?.polaczony || S.status.awaria) {
      $("pressureControlMessage").textContent = "Włącz zasilanie falownika i poczekaj na aktualny status Raspberry.";
      return;
    }
    if (!pressureMode() && S.status.pracuje) {
      $("pressureControlMessage").textContent = "Nowy tryb włączaj przy zatrzymanej pompie.";
      return;
    }
    const p = S.status.cisnienieTloczenia,
      l = S.limitCfg;
    if (S.status.pracuje && (c.minHz !== S.pressureCfg?.minHz || c.maxHz !== S.pressureCfg?.maxHz)) {
      $("pressureControlMessage").textContent =
        "Granice Hz zmieniaj na postoju. Podczas pracy można zmieniać cel ciśnienia.";
      return;
    }
    if (
      p?.polaczony !== true ||
      !isFresh(p.aktualizacja, now(), A.pressureAgeMs) ||
      typeof p.bar !== "number" ||
      p.bar >= c.maxBar
    ) {
      $("pressureControlMessage").textContent =
        "Wymagany poprawny odczyt ciśnienia młodszy niż 3 s i poniżej progu STOP.";
      return;
    }
    if (l?.wlaczony !== true || l.kw < 10 || l.kw > 90 || l.minHz < 0 || l.minHz > c.minHz) {
      $("pressureControlMessage").textContent =
        "Włącz limit mocy 10–90 kW; minimum Hz limitu musi wynosić 0…min Hz regulatora.";
      return;
    }
    if (
      !confirm(
        `Utrzymywać ${c.bar} bar na tłoczeniu, w zakresie ${c.minHz}–${c.maxHz} Hz? Próg STOP: ${c.maxBar} bar. Zapis nie uruchamia pompy. Pierwsza próba wymaga nadzoru i sprawdzenia manometru.`,
      )
    )
      return;
  }
  busy = true;
  renderPressureControl();
  $("pressureControlMessage").textContent = "Zapisywanie…";
  try {
    await fb.set(dbRef("pompa/ustawienia/regulatorCisnienia"), c);
    dirty = false;
    $("pressureControlMessage").textContent =
      "Zapisano. Poczekaj na potwierdzenie Raspberry. Pompa nie została uruchomiona.";
  } catch {
    $("pressureControlMessage").textContent = "Nie udało się zapisać ustawień. Sprawdź połączenie i uprawnienia.";
  } finally {
    busy = false;
    fill();
    renderPressureControl();
  }
}
export function initPressureControl() {
  fill();
  for (const id of ["pressureAutoOn", "pressureSetBar", "pressureMinHz", "pressureMaxHz", "pressureStopBar"])
    $(id).addEventListener("input", () => {
      dirty = true;
      $("pressureControlMessage").textContent = "Niezapisane zmiany";
    });
  $("savePressureControl").addEventListener("click", save);
}
