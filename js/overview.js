import { $, S, now, isLive } from "./state.js";
import { CFG, fmt, isFresh, isNum, powerReading, driveStateText } from "./logic.js";

function status(id, text, level) {
  const node = $(id);
  node.textContent = text;
  node.className = "device-status status-" + level;
}
export function renderOverview() {
  const s = S.status,
    t = now(),
    live = isLive(),
    drive = live && s?.polaczony === true;
  status(
    "cloudConnection",
    S.connected ? "Chmura: połączona" : "Chmura: brak połączenia",
    S.connected ? "ok" : "warning",
  );
  status(
    "piConnection",
    live ? "Raspberry: aktualny zapis" : "Raspberry: brak świeżych danych",
    live ? "ok" : "warning",
  );
  status("driveConnection", drive ? "Falownik: odpowiada" : "Falownik: brak potwierdzenia", drive ? "ok" : "warning");
  const meter = S.connected && !S.denied && s?.nd20?.polaczony === true && isFresh(s.nd20.aktualizacja, t, 15000);
  status("meterConnection", meter ? "ND20: odpowiada" : "ND20: brak potwierdzenia", meter ? "ok" : "neutral");
  $("summaryPump").textContent = driveStateText(s, live);
  $("summaryPump").className = s?.awaria && drive ? "status-danger" : "";
  $("summaryPumpDetail").textContent = drive
    ? fmt(s.czestotliwoscWyjsciowa, " Hz") + " · częstotliwość rzeczywista"
    : "Sprawdź łączność falownika";
  const p = s?.cisnienieTloczenia,
    pressure =
      S.connected &&
      !S.denied &&
      p?.polaczony === true &&
      isFresh(p.aktualizacja, t, 3000) &&
      isNum(p.bar) &&
      p.bar >= 0 &&
      p.bar <= 40;
  $("summaryPressure").textContent = fmt(pressure ? p.bar : null, " bar");
  const water =
    live &&
    s?.sondaPolaczona === true &&
    isFresh(s.aktualizacjaPoziomu, t, 5000) &&
    isNum(s.poziomWodyProc) &&
    s.poziomWodyProc >= 0 &&
    s.poziomWodyProc <= 100;
  $("summaryWater").textContent = fmt(water ? (s.poziomWodyProc * CFG.zbiornik.wysokoscCm) / 100 : null, " cm");
  $("summaryWaterDetail").textContent = water ? fmt(s.poziomWodyProc, " %") + " poziomu" : "Brak aktualnego pomiaru";
  const power = drive ? powerReading(s) : null;
  $("summaryPower").textContent = (power?.est ? "≈ " : "") + fmt(power ? Math.max(0, power.kw) : null, " kW");
  $("summaryDriveHz").textContent = fmt(drive ? s.czestotliwoscWyjsciowa : null, " Hz");
  $("summaryPowerDetail").textContent = !power
    ? "Brak aktualnego pomiaru"
    : power.est
      ? "Wartość szacowana"
      : "Odczyt falownika";
  const temp =
    live &&
    s?.temperaturaWodyPolaczona === true &&
    isNum(s.temperaturaWody) &&
    isFresh(s.aktualizacjaTemperatury, t, 15000);
  $("summaryWaterTemp").textContent = fmt(temp ? s.temperaturaWody : null, " °C");
  $("summaryWaterTempState").textContent = temp ? "Aktualny pomiar DS18B20" : "Brak świeżego pomiaru DS18B20";
  $("summaryMeterPower").textContent = fmt(meter ? s.nd20.mocKw : null, " kW");
  $("summaryMeterHz").textContent = fmt(meter ? s.nd20.czestotliwoscHz : null, " Hz");
  $("summaryMeterState").textContent = meter
    ? "Moc czynna 3 faz · częstotliwość agregatu"
    : "Brak aktualnego pomiaru ND20";
}
