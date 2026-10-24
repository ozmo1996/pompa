"use strict";
// Dwa niezależne całkowania mocy czynnej. Brak próbek nie oznacza zerowego zużycia.
// Stan i każda doliczona porcja są trwale zapisane w SQLite; restart nie łączy przerwy.
class EnergyCounters {
  constructor(db) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS energy_counters (kind TEXT PRIMARY KEY, data TEXT NOT NULL)");
    this.previous = {};
    this.state = Object.fromEntries(
      db
        .prepare("SELECT kind, data FROM energy_counters")
        .all()
        .map((r) => [r.kind, JSON.parse(r.data)]),
    );
  }
  invalidate(kind) {
    delete this.previous[kind];
  }
  sample(kind, kw, time, now = Date.now()) {
    const max = kind === "pompa" ? 200 : 1000;
    if (![kw, time, now].every(Number.isFinite) || kw < 0 || kw > max || time > now + 1000 || now - time > 15000) {
      this.invalidate(kind);
      return false;
    }
    const old = this.state[kind];
    // Powtórzony zapis statusu, aktualizacja innego czujnika lub cofnięty zegar nie naliczają kWh.
    if (old && time <= old.ostatniPomiar) return false;
    const prev = this.previous[kind],
      dt = prev ? time - prev.time : 0;
    const data = { ...(old || { kwh: 0, od: time, probki: 0, przerwy: 0 }), ostatniPomiar: time };
    if (prev && dt > 0 && dt <= 15000) data.kwh += (((prev.kw + kw) / 2) * dt) / 3600000;
    else if (old) data.przerwy++;
    data.probki++;
    // Zmiana pamięci dopiero po potwierdzonym zapisie.
    this.db.prepare("INSERT OR REPLACE INTO energy_counters VALUES (?, ?)").run(kind, JSON.stringify(data));
    this.state[kind] = data;
    this.previous[kind] = { kw, time };
    return true;
  }
  snapshot() {
    return { wersja: 1, aktualizacja: Date.now(), metoda: "calka-mocy", ...this.state };
  }
}
module.exports = { EnergyCounters };
