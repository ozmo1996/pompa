import "../raspberry/water-safety-schema.js";
import { $, S, fb, dbRef, user, now, showView } from "./state.js";
import { fmt, isFresh, parseDecimal } from "./logic.js";
import { showToast } from "./alarms.js";
const A = globalThis.POMPA_WATER_SAFETY;
let dirty = false,
  busy = false,
  denied = false,
  previous = "";
const inputs = ["waterStopOn", "waterStopCm", "waterWarnOn", "waterWarnCm"];
function fill() {
  if (dirty) return;
  const c = S.waterCfg || A.defaults();
  $("waterStopOn").checked = c.wlaczony;
  $("waterStopCm").value = c.stopCm;
  $("waterWarnOn").checked = c.ostrzegaj;
  $("waterWarnCm").value = c.ostrzezenieCm;
}
export function waterCanStart() {
  if (S.waterBackend?.awaria || S.waterBackend?.stopNiepotwierdzony) return false;
  if (!S.waterCfg?.wlaczony) return true;
  const b = S.waterBackend,
    cm = A.level(S.status, now());
  return (
    b?.ustawieniaId === S.waterCfg.id &&
    isFresh(b.aktualizacja, now(), 5000) &&
    b.wlaczony === true &&
    cm !== null &&
    cm > S.waterCfg.stopCm + 5
  );
}
export function setWaterSafety(value, backend = false, error = false) {
  if (backend) S.waterBackend = value;
  else {
    S.waterCfg = value;
    denied = error;
    fill();
  }
  renderWaterSafety();
}
export function resetWaterSafety() {
  S.waterCfg = null;
  S.waterBackend = null;
  dirty = false;
  busy = false;
  denied = false;
  previous = "";
  fill();
  $("waterSafetyMessage").textContent = "";
  renderWaterSafety();
}
export function renderWaterSafety() {
  const b = S.waterBackend,
    c = S.waterCfg || A.defaults(),
    fresh = S.connected && isFresh(b?.aktualizacja, now(), 5000),
    confirmed = fresh && b?.ustawieniaId === c.id;
  $("waterSafetyState").textContent = denied
    ? "Brak dostępu do ustawień"
    : b?.awaria
      ? "BLOKADA: " + b.awaria
      : !confirmed
        ? "Oczekiwanie na potwierdzenie Raspberry"
        : `STOP: ${c.wlaczony ? "włączony" : "wyłączony"} · ostrzeżenia: ${c.ostrzegaj ? "włączone" : "wyłączone"}`;
  $("waterSafetyState").classList.toggle("status-danger", !!b?.awaria);
  $("waterSafetyBanner").classList.toggle("status-danger", !!b?.awaria);
  $("waterSafetyBanner").classList.toggle("status-warning", !b?.awaria);
  const alarm = S.alarmCfg;
  $("waterThresholdSummary").textContent =
    `Zatrzymanie: ${c.wlaczony ? c.stopCm + " cm" : "wyłączone"}. Wcześniejsze ostrzeżenie: ${c.ostrzegaj ? c.ostrzezenieCm + " cm" : "wyłączone"}. ` +
    (alarm
      ? `Osobna reguła alarmowa: ${alarm.reguly.niskiPoziom.wlaczony ? "poniżej " + alarm.progi.poziomNiski + "% (" + Math.round(alarm.progi.poziomNiski * 2.5 * 10) / 10 + " cm)" : "wyłączona"}. Ta reguła sama nie wysyła STOP.`
      : "Ustawienia dodatkowej reguły alarmowej nie zostały wczytane.");
  const cm = A.level(S.status, now());
  $("waterSafetyLevel").textContent = fmt(cm, " cm") + " · " + fmt(cm === null ? null : cm / 2.5, " %");
  const stop = parseDecimal($("waterStopCm").value),
    warn = parseDecimal($("waterWarnCm").value);
  $("waterSafetyPercents").textContent =
    `STOP: ${fmt(stop === null ? null : stop / 2.5, " %")} · ostrzeżenie: ${fmt(warn === null ? null : warn / 2.5, " %")}`;
  const text = b?.awaria
    ? "Zabezpieczenie wody — " +
      b.awaria +
      (b.stopNiepotwierdzony ? ". STOP niepotwierdzony — ponawianie." : ". Ponowny START zablokowany.")
    : confirmed && b.ostrzezenie
      ? `Niski poziom wody: ${fmt(b.poziomCm, " cm")}. ${b.wlaczony ? "Próg STOP: " + b.stopCm + " cm." : "Automatyczny STOP wyłączony."} Sprawdź zbiornik.`
      : "";
  $("waterSafetyBanner").hidden = !text;
  $("waterSafetyBanner").textContent =
    (text && !fresh ? "Ostatnia zgłoszona blokada (brak aktualnego statusu): " : "") + text;
  const notification = text ? (b.awaria ? "fault:" + b.awaria : "warning") : "";
  if (notification && notification !== previous)
    showToast({
      tytul: b.awaria ? "Zabezpieczenie wody" : "Zbliża się niski poziom wody",
      tresc: text,
      poziom: b.awaria ? "awaria" : "ostrzezenie",
    });
  previous = notification;
  for (const id of [...inputs, "saveWaterSafety"]) $(id).disabled = !user() || !S.connected || denied || busy;
  $("resetWaterSafety").disabled =
    !user() || !confirmed || busy || !b?.awaria || S.status?.pracuje !== false || S.status?.polaczony !== true;
}
async function save(reset = false) {
  if (!user() || !S.connected || busy || denied) return;
  if (reset && dirty) {
    $("waterSafetyMessage").textContent = "Najpierw zapisz zmienione ustawienia.";
    return;
  }
  const c = {
    ...A.defaults(),
    ...S.waterCfg,
    wersja: 1,
    id: crypto.randomUUID(),
    wlaczony: $("waterStopOn").checked,
    stopCm: parseDecimal($("waterStopCm").value),
    ostrzegaj: $("waterWarnOn").checked,
    ostrzezenieCm: parseDecimal($("waterWarnCm").value),
    zmieniono: now(),
    zmienil: user().email || "",
  };
  if (reset) c.resetId = crypto.randomUUID();
  const error = A.validate(c);
  if (error) {
    $("waterSafetyMessage").textContent = error;
    return;
  }
  if (
    !confirm(
      reset
        ? "Skasować blokadę wody? Raspberry sprawdzi postój pompy i bezpieczny poziom. To nie uruchamia pompy."
        : `Zapisać zabezpieczenie wody? STOP: ${c.wlaczony ? c.stopCm + " cm" : "wyłączony"}; ostrzeżenie: ${c.ostrzegaj ? c.ostrzezenieCm + " cm" : "wyłączone"}. Włączenie przy poziomie poniżej progu natychmiast zatrzyma pracującą pompę. Dobierz próg ponad minimalnym zanurzeniem wlotu.`,
    )
  )
    return;
  busy = true;
  renderWaterSafety();
  try {
    const expected = S.waterCfg;
    const result = await fb.runTransaction(dbRef("pompa/ustawienia/zabezpieczenieWody"), (current) => {
      if ((current?.id || null) !== (expected?.id || null)) return;
      return c;
    });
    if (!result.committed) throw new Error("Konflikt ustawień");
    dirty = false;
    S.waterCfg = c;
    fill();
    $("waterSafetyMessage").textContent = reset
      ? "Wysłano prośbę o skasowanie. Sprawdź potwierdzenie Raspberry — nie uruchomiono pompy."
      : "Zapisano. Poczekaj na potwierdzenie Raspberry. Pompa nie została uruchomiona.";
  } catch {
    $("waterSafetyMessage").textContent =
      "Nie zapisano: sprawdź połączenie, uprawnienia lub zmiany z innego urządzenia.";
  } finally {
    busy = false;
    renderWaterSafety();
  }
}
export function initWaterSafety() {
  fill();
  for (const id of inputs)
    $(id).addEventListener("input", () => {
      dirty = true;
      $("waterSafetyMessage").textContent = "Niezapisane zmiany";
      renderWaterSafety();
    });
  $("saveWaterSafety").addEventListener("click", () => save());
  $("resetWaterSafety").addEventListener("click", () => save(true));
  $("waterAlarmSettings").addEventListener("click", () => {
    showView("alarms");
    $("alarmSettingsPanel").open = true;
    const rule = $("rule-niskiPoziom");
    if (rule) {
      rule.closest("details").open = true;
      rule.scrollIntoView({ block: "center" });
    }
  });
}
