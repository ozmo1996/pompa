"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { PressureController } = require("./pressure-controller");
const { WaterSafety } = require("./water-safety");
class PressureRuntime {
  constructor(db, options) {
    this.db = db;
    this.o = options;
    this.engine = new PressureController();
    this.tail = Promise.resolve();
    this.stopNeeded = false;
    this.stopping = false;
    this.lastState = null;
    this.wasOn = false;
    this.configRead = false;
    this.backendBusy = false;
    this.water = new WaterSafety(db, options);
    this.file = path.join(options.dir, "pressure-control-state.json");
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (v.fault) {
        this.engine.trip(v.fault);
        this.stopNeeded = true;
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        this.engine.trip("Nie można odczytać trwałego stanu zabezpieczenia");
        this.stopNeeded = true;
      }
    }
    this.savedFault = this.engine.fault;
    db.ref(options.base + "/ustawienia/regulatorCisnienia").on(
      "value",
      (snap) => {
        this.engine.configure(snap.val(), this.lastState?.pracuje === true);
        this.configRead = true;
        this.persist();
        this.publish();
      },
      () => {
        this.engine.invalid = "Brak dostępu do ustawień";
        if (this.engine.cfg.wlaczony) this.trip("Utrata odczytu ustawień regulatora");
      },
    );
    this.timer = setInterval(() => this.watchdog(), 500);
  }
  background(p) {
    Promise.resolve(p).catch((e) => this.o.log("Regulator: błąd zapisu", e.message));
  }
  serial(fn) {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => {});
    return p;
  }
  persist() {
    if (this.savedFault === this.engine.fault) return;
    try {
      const tmp = this.file + ".new";
      fs.writeFileSync(tmp, JSON.stringify({ fault: this.engine.fault, time: Date.now() }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.savedFault = this.engine.fault;
      if (!this.engine.fault) this.reportedFault = null;
    } catch (e) {
      this.engine.trip("Błąd trwałego zapisu zabezpieczenia");
      this.stopNeeded = true;
      this.o.log("Regulator: zapis stanu", e.message);
    }
  }
  trip(reason) {
    this.engine.trip(reason);
    const first = this.reportedFault !== this.engine.fault;
    this.reportedFault = this.engine.fault;
    this.stopNeeded = true;
    this.persist();
    if (first)
      this.background(
        this.db
          .ref(this.o.base + "/zdarzenia")
          .push({ czas: Date.now(), typ: "regulator-cisnienia-stop", opis: this.engine.fault }),
      );
    this.publish();
  }
  async stop() {
    if (!this.stopNeeded) return;
    try {
      await this.o.stop();
      this.o.limit.ustawCel(null);
      this.stopNeeded = false;
      this.engine.stopped();
    } catch (e) {
      this.o.log("Regulator: STOP niepotwierdzony, ponawiam", e.message);
      throw e;
    }
  }
  watchdog() {
    this.water.check(this.o.state());
    if (this.water.stopNeeded && !this.waterStopping) {
      this.waterStopping = true;
      this.serial(async () => {
        try {
          await this.stopWater();
        } finally {
          this.waterStopping = false;
        }
      }).catch(() => {});
    }
    this.water.publish();
    const e = this.engine;
    if (e.cfg.wlaczony && e.armed && !e.pressure(this.o.state()?.cisnienieTloczenia, Date.now()))
      this.trip("Utrata lub błędny odczyt ciśnienia (ponad 3 s)");
    if (this.stopNeeded && !this.stopping) {
      this.stopping = true;
      this.serial(() => this.stop())
        .catch(() => {})
        .finally(() => {
          this.stopping = false;
        });
    }
    this.publish();
  }
  prepareCommand(p, s, limit) {
    if (p?.akcja === "stop") {
      this.operatorStopping = true;
      this.water.startingUntil = 0;
      this.engine.stopped();
      return p;
    }
    if (p?.akcja === "start") {
      if (this.operatorStopping) throw new Error("Trwa zatrzymywanie — poczekaj na potwierdzenie postoju");
      const waterError = this.water.validateStart(s);
      if (waterError) throw new Error(waterError);
      const error = this.engine.validateStart(s, limit.cfg, Date.now());
      if (error) throw new Error(error);
      return this.engine.cfg.wlaczony ? { ...p, czestotliwosc: this.engine.cfg.minHz } : p;
    }
    if (p?.akcja === "czestotliwosc" && (this.engine.cfg.wlaczony || this.engine.fault))
      throw new Error("Ręczne Hz zablokowane — wyłącz regulator i usuń blokadę");
    if (p?.akcja === "czestotliwosc" && this.operatorStopping) throw new Error("Trwa zatrzymywanie");
    if (p?.akcja === "czestotliwosc" && this.water.fault) throw new Error("Blokada zabezpieczenia wody");
    return p;
  }
  started() {
    this.water.startingUntil = Date.now() + 5000;
    this.water.running = true;
    this.engine.started(Date.now());
  }
  async beforeStart(state, limit, plannedHz, writeHz) {
    const waterError = this.water.validateStart(state);
    if (waterError) throw new Error(waterError);
    const error = this.engine.validateStart(state, limit.cfg, Date.now());
    if (error) throw new Error(error);
    if (this.engine.cfg.wlaczony && plannedHz !== this.engine.cfg.minHz) await writeHz(this.engine.cfg.minHz);
  }
  driveError(error) {
    if (this.engine.cfg.wlaczony && (this.engine.armed || this.lastState?.pracuje))
      this.trip("Utrata komunikacji z falownikiem: " + error.message);
  }
  async control(d, s, limit) {
    this.lastState = d;
    if (this.operatorStopping) {
      this.engine.state = "zatrzymywanie";
      if (d.pracuje === false && Number.isFinite(d.czestotliwoscWyjsciowa) && d.czestotliwoscWyjsciowa <= 0.7) {
        this.operatorStopping = false;
        this.engine.state = "pompa zatrzymana";
      }
      return { hz: null };
    }
    if (this.water.check({ ...s, ...d })) {
      if (this.water.stopNeeded) await this.stopWater();
      return { hz: null };
    }
    const e = this.engine,
      enabled = e.cfg.wlaczony;
    if (!e.loaded) return { hz: null };
    if (this.wasOn && !enabled && !e.fault && Number.isFinite(d.czestotliwoscZadana))
      limit.ustawCel(d.czestotliwoscZadana);
    this.wasOn = enabled;
    const hadFault = !!e.fault;
    const plan = e.step(d, s.cisnienieTloczenia, limit.cfg, Date.now());
    this.persist();
    if (plan.stop) {
      if (!hadFault) this.trip(plan.reason);
      else if (d.pracuje) this.stopNeeded = true;
      await this.stop();
      return { hz: null };
    }
    if (!enabled) return limit.krok({ moc: d.moc, pracuje: d.pracuje });
    if (!d.pracuje && !e.armed) return { hz: null };
    // Poniżej progu RUN limit mocy zeruje hzEff. Nie wolno przez to blokować rozruchu od 0 Hz.
    if (!d.pracuje && e.armed && d.czestotliwoscWyjsciowa < 5) {
      return { hz: Number.isFinite(plan.hz) && Math.abs(plan.hz - d.czestotliwoscZadana) >= 0.09 ? plan.hz : null };
    }
    // Limit mocy ma pierwszeństwo. Bez resetowania jego pamięci i bez drugiego zapisu Hz.
    const target = Number.isFinite(plan.hz) ? plan.hz : d.czestotliwoscZadana;
    limit.hzCel = target;
    if (!Number.isFinite(limit.hzEff)) limit.hzEff = d.czestotliwoscZadana;
    const correction = limit.krok({ moc: d.moc, pracuje: d.pracuje });
    let hz = Math.min(target, Number.isFinite(correction.hz) ? correction.hz : limit.hzEff);
    hz = Math.round(hz * 10) / 10;
    if (e.fault) {
      await this.stop();
      return { hz: null };
    }
    return { ...correction, hz: Math.abs(hz - d.czestotliwoscZadana) >= 0.09 ? hz : null };
  }
  publish() {
    if (this.backendBusy || Date.now() - (this.lastPublish || 0) < 2000) return;
    this.lastPublish = Date.now();
    this.backendBusy = true;
    const e = this.engine;
    const data = {
      wersja: 1,
      aktualizacja: Date.now(),
      ustawieniaId: e.cfg.id,
      wlaczony: e.cfg.wlaczony,
      uzbrojony: e.armed,
      stan: e.state,
      awaria: e.fault || e.invalid || "",
      stopNiepotwierdzony: this.stopNeeded,
      barCel: e.cfg.bar,
      minHz: e.cfg.minHz,
      maxHz: e.cfg.maxHz,
      maxBar: e.cfg.maxBar,
    };
    Promise.resolve(this.db.ref(this.o.base + "/statusRegulatoraCisnienia").update(data))
      .catch((err) => this.o.log("Regulator: status", err.message))
      .finally(() => {
        this.backendBusy = false;
      });
  }
  async stopWater() {
    if (!this.water.stopNeeded) return;
    try {
      await this.o.stop();
      this.o.limit.ustawCel(null);
      this.engine.stopped();
      this.water.startingUntil = 0;
      this.water.stopNeeded = false;
    } catch (e) {
      this.o.log("Woda: STOP niepotwierdzony — ponawiam", e.message);
      throw e;
    }
  }
}
module.exports = { PressureRuntime };
