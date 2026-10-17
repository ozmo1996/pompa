"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  A = require("./water-safety-schema");
class WaterSafety {
  constructor(db, o) {
    this.db = db;
    this.o = o;
    this.cfg = A.defaults();
    this.loaded = false;
    this.fault = "";
    this.warning = false;
    this.stopNeeded = false;
    this.startingUntil = 0;
    this.file = path.join(o.dir, "water-safety-state.json");
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (A.validate(v.cfg)) throw new Error("Nieprawidłowa kopia ustawień");
      this.cfg = v.cfg;
      this.fault = typeof v.fault === "string" ? v.fault : "";
      this.loaded = true;
    } catch (e) {
      if (e.code !== "ENOENT") this.fault = "Nie można odczytać lokalnego zabezpieczenia wody";
    }
    db.ref(o.base + "/ustawienia/zabezpieczenieWody").on(
      "value",
      (snap) => this.configure(snap.val()),
      () => {
        // Przy braku sieci pozostaje ostatnia poprawna lokalna konfiguracja.
        this.o.log("Woda: brak dostępu do nowych ustawień; pozostaje kopia lokalna");
      },
    );
  }
  persist() {
    try {
      fs.writeFileSync(this.file + ".new", JSON.stringify({ cfg: this.cfg, fault: this.fault }), { mode: 0o600 });
      fs.renameSync(this.file + ".new", this.file);
    } catch (e) {
      this.fault = "Błąd trwałego zapisu zabezpieczenia wody";
      this.stopNeeded = true;
      this.o.log(this.fault, e.message);
    }
  }
  configure(value) {
    const c = value ?? A.defaults(),
      error = A.validate(c);
    if (error) {
      this.trip(error);
      return;
    }
    const reset = c.resetId !== this.cfg.resetId;
    const s = this.o.state(),
      t = Date.now(),
      cm = A.level(s, t);
    this.cfg = c;
    this.loaded = true;
    if (
      reset &&
      s?.polaczony === true &&
      s.pracuje === false &&
      Number.isFinite(s.aktualizacja) &&
      t >= s.aktualizacja &&
      t - s.aktualizacja < 5000 &&
      (!c.wlaczony || (cm !== null && cm > c.stopCm + 5))
    ) {
      this.fault = "";
      this.stopNeeded = false;
    }
    this.persist();
    this.check(s, t);
  }
  trip(reason) {
    if (!this.fault) {
      this.fault = reason;
      this.persist();
    }
  }
  check(s, t = Date.now()) {
    if (s?.pracuje === true) this.running = true;
    else if (s?.polaczony === true && s.pracuje === false && t >= this.startingUntil) this.running = false; // utrata łączności nie jest potwierdzeniem postoju
    const cm = A.level(s, t),
      running = this.running === true || t < this.startingUntil;
    if (this.loaded && this.cfg.wlaczony && running) {
      if (cm === null) this.trip("Brak aktualnego odczytu poziomu wody (5 s)");
      else if (cm <= this.cfg.stopCm) this.trip(`Niski poziom wody: ${cm.toFixed(1)} cm ≤ ${this.cfg.stopCm} cm`);
    }
    if (this.fault && running) this.stopNeeded = true;
    if (!this.cfg.ostrzegaj || !running || cm === null) this.warning = false;
    else if (cm <= this.cfg.ostrzezenieCm) this.warning = true;
    else if (cm > this.cfg.ostrzezenieCm + 5) this.warning = false;
    this.cm = cm;
    return this.fault || this.stopNeeded;
  }
  validateStart(s, t = Date.now()) {
    this.check(s, t);
    if (!this.loaded) return "Oczekiwanie na ustawienia zabezpieczenia wody";
    if (this.fault) return "Blokada wody: " + this.fault;
    if (this.cfg.wlaczony) {
      const cm = A.level(s, t);
      if (cm === null) return "Brak aktualnego pomiaru poziomu wody";
      if (cm <= this.cfg.stopCm + 5) return "Do START wymagany poziom ponad próg STOP + 5 cm";
    }
    return null;
  }
  publish() {
    if (this.busy || Date.now() - (this.lastPublish || 0) < 2000) return;
    this.busy = true;
    this.lastPublish = Date.now();
    Promise.resolve(
      this.db.ref(this.o.base + "/statusZabezpieczeniaWody").update({
        wersja: 1,
        aktualizacja: Date.now(),
        ustawieniaId: this.cfg.id,
        wlaczony: this.cfg.wlaczony,
        ostrzegaj: this.cfg.ostrzegaj,
        ostrzezenie: this.warning,
        awaria: this.fault,
        stopNiepotwierdzony: this.stopNeeded,
        poziomCm: this.cm ?? null,
        stopCm: this.cfg.stopCm,
        ostrzezenieCm: this.cfg.ostrzezenieCm,
      }),
    )
      .catch((e) => this.o.log("Woda: zapis statusu", e.message))
      .finally(() => {
        this.busy = false;
      });
  }
}
module.exports = { WaterSafety };
