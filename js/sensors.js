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
  windDirection,
} from "./logic.js";
import { $, S, isLive, now } from "./state.js";

const { progi: P } = CFG;

function renderHeader() {
  const { status, connected, denied } = S,
    time = Number(status?.aktualizacja),
    fresh = isFresh(time, now());
  $("connectionText").textContent = denied
    ? "Brak dostępu"
    : !connected
      ? "Brak połączenia"
      : !status
        ? "Oczekiwanie na dane"
        : fresh
          ? "Dane aktualne"
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
          : status.alarmPoziomu
            ? "Niski poziom wody — sprawdź zbiornik."
            : isNum(status.temperaturaWody) && status.temperaturaWody <= P.temperaturaZamarzaniaC
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

function renderWater() {
  const s = S.status,
    water = s?.poziomWodyProc,
    pct = isNum(water) ? clamp(water, 0, 100) : 0;
  $("water").textContent = fmt(water);
  $("volume").textContent = isNum(s?.poziomWodyM3) ? fmt(s.poziomWodyM3, " m³") : "Brak odczytu z czujnika";
  $("sensorCurrent").textContent = isNum(s?.poziomWodyMa)
    ? "Prąd sondy: " + fmt(s.poziomWodyMa, " mA")
    : "Prąd sondy: brak danych";
  $("waterFill").style.width = pct + "%";
  $("tankWater").style.height = pct + "%";
  if (isNum(water)) $("waterBar").setAttribute("aria-valuenow", String(water));
  else $("waterBar").removeAttribute("aria-valuenow");
  const tw = s?.temperaturaWody,
    cold = isNum(tw) && tw <= P.temperaturaZamarzaniaC;
  $("waterTemp").textContent = fmt(tw, " °C");
  $("waterTempBox").classList.toggle("cold", cold);
  $("waterTempBox").title = cold ? "Woda bliska zamarzania" : "";
}

function renderWeather() {
  const w = S.status?.pogoda || null,
    t = weatherTime(w),
    fresh = isFresh(t, now(), P.swiezoscPogodyMs),
    wb = wetBulb(w?.temperatura, w?.wilgotnosc);
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
  $("weatherWet").classList.toggle("warm", fresh && isNum(wb) && wb > P.termometrMokryMaxC);
  $("weatherHumidity").textContent = fmt(w?.wilgotnosc, " %", 0);
  $("weatherPressure").textContent = fmt(w?.cisnienie, " hPa", 1);
  $("weatherWind").textContent = fmt(w?.wiatr, " km/h", 1);
  $("weatherGust").textContent = fmt(w?.poryw, " km/h", 1);
  $("weatherDirection").textContent = windDirection(w?.kierunekWiatru);
  $("weatherRain").textContent = fmt(w?.opadDzienny, " mm", 1);
  $("weatherUv").textContent = fmt(w?.uv, "", 1);
  $("weatherSolar").textContent = fmt(w?.promieniowanie, " W/m²", 0);
}

export function renderSensors(live) {
  renderHeader();
  renderDrive(live);
  renderWater();
  renderWeather();
}
