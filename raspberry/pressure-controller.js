"use strict";
const A = require("./pressure-control-schema");
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
class PressureController {
  constructor() {
    this.cfg = A.defaults();
    this.loaded = false;
    this.armed = false;
    this.fault = "";
    this.startedAt = 0;
    this.lastStep = 0;
    this.atMaxSince = 0;
    this.filtered = null;
    this.state = "wyłączony";
  }
  configure(input, running = false) {
    const cfg = input ?? A.defaults(),
      error = A.validate(cfg);
    const wasOn = this.cfg.wlaczony;
    this.loaded = true;
    if (error) {
      if (wasOn || this.armed || cfg.wlaczony === true) this.trip("Błędne ustawienia: " + error);
      this.invalid = error;
      return;
    }
    this.invalid = null;
    if (running && cfg.wlaczony && (!wasOn || cfg.minHz !== this.cfg.minHz || cfg.maxHz !== this.cfg.maxHz))
      this.trip("Włączenie trybu lub zmiana granic Hz wymaga postoju pompy");
    this.cfg = { ...cfg };
    if (!wasOn && cfg.wlaczony) {
      this.armed = false;
      this.state = "gotowy — wymagany ręczny Start";
    }
    if (!cfg.wlaczony) {
      this.armed = false;
      this.filtered = null;
      this.lastStep = 0;
      this.atMaxSince = 0;
      this.state = "wyłączony";
    }
  }
  pressure(p, t) {
    return (
      p?.polaczony === true &&
      finite(p.aktualizacja) &&
      t - p.aktualizacja >= -1000 &&
      t - p.aktualizacja < A.pressureAgeMs &&
      finite(p.bar) &&
      p.bar >= 0 &&
      p.bar <= 40 &&
      finite(p.napiecieV) &&
      p.napiecieV >= 0.5 &&
      p.napiecieV <= 4.5 &&
      Math.abs((p.napiecieV - 0.5) * 10 - p.bar) < 0.15
    );
  }
  powerConfig(l) {
    return (
      l?.wlaczony === true &&
      finite(l.kw) &&
      l.kw >= 10 &&
      l.kw <= 90 &&
      finite(l.minHz) &&
      l.minHz >= 0 &&
      l.minHz <= this.cfg.minHz
    );
  }
  trip(reason) {
    this.fault = this.fault || reason;
    this.armed = false;
    this.state = "zatrzymanie awaryjne";
    return { stop: true, reason: this.fault };
  }
  clearIfStopped(d) {
    if (!this.invalid && !this.cfg.wlaczony && d?.pracuje === false) {
      this.fault = "";
      this.state = "wyłączony";
    }
  }
  validateStart(s, l, t) {
    if (!this.loaded) return "Oczekiwanie na ustawienia regulatora";
    if (this.invalid) return this.invalid;
    if (this.fault) return "Blokada regulatora: " + this.fault + ". Wyłącz tryb, potwierdź postój i włącz ponownie.";
    if (!this.cfg.wlaczony) return null;
    if (this.invalid) return this.invalid;
    if (!s?.polaczony || s.awaria || !finite(s.aktualizacja) || t - s.aktualizacja > 5000 || t - s.aktualizacja < -1000)
      return "Brak świeżego, sprawnego falownika";
    if (s.pracuje === true) return "Pompa już pracuje — nie ponawiaj Start w trybie ciśnienia";
    if (!this.pressure(s.cisnienieTloczenia, t)) return "Brak aktualnego, poprawnego ciśnienia";
    if (s.cisnienieTloczenia.bar >= this.cfg.maxBar) return "Ciśnienie przekracza próg STOP";
    if (!this.powerConfig(l)) return "Wymagany aktywny limit mocy 10–90 kW i minimum Hz 0…min Hz regulatora";
    return null;
  }
  started(t) {
    this.lowPressureSince = 0;
    this.armed = true;
    this.startedAt = t;
    this.lastStep = t;
    this.atMaxSince = 0;
    this.filtered = null;
    this.state = "rozruch";
  }
  takeOver(s, l, t) {
    const error = this.validateStart({ ...s, pracuje: false }, l, t);
    if (error) return error;
    if (s.pracuje !== true) return "Przejęcie wymaga potwierdzonej pracy pompy";
    for (const hz of [s.czestotliwoscZadana, s.czestotliwoscWyjsciowa])
      if (!finite(hz) || hz < this.cfg.minHz || hz > this.cfg.maxHz) return "Bieżące Hz poza zakresem automatu";
    if (s.czestotliwoscWyjsciowa >= 5 && (!finite(s.moc) || s.moc <= 0)) return "Brak wiarygodnego pomiaru mocy";
    this.started(t);
    this.filtered = s.cisnienieTloczenia.bar;
    this.state = "przejęcie bieżących Hz";
    return null;
  }
  stopped() {
    this.lowPressureSince = 0;
    this.armed = false;
    this.filtered = null;
    this.lastStep = 0;
    this.atMaxSince = 0;
  }
  step(d, p, l, t) {
    this.clearIfStopped(d);
    if (this.fault) return { stop: true, reason: this.fault };
    if (!this.cfg.wlaczony) {
      this.state = "wyłączony";
      return { manual: true };
    }
    // RUN zanika poniżej częstotliwości startowej; nie oznacza to awarii ani zdjęcia STF.
    if (d.pracuje !== true && !this.armed) {
      this.state = "gotowy — pompa zatrzymana";
      this.armed = false;
      return { hold: true };
    }
    if (!this.armed)
      return this.trip(
        "Pompa pracuje bez ręcznego uzbrojenia regulatora (np. po restarcie). Wymagany STOP i ponowny Start.",
      );
    if (d.awaria) return this.trip("Awaria falownika");
    if (!this.pressure(p, t)) return this.trip("Utrata lub błędny odczyt ciśnienia (ponad 3 s)");
    if (p.bar >= this.cfg.maxBar) return this.trip("Ciśnienie osiągnęło próg STOP " + this.cfg.maxBar + " bar");
    if (!this.powerConfig(l)) return this.trip("Wyłączony lub nieprawidłowy limit mocy");
    if (t - this.startedAt > 3000 && d.czestotliwoscWyjsciowa >= 5 && (!finite(d.moc) || d.moc <= 0))
      return this.trip("Brak wiarygodnego pomiaru mocy");
    // Kontrola braku wody dopiero przy rzeczywistym rozpędzeniu, nie podczas przejścia przez 0 Hz.
    if (d.czestotliwoscWyjsciowa >= 35 && p.bar < 2) {
      this.lowPressureSince = this.lowPressureSince || t;
      if (t - this.lowPressureSince > 10000)
        return this.trip("Brak narastania ciśnienia: poniżej 2 bar przez 10 s przy co najmniej 35 Hz");
    } else this.lowPressureSince = 0;
    const hz = d.czestotliwoscZadana;
    if (!finite(hz) || hz < 0 || hz > 50 || !finite(d.czestotliwoscWyjsciowa))
      return this.trip("Nieprawidłowy pomiar częstotliwości");
    if (hz > this.cfg.maxHz + 0.1) return this.trip("Częstotliwość przekracza maksimum regulatora");
    if (hz < this.cfg.minHz - 0.1 && t - this.startedAt > 10000)
      return this.trip("Częstotliwość poniżej minimum regulatora");
    const floor = Math.max(this.cfg.minHz, l.minHz);
    if (hz >= this.cfg.maxHz - 0.1 && p.bar < this.cfg.bar - 0.3) {
      this.atMaxSince = this.atMaxSince || t;
      if (t - this.atMaxSince > 60000) return this.trip("Nie osiągnięto ciśnienia przez 60 s przy maksymalnych Hz");
    } else this.atMaxSince = 0;
    this.filtered = this.filtered === null ? p.bar : 0.4 * p.bar + 0.6 * this.filtered;
    const error = this.cfg.bar - this.filtered;
    if (t - this.lastStep < 1000) return { hold: true };
    this.lastStep = t;
    if (Math.abs(error) <= 0.3) {
      this.state = "utrzymuje ciśnienie";
      return { hz };
    }
    if (
      error > 0 &&
      ((d.czestotliwoscWyjsciowa >= 5 && (!finite(d.moc) || d.moc <= 0)) || (finite(d.moc) && d.moc >= l.kw - 3))
    ) {
      this.state = "ograniczenie mocą — bez zwiększania Hz";
      return { hz };
    }
    if (error > 0 && Math.abs(d.czestotliwoscWyjsciowa - hz) > 0.5) {
      this.state = "oczekiwanie na rampę falownika";
      return { hz };
    }
    // Brak całki: nie kumuluje błędu podczas działania limitu mocy.
    const delta = Math.sign(error) * clamp(Math.abs(error) * 0.12, 0.1, 0.2);
    const next = Math.round(clamp(hz + delta, floor, this.cfg.maxHz) * 10) / 10;
    this.state =
      next === hz
        ? error > 0
          ? "osiągnięto maksimum Hz"
          : "osiągnięto minimum Hz"
        : delta > 0
          ? "zwiększa Hz"
          : "zmniejsza Hz";
    return { hz: next };
  }
}
module.exports = { PressureController };
