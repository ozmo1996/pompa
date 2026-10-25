"use strict";
// Próby liczników wyłącznie w bazie :memory:. Nigdy nie wysyła poleceń do falownika.
const assert = require("node:assert/strict");
async function main() {
  const Database = require("/home/pi/pompa-alarmy/node_modules/better-sqlite3"),
    db = new Database(":memory:");
  const { TelemetryHistory } = require("./telemetry-history"),
    { EnergyCounters } = require("./energy-counters"),
    { FlowCounter } = require("./flow-counter"),
    { CounterControl } = require("./counter-control"),
    { CloudSync } = require("./cloud-sync");
  const h = new TelemetryHistory(db, { update: async () => {} }),
    e = new EnergyCounters(db),
    f = new FlowCounter(db),
    c = new CounterControl(db, e, f);
  let resolve;
  const sync = new CloudSync(
    {
      update: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
    h,
    () => ({}),
    () => {},
  );
  const pending = sync.tick();
  await Promise.resolve();
  const t = Date.now();
  for (let i = 0; i <= 10; i++) {
    const now = t + i * 1000,
      s = {
        polaczony: true,
        pracuje: true,
        aktualizacja: now,
        aktualizacjaFalownika: now,
        moc: (58 * 0.8 ** 3) / 0.947,
        czestotliwoscWyjsciowa: 40,
        cisnienieTloczenia: { polaczony: true, bar: 354 * 0.8 ** 2 * 0.0980665, aktualizacja: now },
      };
    e.sample("pompa", 36, now, now);
    f.observe(s, now);
    h.pressure(s, now, f.row());
  }
  assert.ok(e.state.pompa.kwh > 0 && f.state.m3 > 0);
  const raw = f.state.m3;
  c.apply(
    {
      wersja: 1,
      id: "simulation-0001",
      akcja: "zeruj",
      licznik: "wszystkie",
      cisnienieSsaniaBar: 0,
      zmieniono: t,
      autorUid: "simulation",
      zmienil: "simulation",
    },
    t,
  );
  assert.equal(f.state.m3, raw);
  assert.equal(c.state.baselines.wodaM3.value, raw);
  resolve();
  await pending;
  db.close();
  const local = require("./local-telemetry").read();
  if (!local) throw Error("Brak bieżącego pliku telemetrii lokalnej");
  console.log(
    "IN_MEMORY_RESET_OK; OFFLINE_COLLECTION_OK; LOCAL_PIPE_OK; driveConnected=" +
      local.polaczony +
      "; NO_DRIVE_COMMANDS",
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
