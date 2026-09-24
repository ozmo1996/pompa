import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CFG,
  analyzeChange,
  canAck,
  changePreview,
  currentSetpoint,
  cyclesFrom,
  driveStateText,
  duration,
  energyDigits,
  filterAlarms,
  fmt,
  isFresh,
  lowerBound,
  mergeRows,
  niceStep,
  parseDecimal,
  powerCap,
  powerReading,
  predictKw,
  rowPower,
  validHz,
  validateLimit,
  wetBulb,
  windDirection,
  waterVolumeM3,
  tankCapacityM3,
} from "../js/logic.js";

test("objętość owalnego zbiornika jest nieliniowa", () => {
  assert.equal(waterVolumeM3(null), null);
  assert.equal(waterVolumeM3(0), 0);
  assert.ok(Math.abs(tankCapacityM3() - 1575.1) < 0.1);
  assert.ok(Math.abs(waterVolumeM3(50) - 682.9) < 0.2);
  assert.equal(waterVolumeM3(100), waterVolumeM3(120));
});

const running = { polaczony: true, pracuje: true, czestotliwoscWyjsciowa: 40, czestotliwoscZadana: 40, moc: 60 };

test("konfiguracja jest wczytana i zamrożona", () => {
  assert.equal(CFG.silnik.mocZnamionowaKw, 90);
  assert.ok(Object.isFrozen(CFG) && Object.isFrozen(CFG.progi));
});

test("isFresh: okno świeżości i tolerancja zegara", () => {
  const now = 1_000_000_000;
  assert.equal(isFresh(now - 1000, now), true);
  assert.equal(isFresh(now - 30000, now), false);
  assert.equal(isFresh(now + 59000, now), true); // zegar Raspberry lekko do przodu
  assert.equal(isFresh(now + 61000, now), false);
  for (const bad of [NaN, 0, -5, undefined, null, "123"]) assert.equal(isFresh(bad, now), false);
});

test("fmt i parseDecimal", () => {
  assert.equal(fmt(null, " Hz"), "— Hz");
  assert.equal(fmt("12", " Hz"), "— Hz");
  assert.equal(fmt(Infinity), "—");
  assert.equal(fmt(12.345, " kW"), "12,3 kW");
  assert.equal(parseDecimal("42,5"), 42.5);
  assert.ok(Number.isNaN(parseDecimal("")));
  assert.ok(Number.isNaN(parseDecimal("  ")));
});

test("validHz: zakres 0–50 Hz, zaokrąglenie do 0,1", () => {
  assert.equal(validHz("42,55"), 42.6);
  assert.equal(validHz(0), 0);
  assert.equal(validHz(50), 50);
  for (const bad of ["", "abc", -0.1, 50.1, NaN]) assert.equal(validHz(bad), null);
});

test("validateLimit", () => {
  assert.deepEqual(validateLimit({ on: true, kw: 85.4, minHz: 35.26 }), {
    cfg: { wlaczony: true, kw: 85, minHz: 35.3 },
  });
  assert.equal(validateLimit({ on: true, kw: 5, minHz: 30 }).field, "limitKw");
  assert.equal(validateLimit({ on: true, kw: 80, minHz: NaN }).field, "limitMinHz");
  assert.equal(validateLimit({ on: true, kw: 80, minHz: 51 }).field, "limitMinHz");
});

test("powerReading: odczyt, szacunek, postój, brak danych", () => {
  assert.deepEqual(powerReading({ moc: 50 }), { kw: 50, est: false });
  const est = powerReading({ pracuje: true, prad: 100, napiecie: 400 });
  assert.equal(est.est, true);
  assert.ok(Math.abs(est.kw - (Math.sqrt(3) * 400 * 100 * 0.91) / 1000) < 1e-9);
  assert.deepEqual(powerReading({ polaczony: true, pracuje: false }), { kw: 0, est: false });
  assert.equal(powerReading({ polaczony: false }), null);
  assert.equal(powerReading(null), null);
  assert.equal(rowPower({ pracuje: false, prad: 1, napiecie: 1 }), null);
});

test("driveStateText — jeden opis stanu dla wszystkich zakładek", () => {
  assert.equal(driveStateText(running, false), "Stan niepotwierdzony");
  assert.equal(driveStateText(null, true), "Stan niepotwierdzony");
  assert.equal(driveStateText({ polaczony: false }, true), "Falownik niepołączony");
  assert.equal(driveStateText({ polaczony: true, awaria: true, pracuje: true }, true), "Awaria falownika");
  assert.equal(driveStateText(running, true), "Pompa pracuje");
});

test("currentSetpoint: przy aktywnym limicie liczy się cel użytkownika", () => {
  assert.equal(currentSetpoint({ czestotliwoscZadana: 40 }), 40);
  assert.equal(currentSetpoint({ czestotliwoscZadana: 38, czestotliwoscCel: 45, limitAktywny: true }), 45);
  assert.equal(currentSetpoint({ czestotliwoscZadana: 38, czestotliwoscCel: 45, limitAktywny: false }), 38);
  assert.equal(currentSetpoint(null), null);
});

test("predictKw i analyzeChange", () => {
  const p = predictKw(running, true, 48);
  assert.ok(Math.abs(p.kw - 60 * 1.2 ** 3) < 1e-9);
  assert.equal(predictKw(running, false, 48), null); // bez świeżych danych brak prognozy
  const big = analyzeChange({ status: running, live: true, hz: 48, limitCfg: null });
  assert.equal(big.hot, true);
  assert.equal(big.items.length, 2); // duży skok + przekroczenie mocy znamionowej
  assert.match(big.items[1].t, /mocy znamionowej/);
  const small = analyzeChange({ status: running, live: true, hz: 41, limitCfg: null });
  assert.deepEqual(small, { items: [], hot: false });
  const lim = analyzeChange({ status: running, live: true, hz: 44, limitCfg: { wlaczony: true, kw: 70 } });
  assert.match(lim.items[0].t, /limitu mocy 70 kW/);
  assert.deepEqual(powerCap({ wlaczony: true, kw: 100 }), { lim: 100, cap: 90, isLimit: false });
});

test("changePreview", () => {
  assert.equal(changePreview({ status: running, live: false, hz: 40 }).text, "");
  assert.match(changePreview({ status: { ...running, pracuje: false }, live: true, hz: 40 }).text, /zatrzymana/);
  const p = changePreview({ status: running, live: true, hz: 46, limitCfg: null });
  assert.match(p.text, /zmiana \+6,0 Hz/);
  assert.equal(p.warn, true);
});

test("wetBulb", () => {
  assert.equal(wetBulb(null, 50), null);
  assert.equal(wetBulb(0, 0), null);
  assert.ok(Math.abs(wetBulb(5, 100) - 5) < 0.05); // przy 100% wilgotności równa temperaturze
  const w = wetBulb(-2, 60);
  assert.ok(w < -2 && w > -6);
});

test("windDirection", () => {
  assert.equal(windDirection(0), "N · 0°");
  assert.equal(windDirection(359), "N · 359°");
  assert.equal(windDirection(250), "WSW · 250°");
  assert.equal(windDirection(-90), "W · -90°");
  assert.equal(windDirection(undefined), "—");
});

test("duration", () => {
  assert.equal(duration(0), "—");
  assert.equal(duration(5 * 60000), "5 min");
  assert.equal(duration(125 * 60000), "2 godz. 5 min");
  assert.equal(duration(120 * 60000), "2 godz.");
});

test("energyDigits", () => {
  assert.deepEqual(
    energyDigits(123.9).map((x) => x.d + (x.lead ? "·" : "")),
    ["0·", "0·", "0·", "1", "2", "3"],
  );
  assert.equal(energyDigits(0).filter((x) => !x.lead).length, 1);
  assert.ok(energyDigits(null).every((x) => x.d === "-" && x.lead));
});

test("cyclesFrom: wykrywa napełnianie i opróżnianie, pomija szum i przerwy", () => {
  const rows = [];
  let t = 0;
  for (let i = 0; i <= 10; i++) rows.push({ czas: (t += 60000), poziom: 50 + i }); // napełnianie
  for (let i = 0; i < 3; i++) rows.push({ czas: (t += 60000), poziom: 60.1 }); // postój
  for (let i = 1; i <= 5; i++) rows.push({ czas: (t += 60000), poziom: 60 - i * 2 }); // opróżnianie
  const c = cyclesFrom(rows);
  assert.deepEqual(
    c.map((x) => [x.dir, x.startLevel, x.endLevel]),
    [
      ["up", 50, 60],
      ["down", 60.1, 50],
    ],
  );
  // przerwa > 15 min rozdziela dane
  assert.equal(
    cyclesFrom([
      { czas: 0, poziom: 10 },
      { czas: 20 * 60000, poziom: 30 },
    ]).length,
    0,
  );
  assert.deepEqual(cyclesFrom([]), []);
});

test("mergeRows i lowerBound", () => {
  const a = [{ czas: 1 }, { czas: 3 }, { czas: 5 }],
    b = [{ czas: 2 }, { czas: 3, nowy: true }, { czas: 6 }];
  const m = mergeRows(a, b);
  assert.deepEqual(
    m.map((r) => r.czas),
    [1, 2, 3, 5, 6],
  );
  assert.equal(m[2].nowy, true); // duplikat zastąpiony nowszym
  assert.equal(lowerBound(m, 3), 2);
  assert.equal(lowerBound(m, 0), 0);
  assert.equal(lowerBound(m, 99), 5);
});

test("niceStep", () => {
  assert.equal(niceStep(0.7), 1);
  assert.equal(niceStep(1.5), 2);
  assert.equal(niceStep(2.2), 2.5);
  assert.equal(niceStep(40), 50);
  assert.equal(niceStep(0), 1);
});

test("alarmy: filtr i potwierdzanie", () => {
  const alarms = [
    { id: 1, poziom: "awaria", aktywny: true },
    { id: 2, poziom: "ostrzezenie" },
    { id: 3, poziom: "ostrzezenie", potwierdzono: 5 },
    { id: 4, poziom: "info" },
  ];
  assert.deepEqual(
    filterAlarms(alarms, "open").map((a) => a.id),
    [1, 2],
  );
  assert.deepEqual(
    filterAlarms(alarms, "ostrzezenie").map((a) => a.id),
    [2, 3],
  );
  assert.equal(filterAlarms(alarms, "all").length, 4);
  assert.deepEqual(
    alarms.filter(canAck).map((a) => a.id),
    [2],
  );
});
