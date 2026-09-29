"use strict";

// Niezależna historia agregatu i wody. SQLite przechowuje także kolejkę
// wysyłki, więc przerwa w internecie nie usuwa zebranych próbek.
const finite = (v) => typeof v === "number" && Number.isFinite(v);
function waterSample(s, now) {
  if (
    !s?.sondaPolaczona ||
    !finite(s.poziomWodyProc) ||
    !finite(s.aktualizacja) ||
    now - s.aktualizacja > 30000 ||
    s.aktualizacja > now + 60000
  )
    return null;
  return {
    czas: now,
    typ: "woda",
    poziom: s.poziomWodyProc,
    mA: finite(s.poziomWodyMa) ? s.poziomWodyMa : null,
    temperaturaWody: s.temperaturaWodyPolaczona && finite(s.temperaturaWody) ? s.temperaturaWody : null,
  };
}

class TelemetryHistory {
  constructor(db, ref) {
    this.db = db;
    this.ref = ref;
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS telemetry (
      kind TEXT NOT NULL, czas INTEGER NOT NULL, dane TEXT NOT NULL,
      PRIMARY KEY(kind, czas));
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, dane TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule (kind TEXT PRIMARY KEY, czas INTEGER NOT NULL);`);
    this.last = Object.fromEntries(
      db
        .prepare("SELECT kind, czas FROM schedule")
        .all()
        .map((r) => [r.kind, r.czas]),
    );
  }
  save(kind, interval, row, cloud) {
    if (row.czas - (this.last[kind] || 0) < interval) return;
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO telemetry VALUES (?, ?, ?)").run(kind, row.czas, JSON.stringify(row));
      if (cloud)
        this.db.prepare("INSERT OR IGNORE INTO outbox VALUES (?, ?)").run(`${kind}-${row.czas}`, JSON.stringify(row));
      this.db.prepare("INSERT OR REPLACE INTO schedule VALUES (?, ?)").run(kind, row.czas);
    })();
    this.last[kind] = row.czas;
  }
  meter(data, now) {
    const row = { czas: now, typ: "agregat", nd20: data };
    this.save("agregat10s", 10000, row, false);
    this.save("agregat", 60000, row, true);
  }
  water(status, now) {
    const row = waterSample(status, now);
    if (row) this.save("woda", 300000, row, true);
  }
  async flush() {
    const rows = this.db.prepare("SELECT id, dane FROM outbox ORDER BY id LIMIT 100").all();
    if (!rows.length) return;
    await this.ref.update(Object.fromEntries(rows.map((r) => [r.id, JSON.parse(r.dane)])));
    this.db.transaction(() => {
      for (const r of rows) this.db.prepare("DELETE FROM outbox WHERE id = ?").run(r.id);
    })();
  }
}
module.exports = { TelemetryHistory, waterSample };
