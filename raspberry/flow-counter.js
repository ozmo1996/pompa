"use strict";
const { estimatePump } = require("./pump-estimate");
const METHOD = "65ysm8-photo-v1";
class FlowCounter {
  constructor(db, inletBar = 0) {
    if (!Number.isFinite(inletBar) || inletBar < -1 || inletBar > 10) throw new Error("Nieprawidłowe ciśnienie ssania");
    this.db = db;
    this.inletBar = inletBar;
    this.previous = null;
    this.session = null;
    this.current = null;
    db.exec("CREATE TABLE IF NOT EXISTS pump_volume (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    const saved = db.prepare("SELECT data FROM pump_volume WHERE id=1").get();
    this.state = saved ? JSON.parse(saved.data) : { m3: 0, probki: 0, od: null, ostatniPomiar: null, przerwy: 0 };
  }
  observe(s, now) {
    const result = estimatePump(s, now, this.inletBar);
    this.current = result;
    this.updated = now;
    if (result.q === null) {
      this.previous = null;
      this.session = null;
      return;
    }
    const t = Math.min(now, Math.max(s.aktualizacja, s.cisnienieTloczenia.aktualizacja));
    if (this.state.ostatniPomiar !== null && t <= this.state.ostatniPomiar) return;
    const prev = this.previous,
      dt = prev ? t - prev.time : 0;
    const valid = prev && dt > 0 && dt <= 3000;
    const state = { ...this.state, od: this.state.od ?? t, ostatniPomiar: t, probki: this.state.probki + 1 };
    if (valid) state.m3 += (((prev.q + result.q) / 2) * dt) / 3600000;
    else {
      if (state.probki > 1) state.przerwy++;
      this.session = t;
    }
    this.db.prepare("INSERT OR REPLACE INTO pump_volume VALUES (1, ?)").run(JSON.stringify(state));
    this.state = state;
    this.previous = { time: t, q: result.q };
  }
  row() {
    return {
      wydajnoscM3h: this.current?.q ?? null,
      przepompowaneM3: this.state.probki ? this.state.m3 : null,
      licznikPrzeplywuOd: this.state.od,
      sesjaWydajnosci: this.current?.q === null ? null : this.session,
      metodaWydajnosci: METHOD,
      cisnienieSsaniaBar: this.inletBar,
      konfiguracjaWydajnosciId: this.configId ?? "initial",
    };
  }
  snapshot() {
    return {
      ...this.state,
      ...this.row(),
      aktualizacja: this.updated ?? null,
      powod: this.current?.reason || "Oczekiwanie na dane",
    };
  }
}
module.exports = { FlowCounter };
