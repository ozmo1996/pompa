import { $, S, fb, dbRef, user, now } from "./state.js";
import { fmt, isFresh, parseDecimal } from "./logic.js";
let pending = null,
  sentAt = 0,
  flowDirty = false;
const labels = {
  wodaM3: "przepompowanej wody",
  pompaKwh: "energii pompy",
  agregatKwh: "energii agregatu",
  wszystkie: "wszystkich trzech liczników",
};
const ready = () =>
  !!user() &&
  S.connected &&
  !S.denied &&
  !S.counterDenied &&
  S.status?.sterowanieLicznikami?.wersja === 1 &&
  isFresh(S.status.sterowanieLicznikami.aktualizacja, now(), 30000);
const busy = () => pending && now() - sentAt < 30000;
export function resetCounters() {
  pending = null;
  sentAt = 0;
  flowDirty = false;
  S.counterRequest = null;
  S.counterDenied = false;
  $("counterControlMessage").textContent = "";
  $("flowConfigMessage").textContent = "";
}
export function renderCounters() {
  const b = S.status?.sterowanieLicznikami,
    ack = b?.ack;
  if (pending && ack?.id === pending.id) {
    $("counterControlMessage").textContent = ack.opis;
    if (ack.wynik === "wykonano" && pending.akcja === "konfiguracja") flowDirty = false;
    pending = null;
  } else if (pending && !busy())
    $("counterControlMessage").textContent =
      "Brak potwierdzenia Raspberry. Nie zakładaj wykonania; wskazania są wyłącznie z ostatniego potwierdzonego stanu.";
  $("resetCounter").disabled = !ready() || !!busy();
  $("saveFlowConfig").disabled = !ready() || !!busy();
  if (!flowDirty && b) $("flowInletBar").value = b.cisnienieSsaniaBar;
  const h = S.status?.archiwumPomiarow;
  $("measurementStorage").textContent = h
    ? "Wolne miejsce Raspberry: " +
      fmt(h.wolneBajty / 1024 ** 3, " GiB", 1) +
      ". Bazy z plikami roboczymi: " +
      fmt((h.telemetriaBajty + h.archiwumBajty) / 1024 ** 2, " MiB", 1) +
      ". Historia nie jest usuwana przez tę funkcję." +
      (h.ostrzezenie ? " UWAGA: mało wolnego miejsca — wykonaj kopię archiwum." : "")
    : "Kontrola miejsca oczekuje na Raspberry. Automatyczne usuwanie historii nie jest włączane.";
  $("measurementStorage").classList.toggle("warn", !!h?.ostrzezenie);
  const l = S.status?.lokalnyZapisPomiarow;
  $("localCollectionState").textContent = !ready()
    ? S.counterDenied
      ? "Brak uprawnień do ustawień liczników."
      : "Ustawienia wymagają aktualnego potwierdzenia Raspberry."
    : l?.plikAktualny
      ? "Zapis lokalny aktywny, również bez internetu. Kolejka wysyłki: " + (l.kolejka ?? 0) + " próbek."
      : "Raspberry nie potwierdziło aktualnego strumienia lokalnego. Liczniki nie doliczają brakujących pomiarów.";
  $("flowConfigMessage").textContent = $("counterControlMessage").textContent;
}
async function request(akcja, licznik, inlet) {
  if (!ready() || busy()) return;
  const previous = S.counterRequest?.id ?? null;
  const r = {
    wersja: 1,
    id: crypto.randomUUID(),
    akcja,
    licznik,
    cisnienieSsaniaBar: inlet,
    zmieniono: now(),
    autorUid: user().uid,
    zmienil: user().email || "",
  };
  pending = r;
  sentAt = now();
  $("counterControlMessage").textContent =
    "Wysyłanie — oczekiwanie na potwierdzenie Raspberry. Nie zmieniono sum całkowitych ani historii.";
  renderCounters();
  try {
    const result = await fb.runTransaction(dbRef("pompa/ustawienia/liczniki"), (v) =>
      (v?.id ?? null) === previous ? r : undefined,
    );
    if (!result.committed) throw Error("conflict");
  } catch {
    pending = null;
    $("counterControlMessage").textContent =
      "Nie potwierdzono zlecenia. Sprawdź połączenie lub zmianę z innego urządzenia.";
  }
  renderCounters();
}
export function initCounters() {
  $("resetCounter").addEventListener("click", async () => {
    if (!ready() || busy()) return;
    const key = $("counterResetKind").value;
    if (
      !labels[key] ||
      !confirm(
        "Wyzerować wskazanie okresowe " +
          labels[key] +
          "? Całkowite sumy i wszystkie dane historyczne zostaną zachowane. Operacja nie steruje pompą.",
      )
    )
      return;
    if (
      globalThis
        .prompt("Dodatkowe potwierdzenie: wpisz ZERUJ, aby rozpocząć nowy okres " + labels[key] + ".")
        ?.trim() !== "ZERUJ"
    )
      return;
    await request("zeruj", key, S.status.sterowanieLicznikami.cisnienieSsaniaBar);
  });
  $("flowInletBar").addEventListener("input", () => {
    flowDirty = true;
  });
  $("flowConfig").addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = parseDecimal($("flowInletBar").value);
    if (!Number.isFinite(value) || value < -1 || value > 10)
      return void ($("counterControlMessage").textContent = "Wpisz ciśnienie ssania od −1 do 10 bar.");
    if (
      !ready() ||
      busy() ||
      !confirm(
        "Ustawić wspólne ciśnienie ssania " +
          value +
          " bar? Dotyczy nowych szacunków, licznika i historii na Raspberry oraz wszystkich urządzeń. Stara historia nie zostanie przeliczona. Nie steruje pompą.",
      )
    )
      return;
    await request("konfiguracja", "brak", value);
  });
}
