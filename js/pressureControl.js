import "../raspberry/pressure-control-schema.js";
import { $, S, fb, dbRef, user, now, isLive } from "./state.js";
import { fmt, isFresh, parseDecimal } from "./logic.js";
const A = globalThis.POMPA_PRESSURE_CONTROL;
let dirty = false,
  busy = false,
  denied = false,
  manualRequestId = null,
  targetDirty = false;
export const pressureMode = () => S.pressureCfg?.wlaczony === true || S.pressureBackend?.wlaczony === true;
export function pressureBackendReady() {
  const b = S.pressureBackend;
  return (
    b?.wersja === 1 &&
    isFresh(b.aktualizacja, now(), A.backendAgeMs) &&
    b.ustawieniaId === (S.pressureCfg?.id || "domyslne")
  );
}
export const manualModeReady = () =>
  !pressureMode() &&
  (S.pressureCfg?.wlaczony !== false ||
    (pressureBackendReady() && S.pressureBackend?.wlaczony === false && !S.pressureBackend.awaria));
export function pressureCanStart() {
  if (S.pressureBackend?.awaria) return false;
  const p = S.status?.cisnienieTloczenia;
  return (
    !pressureMode() ||
    (!!S.pressureCfg &&
      S.pressureCfg.wlaczony === true &&
      S.pressureBackend?.wlaczony === true &&
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
  targetDirty = false;
  busy = false;
  denied = false;
  S.pressureCfg = null;
  manualRequestId = null;
  S.pressureBackend = null;
  fill();
  $("pressureControlMessage").textContent = "";
  $("manualModeMessage").textContent = "";
  $("topPressureMessage").textContent = "";
}
export function renderPressureControl() {
  const b = S.pressureBackend,
    ready = pressureBackendReady(),
    on = pressureMode();
  if (!targetDirty) syncTarget(S.pressureCfg?.bar ?? A.defaults().bar);
  $("setPressureTarget").disabled = !targetReady() || busy;
  if (manualRequestId && manualModeReady() && b?.ustawieniaId === manualRequestId) {
    $("manualModeMessage").textContent =
      "Raspberry potwierdziło tryb ręczny. Pompa nie została zatrzymana; możesz teraz ustawiać Hz.";
    manualRequestId = null;
  }
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
  $("switchToManual").hidden = !on;
  $("switchToManual").disabled =
    !user() ||
    !S.connected ||
    S.denied ||
    denied ||
    busy ||
    !S.pressureCfg?.wlaczony ||
    !ready ||
    !isLive() ||
    S.status?.polaczony !== true;
  for (const id of ["pressureAutoOn", "pressureSetBar", "pressureMinHz", "pressureMaxHz", "pressureStopBar"])
    $(id).disabled = !user() || denied || busy;
}
function targetReady() {
  const p = S.status?.cisnienieTloczenia;
  return (
    !!user() &&
    S.connected &&
    !S.denied &&
    !denied &&
    isLive() &&
    S.status?.polaczony === true &&
    S.status.awaria !== true &&
    S.pressureCfg?.wlaczony === true &&
    S.pressureBackend?.wlaczony === true &&
    pressureBackendReady() &&
    !S.pressureBackend.awaria &&
    p?.polaczony === true &&
    isFresh(p.aktualizacja, now(), A.pressureAgeMs) &&
    typeof p.napiecieV === "number" &&
    p.napiecieV >= 0.5 &&
    p.napiecieV <= 4.5 &&
    Number.isFinite(p.bar) &&
    p.bar >= 0 &&
    p.bar < S.pressureCfg.maxBar
  );
}
function syncTarget(value, source) {
  if (!Number.isFinite(value)) return;
  if (source !== "number") $("topPressureBar").value = value;
  if (source !== "slider") $("topPressureSlider").value = value;
  $("topPressureValue").textContent = fmt(value, " bar");
}
async function saveTarget() {
  if (busy || !targetReady()) return;
  const before = S.pressureCfg,
    bar = parseDecimal($("topPressureBar").value);
  const next = { ...before, bar, id: crypto.randomUUID(), zmieniono: now(), zmienil: user()?.email || "" };
  const error = A.validate(next);
  if (error) return void ($("topPressureMessage").textContent = error);
  if (
    !confirm(
      `Zmienić cel automatu z ${before.bar} na ${bar} bar? Pompa nie zostanie uruchomiona. Podczas pracy regulator sam dobierze Hz; limit mocy i pozostałe ustawienia nie zmienią się.`,
    )
  )
    return;
  if (!targetReady() || before.id !== S.pressureCfg?.id || busy)
    return void ($("topPressureMessage").textContent = "Stan lub ustawienia zmieniły się — nie zapisano celu.");
  busy = true;
  renderPressureControl();
  try {
    const result = await fb.runTransaction(dbRef("pompa/ustawienia/regulatorCisnienia"), (current) =>
      current?.id === before.id && current.wlaczony === true
        ? { ...current, bar, id: next.id, zmieniono: next.zmieniono, zmienil: next.zmienil }
        : undefined,
    );
    if (!result.committed) throw new Error("conflict");
    targetDirty = false;
    $("topPressureMessage").textContent =
      "Zapisano cel " + fmt(bar, " bar") + ". Poczekaj na potwierdzenie Raspberry. Nie wysłano START.";
  } catch {
    $("topPressureMessage").textContent =
      "Nie potwierdzono zapisu. Sprawdź połączenie lub zmianę ustawień na innym urządzeniu.";
  } finally {
    busy = false;
    renderPressureControl();
  }
}
async function switchToManual() {
  if ($("switchToManual").disabled || !pressureMode()) return;
  const previousId = S.pressureCfg?.id;
  if (
    !confirm(
      "Przejść na sterowanie ręczne bez zatrzymywania pompy? Automat przestanie utrzymywać ciśnienie. Bieżąca nastawa Hz zostanie zachowana, a limit mocy i zabezpieczenie poziomu wody pozostaną zgodnie ze swoimi ustawieniami. Niezapisane zmiany formularza nie zostaną zastosowane.",
    )
  )
    return;
  if (
    !user() ||
    !S.connected ||
    S.denied ||
    denied ||
    busy ||
    previousId !== S.pressureCfg?.id ||
    !pressureBackendReady()
  )
    return;
  busy = true;
  renderPressureControl();
  $("manualModeMessage").textContent = "Wyłączanie automatu — oczekiwanie na potwierdzenie Raspberry. Nie zmieniam Hz.";
  const id = crypto.randomUUID(),
    changedAt = now(),
    email = user()?.email || "";
  manualRequestId = id;
  try {
    const result = await fb.runTransaction(dbRef("pompa/ustawienia/regulatorCisnienia"), (current) => {
      if (!current || current.id !== previousId || current.wlaczony !== true) return;
      return { ...current, id, wlaczony: false, zmieniono: changedAt, zmienil: email };
    });
    if (!result.committed) throw new Error("conflict");
    dirty = false;
    fill();
  } catch {
    manualRequestId = null;
    $("manualModeMessage").textContent =
      "Nie potwierdzono zmiany trybu. Sprawdź połączenie lub zmiany z innego urządzenia; nie zakładaj, że automat został wyłączony.";
  } finally {
    busy = false;
    renderPressureControl();
  }
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
  $("topPressureBar").addEventListener("input", () => {
    targetDirty = true;
    syncTarget(parseDecimal($("topPressureBar").value), "number");
  });
  $("topPressureSlider").addEventListener("input", () => {
    targetDirty = true;
    syncTarget(Number($("topPressureSlider").value), "slider");
  });
  $("setPressureTarget").addEventListener("click", saveTarget);
  for (const id of ["pressureAutoOn", "pressureSetBar", "pressureMinHz", "pressureMaxHz", "pressureStopBar"])
    $(id).addEventListener("input", () => {
      dirty = true;
      $("pressureControlMessage").textContent = "Niezapisane zmiany";
    });
  $("savePressureControl").addEventListener("click", save);
  $("switchToManual").addEventListener("click", switchToManual);
}
