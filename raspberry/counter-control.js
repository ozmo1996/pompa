"use strict";
const KINDS = ["pompaKwh", "agregatKwh", "wodaM3"];
function validateRequest(r, now) {
  if (!r || r.wersja !== 1 || typeof r.id !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(r.id))
    return "Błędny identyfikator";
  if (!["zeruj", "konfiguracja"].includes(r.akcja) || ![...KINDS, "wszystkie", "brak"].includes(r.licznik))
    return "Błędna operacja";
  if (r.akcja === "zeruj" && r.licznik === "brak") return "Brak wybranego licznika";
  if (r.akcja === "konfiguracja" && r.licznik !== "brak") return "Błędny cel konfiguracji";
  if (!Number.isFinite(r.cisnienieSsaniaBar) || r.cisnienieSsaniaBar < -1 || r.cisnienieSsaniaBar > 10)
    return "Błędne ciśnienie ssania";
  if (!Number.isFinite(r.zmieniono) || now - r.zmieniono < -1000 || now - r.zmieniono > 120000)
    return "Polecenie przeterminowane";
  if (
    typeof r.autorUid !== "string" ||
    !r.autorUid ||
    r.autorUid.length > 128 ||
    typeof r.zmienil !== "string" ||
    r.zmienil.length > 200
  )
    return "Brak autora";
  return null;
}
class CounterControl {
  constructor(db, energy, flow) {
    this.db = db;
    this.energy = energy;
    this.flow = flow;
    db.exec(
      "CREATE TABLE IF NOT EXISTS counter_control (id INTEGER PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS counter_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
    const saved = db.prepare("SELECT data FROM counter_control WHERE id=1").get();
    this.state = saved
      ? JSON.parse(saved.data)
      : { baselines: {}, cisnienieSsaniaBar: flow.inletBar, configId: "initial", ack: null };
    flow.inletBar = this.state.cisnienieSsaniaBar;
    flow.configId = this.state.configId;
  }
  apply(r, now = Date.now()) {
    if (!r) return false;
    if (typeof r.id !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(r.id)) return false;
    if (this.db.prepare("SELECT id FROM counter_requests WHERE id=?").get(r.id)) return false;
    const error = validateRequest(r, now),
      next = JSON.parse(JSON.stringify(this.state));
    next.ack = {
      id: r.id,
      wynik: error ? "odrzucono" : "wykonano",
      opis:
        error ||
        (r.akcja === "zeruj"
          ? "Wyzerowano wskazanie okresowe. Historia i sumy całkowite pozostają."
          : "Raspberry przyjęło wspólne ciśnienie ssania."),
      czas: now,
      autorUid: r.autorUid || "",
    };
    if (!error && r.akcja === "zeruj") {
      const totals = {
        pompaKwh: this.energy.state.pompa,
        agregatKwh: this.energy.state.agregat,
        wodaM3: this.flow.state,
      };
      for (const key of r.licznik === "wszystkie" ? KINDS : [r.licznik]) {
        const t = totals[key];
        next.baselines[key] = {
          value: t?.[key === "wodaM3" ? "m3" : "kwh"] ?? 0,
          origin: t?.od ?? null,
          at: now,
          autorUid: r.autorUid,
        };
      }
    } else if (!error) {
      next.cisnienieSsaniaBar = r.cisnienieSsaniaBar;
      next.configId = r.id;
    }
    const row = {
      czas: now,
      typ: error ? "licznik-odrzucono" : r.akcja === "zeruj" ? "licznik-zerowanie" : "kalibracja-przeplywu",
      id: r.id,
      licznik: r.licznik,
      autorUid: r.autorUid || "",
      opis: next.ack.opis,
      baselines: next.baselines,
      poprzedniePunktyOdniesienia: this.state.baselines,
      cisnienieSsaniaBar: next.cisnienieSsaniaBar,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO counter_requests VALUES (?, ?)").run(r.id, JSON.stringify(row));
      this.db.prepare("INSERT OR REPLACE INTO counter_control VALUES (1, ?)").run(JSON.stringify(next));
      this.db.prepare("INSERT OR IGNORE INTO outbox VALUES (?, ?)").run("counter-" + r.id, JSON.stringify(row));
      this.db
        .prepare("INSERT OR IGNORE INTO telemetry VALUES (?, ?, ?)")
        .run("counter-" + r.id, now, JSON.stringify(row));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    if (!error && r.akcja === "konfiguracja") {
      this.flow.previous = null;
      this.flow.session = null;
      this.flow.current = null;
      this.flow.inletBar = next.cisnienieSsaniaBar;
      this.flow.configId = next.configId;
    }
    this.state = next;
    return true;
  }
  snapshot(now = Date.now()) {
    return { wersja: 1, aktualizacja: now, ...this.state };
  }
}
module.exports = { CounterControl, validateRequest };
