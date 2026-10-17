"use strict";
// ZX5001: 0–40 bar, 0.5–4.5 V. N4AIA04 V1 rejestr 0, jednostka 0.01 V.
function pressureSample(raw, time = Date.now()) {
  const voltage = Number.isInteger(raw) && raw >= 0 && raw <= 65535 ? raw / 100 : null;
  const valid = voltage !== null && voltage >= 0.5 && voltage <= 4.5;
  return {
    polaczony: true,
    aktualizacja: time,
    napiecieV: voltage,
    bar: valid ? Math.round((voltage - 0.5) * 10 * 100) / 100 : null,
    blad: valid ? "" : "Sygnał poza zakresem 0,5–4,5 V",
    zrodlo: "N4AIA04 V1 · tłoczenie",
  };
}
function disconnectedPressure(time = Date.now()) {
  return {
    polaczony: false,
    aktualizacja: time,
    bar: null,
    napiecieV: null,
    blad: "Brak komunikacji z modułem",
    zrodlo: "N4AIA04 V1 · tłoczenie",
  };
}
module.exports = { pressureSample, disconnectedPressure };
