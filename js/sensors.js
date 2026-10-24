// Zakładka „Czujniki” oraz nagłówek z informacją o połączeniu.
import {
  CFG,
  clamp,
  driveStateText,
  fmt,
  isFresh,
  isNum,
  powerReading,
  weatherTime,
  wetBulb,
  stationPressure,
  parseDecimal,
  windDirection,
  waterVolumeM3,
  tankCapacityM3,
} from "./logic.js";
import { $, S, isLive, now, user, el } from "./state.js";
import { valveRecommendation, PRESSURES, VALVES } from "./valveTable.js";
import { estimatePump } from "./pumpEstimate.js";

const { progi: P } = CFG;
let manualPressure = null;
let inletBar = 0;
const MANUAL_PRESSURE_MS = 15 * 60000;
export function initSensors() {
  try {
    const v = Number(localStorage.getItem("pompa.flow.inletBar"));
    if (Number.isFinite(v) && v >= -1 && v <= 10) inletBar = v;
  } catch {
    /* ustawienie lokalne jest opcjonalne */
  }
  $("flowInletBar").value = inletBar;
  $("flowConfig").addEventListener("submit", (event) => {
    event.preventDefault();
    const v = parseDecimal($("flowInletBar").value);
    if (!Number.isFinite(v) || v < -1 || v > 10) {
      $("flowConfigMessage").textContent = "Wpisz ciśnienie na ssaniu od −1 do 10 bar.";
      return;
    }
    inletBar = v;
    try {
      localStorage.setItem("pompa.flow.inletBar", String(v));
    } catch {
      /* działa do zamknięcia strony */
    }
    $("flowConfigMessage").textContent = "Przyjęto na tym urządzeniu; ustawienie nie steruje pompą.";
    renderFlow();
  });
  $("summaryValvesTable").addEventListener("click", () => $("showValveTable").click());
  $("manualPressureOverride").addEventListener("change", renderWeather);
  const head = el("tr", {}, el("th", { scope: "col", textContent: "Mokry °C / bar" }));
  head.append(...PRESSURES.map((p) => el("th", { scope: "col", textContent: String(p) })));
  $("valveTableHead").append(head);
  $("valveTableBody").append(
    ...VALVES.map((row, index) => {
      const temperature = -index - 1;
      const tr = el("tr", {}, el("th", { scope: "row", textContent: String(temperature) }));
      tr.append(
        ...row.map((value, column) => {
          const td = el("td", { textContent: value });
          td.dataset.temperature = temperature;
          td.dataset.pressure = PRESSURES[column];
          return td;
        }),
      );
      return tr;
    }),
  );
  $("showValveTable").addEventListener("click", () => {
    $("valveTableDlg").showModal();
    $("valveTableBody .selected-cell")?.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
  });
  $("closeValveTable").addEventListener("click", () => $("valveTableDlg").close());
  $("waterPressureForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const bar = parseDecimal($("manualWaterPressure").value);
    if (!isNum(bar) || bar < 0 || bar > 40) {
      $("waterPressureMessage").textContent = "Wpisz ciśnienie wody od 0 do 40 bar.";
      return;
    }
    manualPressure = { bar, time: now(), uid: user()?.uid };
    $("waterPressureMessage").textContent = "Pomiar ręczny ważny przez 15 minut. Zaktualizuj go po zmianie ciśnienia.";
    renderWeather();
  });
  $("clearWaterPressure").addEventListener("click", () => {
    manualPressure = null;
    $("manualWaterPressure").value = "";
    $("waterPressureMessage").textContent = "Pomiar ręczny usunięty.";
    renderWeather();
  });
}
function renderValves(wb, fresh) {
  const sensor = S.status?.cisnienieTloczenia;
  const sensorFresh =
    S.connected &&
    !S.denied &&
    sensor?.polaczony === true &&
    isFresh(sensor.aktualizacja, now(), 3000) &&
    isNum(sensor.bar) &&
    sensor.bar >= 0;
  const manualFresh =
    manualPressure && manualPressure.uid === user()?.uid && isFresh(manualPressure.time, now(), MANUAL_PRESSURE_MS);
  const useSensor = sensorFresh && !$("manualPressureOverride").checked;
  const pressure = useSensor ? sensor.bar : manualFresh ? manualPressure.bar : null;
  $("manualPressureOverrideBox").hidden = !sensorFresh;
  $("waterPressureForm").hidden = useSensor;
  $("valvePressure").textContent = fmt(pressure, " bar");
  $("valvePressureSource").textContent = useSensor
    ? "Czujnik na tłoczeniu — uwzględnij spadek ciśnienia do armatki"
    : manualFresh
      ? "Wpis ręczny · " + new Date(manualPressure.time).toLocaleTimeString("pl-PL")
      : manualPressure
        ? "Wpis ręczny wygasł — sprawdź manometr i wpisz ponownie"
        : "Brak odczytu — wpisz ciśnienie z manometru przy armacie";
  const result = fresh ? valveRecommendation(wb, pressure) : null;
  for (const cell of $("valveTableBody").querySelectorAll("td")) {
    const selected =
      !!result &&
      Number(cell.dataset.temperature) === result.temperature &&
      Number(cell.dataset.pressure) === result.pressure;
    cell.classList.toggle("selected-cell", selected);
    if (selected) cell.setAttribute("aria-current", "true");
    else cell.removeAttribute("aria-current");
  }
  $("valveResult").textContent = result ? "Otwórz: " + result.valves.join(" + ") : "Brak wskazówki";
  $("summaryValves").textContent = $("valveResult").textContent;
  $("summaryValvesBasis").textContent = !result
    ? !fresh
      ? "Brak aktualnej pogody"
      : pressure === null
        ? "Wpisz ciśnienie przy armacie"
        : "Warunki poza tabelą lub brak poprawnych danych"
    : `Mokry ${fmt(wb, " °C")} · ${fmt(pressure, " bar")} · ${useSensor ? "czujnik na tłoczeniu" : "pomiar ręczny"}. Zalecenie, nie stan zaworów.`;
  $("valveBasis").textContent = !fresh
    ? "Potrzebne aktualne dane pogodowe."
    : !isNum(wb)
      ? "Brak poprawnej temperatury lub wilgotności."
      : pressure === null
        ? "Wpisz ciśnienie wody, aby dobrać zawory."
        : !result
          ? "Poza zakresem tabeli: mokry termometr musi mieć ≤ −1°C, a ciśnienie 10–40 bar."
          : `Tabela: ${result.temperature} °C / ${result.pressure} bar · mokry termometr ${fmt(wb, " °C")}.` +
            (result.coldEnd ? " Poniżej −17°C użyto ostatniego wiersza." : "");
  for (let i = 1; i <= 4; i++) {
    const open = result?.valves.includes(i);
    $("valve" + i).classList.toggle("valve-open", !!open);
    $("valve" + i).textContent = `Zawór ${i}: ${result ? (open ? "otwarty" : "zamknięty") : "—"}`;
  }
  $("valveTableSelection").textContent = result
    ? `Zaznaczony punkt: ${result.temperature} °C / ${result.pressure} bar → ${result.valves.join(" + ")}.`
    : "Brak aktualnego punktu do zaznaczenia — tabelę można przeglądać niezależnie od odczytów.";
}

function renderPressure() {
  const p = S.status?.cisnienieTloczenia;
  const fresh = S.connected && !S.denied && p?.polaczony === true && isFresh(p.aktualizacja, now(), 3000);
  const valid = fresh && isNum(p.bar) && p.bar >= 0 && p.bar <= 40;
  $("dischargePressure").textContent = fmt(valid ? p.bar : null);
  $("dischargeVoltage").textContent = fmt(fresh ? p.napiecieV : null, " V", 2);
  $("dischargePressureState").textContent = valid
    ? "Aktualny odczyt · " + new Date(p.aktualizacja).toLocaleTimeString("pl-PL")
    : fresh
      ? p.blad || "Nieprawidłowy sygnał czujnika"
      : "Brak aktualnego odczytu ciśnienia";
}
function renderHeader() {
  const { status, connected, denied } = S,
    time = Number(status?.aktualizacja),
    fresh = isFresh(time, now()),
    a = S.alarmCfg,
    low = a
      ? a.reguly.niskiPoziom.wlaczony &&
        a.reguly.niskiPoziom.poziom !== "info" &&
        status?.sondaPolaczona === true &&
        isNum(status.poziomWodyProc) &&
        status.poziomWodyProc < a.progi.poziomNiski
      : status?.alarmPoziomu,
    cold = a
      ? status?.temperaturaWodyPolaczona === true &&
        isNum(status.temperaturaWody) &&
        ((a.reguly.zamarzanie.wlaczony &&
          a.reguly.zamarzanie.poziom !== "info" &&
          status.temperaturaWody <= a.progi.tempAwaria) ||
          (a.reguly.zimnaWoda.wlaczony &&
            a.reguly.zimnaWoda.poziom !== "info" &&
            status.temperaturaWody <= a.progi.tempOstrzezenie))
      : isNum(status?.temperaturaWody) && status.temperaturaWody <= P.temperaturaZamarzaniaC;
  $("connectionText").textContent = denied
    ? "Brak dostępu"
    : !connected
      ? "Brak połączenia"
      : !status
        ? "Oczekiwanie na dane"
        : fresh
          ? "Raspberry: aktualny zapis"
          : "Dane nieaktualne";
  $("connection").classList.toggle("offline", !isLive());
  $("updated").textContent =
    time > 0
      ? "Ostatni odczyt: " + new Date(time).toLocaleString("pl-PL")
      : "Raspberry Pi nie przesłało jeszcze pomiarów";
  $("dataMessage").textContent = denied
    ? "To konto nie ma dostępu do instalacji. Wyloguj się i użyj uprawnionego konta."
    : !connected
      ? "Łączenie z bazą. Przy braku internetu wyświetlane dane mogą być nieaktualne."
      : !status
        ? "Aplikacja jest połączona z Firebase. Oczekuje na uruchomienie serwisu pomiarowego na Raspberry Pi."
        : !fresh
          ? "Brak świeżych danych. Wyświetlany jest ostatni zapis, a nie potwierdzony bieżący stan."
          : low
            ? "Niski poziom wody — sprawdź zbiornik."
            : cold
              ? "Temperatura wody bliska zamarzania — sprawdź zbiornik i rurociąg."
              : "";
}

function renderDrive(live) {
  const s = S.status,
    p = s ? powerReading(s) : null;
  $("sensorDriveHz").textContent = fmt(s?.czestotliwoscWyjsciowa, " Hz");
  $("sensorDriveCurrent").textContent = fmt(s?.prad, " A");
  $("sensorDriveVoltage").textContent = fmt(s?.napiecie, " V");
  $("sensorDriveTarget").textContent = fmt(s?.czestotliwoscZadana, " Hz");
  $("sensorDrivePower").textContent = (p?.est ? "≈ " : "") + fmt(p ? Math.max(0, p.kw) : null, " kW");
  $("sensorDriveState").textContent = driveStateText(s, live);
  $("sensorDriveNote").textContent =
    !live || !s?.polaczony
      ? "Ostatnie zapisane wartości — brak potwierdzenia bieżącego pomiaru."
      : p?.est
        ? "Moc szacowana z prądu i napięcia."
        : "Aktualne odczyty z falownika.";
}

function renderND20() {
  const d = S.status?.nd20;
  const fresh = d?.polaczony === true && isFresh(Number(d.aktualizacja), now(), 15000);
  $("nd20State").textContent = !d
    ? "Oczekiwanie na podłączenie i uruchomienie miernika"
    : fresh
      ? "Odczyt aktualny · " + new Date(d.aktualizacja).toLocaleTimeString("pl-PL")
      : "Brak aktualnego odczytu ND20";
  const show = (id, value, unit) => ($(id).textContent = fmt(fresh ? value : null, unit));
  show("nd20Power", d?.mocKw, " kW");
  show("nd20Hz", d?.czestotliwoscHz, " Hz");
  show("nd20U12", d?.napiecieL1L2, " V");
  show("nd20U23", d?.napiecieL2L3, " V");
  show("nd20U31", d?.napiecieL3L1, " V");
  show("nd20I1", d?.pradL1, " A");
  show("nd20I2", d?.pradL2, " A");
  show("nd20I3", d?.pradL3, " A");
}

function renderWater() {
  const s = S.status,
    waterFresh =
      isLive() &&
      s?.sondaPolaczona === true &&
      isFresh(s.aktualizacjaPoziomu, now(), 5000) &&
      isNum(s.poziomWodyProc) &&
      s.poziomWodyProc >= 0 &&
      s.poziomWodyProc <= 100,
    tempFresh = isLive() && s?.temperaturaWodyPolaczona === true && isFresh(s.aktualizacjaTemperatury, now(), 15000),
    water = waterFresh ? s.poziomWodyProc : null,
    pct = isNum(water) ? clamp(water, 0, 100) : 0;
  $("water").textContent = fmt(water);
  $("waterState").textContent = waterFresh
    ? "Aktualny odczyt sondy"
    : s?.sondaPolaczona === false
      ? "Sonda poziomu niepołączona"
      : "Brak aktualnego odczytu poziomu";
  $("waterState").classList.toggle("sensor-stale", !waterFresh);
  $("tankCaption").textContent = waterFresh ? "Poziom w zbiorniku" : "Brak odczytu";
  $("tankWater").closest(".tank-vessel").classList.toggle("sensor-unknown", !waterFresh);
  $("waterCm").textContent = isNum(water) ? fmt((pct * CFG.zbiornik.wysokoscCm) / 100, " cm", 1) : "— cm";
  const volume = waterVolumeM3(water);
  $("volume").textContent =
    volume === null ? "Objętość: brak aktualnego odczytu" : "≈ " + fmt(volume, " m³", 0) + " wody";
  $("tankCapacity").textContent = "Szacowana pojemność: ≈ " + fmt(tankCapacityM3(), " m³", 0);
  $("sensorCurrent").textContent =
    waterFresh && isNum(s?.poziomWodyMa) ? "Prąd sondy: " + fmt(s.poziomWodyMa, " mA") : "Prąd sondy: brak danych";
  $("waterFill").style.width = pct + "%";
  $("tankWater").style.height = pct + "%";
  if (isNum(water)) $("waterBar").setAttribute("aria-valuenow", String(water));
  else $("waterBar").removeAttribute("aria-valuenow");
  const tw = tempFresh ? s.temperaturaWody : null,
    cold = isNum(tw) && tw <= (S.alarmCfg?.progi.tempOstrzezenie ?? P.temperaturaZamarzaniaC);
  $("waterTemp").textContent = fmt(tw, " °C");
  $("waterTempState").textContent = tempFresh
    ? "Odczyt aktualny"
    : s?.temperaturaWodyPolaczona === false
      ? "Sonda temperatury niepołączona"
      : "Brak aktualnego odczytu";
  $("waterTempBox").classList.toggle("sensor-stale", !tempFresh);
  $("waterTempBox").classList.toggle("cold", cold);
  $("waterTempBox").title = cold ? "Woda bliska zamarzania" : "";
}

function renderWeather() {
  const w = S.status?.pogoda || null,
    t = weatherTime(w),
    fresh = S.connected && !S.denied && isFresh(t, now(), P.swiezoscPogodyMs),
    pressure = stationPressure(w),
    wb = wetBulb(w?.temperatura, w?.wilgotnosc, pressure);
  $("summaryWeatherTemp").textContent = fmt(fresh ? w?.temperatura : null, " °C");
  $("summaryWeatherState").textContent = fresh
    ? (w?.stacja || CFG.pogoda.stacjaDomyslna) + " · " + new Date(t).toLocaleTimeString("pl-PL")
    : "Brak aktualnego pomiaru stacji";
  $("weatherStation").textContent = w?.stacja || CFG.pogoda.stacjaDomyslna;
  $("weatherTime").textContent = isNum(t)
    ? "Pomiar: " + new Date(t).toLocaleString("pl-PL")
    : "Oczekiwanie na pierwszy pomiar";
  $("weatherBadgeText").textContent = !w ? "Brak danych" : fresh ? "Dane aktualne" : "Dane nieaktualne";
  $("weatherBadge").classList.toggle("offline", !fresh);
  $("weatherTime").classList.toggle("weather-stale", !!w && !fresh);
  $("weatherTemp").textContent = fmt(w?.temperatura);
  $("weatherFeels").textContent = "Odczuwalna: " + fmt(w?.odczuwalna, " °C");
  $("weatherWet").textContent = "Termometr mokry: " + fmt(wb, " °C");
  const rule = S.alarmCfg?.reguly.zaCieplo;
  $("weatherWet").classList.toggle(
    "warm",
    fresh &&
      isNum(wb) &&
      (rule?.wlaczony ?? true) &&
      (rule?.poziom ?? "ostrzezenie") !== "info" &&
      wb > (S.alarmCfg?.progi.mokryMaxC ?? P.termometrMokryMaxC),
  );
  $("wetBulbMethod").textContent =
    "Obliczenie nad wodą · ciśnienie atmosferyczne " +
    fmt(pressure, " hPa") +
    (pressure === w?.cisnienieStacjiHpa || (w?.stacja === "IBYSTR6" && pressure === w.cisnienie)
      ? " (ABS na wysokości stacji · 800 m n.p.m.)."
      : isNum(w?.cisnieniePoziomMorzaHpa)
        ? " (przeliczone z poziomu morza na 800 m n.p.m.)."
        : " (przyjęte; brak pomiaru ciśnienia ABS).");
  $("weatherHumidity").textContent = fmt(w?.wilgotnosc, " %", 0);
  $("weatherPressure").textContent = fmt(w?.cisnienie, " hPa", 1);
  $("weatherWind").textContent = fmt(w?.wiatr, " km/h", 1);
  $("weatherGust").textContent = fmt(w?.poryw, " km/h", 1);
  $("weatherDirection").textContent = windDirection(w?.kierunekWiatru);
  $("weatherRain").textContent = fmt(w?.opadDzienny, " mm", 1);
  $("weatherUv").textContent = fmt(w?.uv, "", 1);
  $("weatherSolar").textContent = fmt(w?.promieniowanie, " W/m²", 0);
  renderValves(wb, fresh);
}

export function renderSensors(live) {
  renderFlow();
  renderHeader();
  renderDrive(live);
  renderND20();
  renderWater();
  renderPressure();
  renderWeather();
}
function renderFlow() {
  const basis = S.status?.wydajnoscPompy?.cisnienieSsaniaBar ?? 0;
  $("flowHistoryBasis").textContent =
    "Historia i licznik na Raspberry: " +
    fmt(basis, " bar") +
    " na ssaniu. Korekta powyżej zmienia tylko kalkulator lokalny, nie historię ani licznik.";
  const e =
    S.connected && !S.denied
      ? estimatePump(S.status, now(), inletBar)
      : { q: null, reason: "Brak połączenia z danymi" };
  $("pumpFlow").textContent = (e.q === null ? "—" : "≈ " + fmt(e.q, "", 0)) + " m³/h";
  $("pumpFlowState").textContent = e.reason;
  $("pumpFlowRpm").textContent = e.rpm
    ? "Obroty szacowane: ≈ " + fmt(e.rpm, " obr./min", 0) + " (z Hz, nie pomiar obrotów)."
    : "";
}
