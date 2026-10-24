const { test } = require("node:test");
const assert = require("node:assert/strict");
const { decodeRegisters } = require("./nd20.js");
const { TelemetryHistory, waterSample, pressureSample } = require("./telemetry-history.js");
const { DatabaseSync } = require("node:sqlite");
const { EnergyCounters } = require("./energy-counters.js");

test("Energia: kW × godziny, osobne źródła, duplikaty, restart i przerwy bez fikcyjnych kWh", () => {
  const sqlite = new DatabaseSync(":memory:");
  let e = new EnergyCounters(sqlite);
  const t = 1000000;
  for (let i = 0; i <= 360; i++) {
    const time = t + i * 10000;
    e.sample("pompa", 36, time, time);
    e.sample("agregat", 40, time, time);
    e.sample("pompa", 36, time, time); // ponowna aktualizacja innego pola statusu
  }
  assert.ok(Math.abs(e.state.pompa.kwh - 36) < 1e-9);
  assert.ok(Math.abs(e.state.agregat.kwh - 40) < 1e-9);
  const end = t + 3600000;
  e = new EnergyCounters(sqlite);
  e.sample("pompa", 36, end + 3600000, end + 3600000); // nie dolicza godziny postoju procesu
  assert.ok(Math.abs(e.state.pompa.kwh - 36) < 1e-9);
  e.sample("pompa", null, end + 3601000, end + 3601000);
  e.sample("pompa", 36, end + 3610000, end + 3610000); // pierwsza poprawna próbka po błędzie
  assert.ok(Math.abs(e.state.pompa.kwh - 36) < 1e-9);
  e.sample("pompa", 36, end + 3620000, end + 3620000);
  assert.ok(Math.abs(e.state.pompa.kwh - 36.1) < 1e-9);
  e.sample("pompa", 36, end + 4000000, end + 4000000); // długa przerwa
  assert.ok(Math.abs(e.state.pompa.kwh - 36.1) < 1e-9);
  const samples = e.state.pompa.probki;
  for (const [kw, time, now] of [
    [-1, end + 4010000, end + 4010000],
    [NaN, end + 4010000, end + 4010000],
    [36, end + 4010000, end + 5000000],
    [36, end + 3000000, end + 4000000],
  ])
    e.sample("pompa", kw, time, now);
  assert.equal(e.state.pompa.probki, samples);
  assert.ok(e.state.pompa.przerwy >= 3);
  assert.ok(Math.abs(e.state.agregat.kwh - 40) < 1e-9);
  sqlite.close();
});

test("Ciśnienie: wyłącznie pracująca pompa i świeże prawidłowe pomiary, zero jest pomiarem", () => {
  const now = 1000000;
  const s = {
    polaczony: true,
    pracuje: true,
    aktualizacja: now,
    cisnienieTloczenia: { polaczony: true, aktualizacja: now, bar: 25 },
  };
  assert.equal(pressureSample(s, now).cisnienieBar, 25);
  for (const patch of [
    { pracuje: false },
    { polaczony: false },
    { aktualizacja: now - 3000 },
    { aktualizacja: now + 1 },
  ])
    assert.equal(pressureSample({ ...s, ...patch }, now), null);
  for (const patch of [
    { polaczony: false },
    { aktualizacja: now - 3000 },
    { bar: null },
    { bar: NaN },
    { bar: -1 },
    { bar: 41 },
  ])
    assert.equal(pressureSample({ ...s, cisnienieTloczenia: { ...s.cisnienieTloczenia, ...patch } }, now), null);
  assert.equal(pressureSample({ ...s, cisnienieTloczenia: { ...s.cisnienieTloczenia, bar: 0 } }, now).cisnienieBar, 0);
});

test("Historia: świeża woda na postoju, bez fikcyjnych pomiarów offline", () => {
  const s = { sondaPolaczona: true, aktualizacja: 1000000, poziomWodyProc: 0, pracuje: false };
  assert.equal(waterSample(s, 1000000).poziom, 0);
  assert.equal(waterSample({ ...s, sondaPolaczona: false }, 1000000), null);
  assert.equal(waterSample(s, 1030001), null);
  assert.equal(waterSample({ ...s, poziomWodyProc: null }, 1000000), null);
});

test("Historia: interwały 10 s / 1 min / 5 min i trwała kolejka po błędzie sieci", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = {
    pragma: (text) => sqlite.exec(`PRAGMA ${text}`),
    exec: (text) => sqlite.exec(text),
    prepare: (text) => sqlite.prepare(text),
    transaction: (fn) => () => {
      sqlite.exec("BEGIN");
      try {
        fn();
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  let fail = true;
  const uploaded = {};
  const ref = {
    update: async (rows) => {
      if (fail) throw new Error("offline");
      Object.assign(uploaded, rows);
    },
  };
  const h = new TelemetryHistory(db, ref),
    t = 1000000;
  for (let dt = 0; dt <= 20000; dt += 1000) {
    h.pressure(
      {
        polaczony: true,
        pracuje: true,
        aktualizacja: t + dt,
        cisnienieTloczenia: { polaczony: true, bar: 25, aktualizacja: t + dt },
      },
      t + dt,
    );
  }
  h.pressure({ polaczony: true, pracuje: false }, t + 30000);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM telemetry WHERE kind='cisnienie'").get().n, 3);
  assert.equal(h.pressureRun, null);
  for (let dt = 0; dt <= 300000; dt += 5000) {
    h.meter({ mocKw: 0, czestotliwoscHz: 50 }, t + dt);
    h.water({ sondaPolaczona: true, aktualizacja: t + dt, poziomWodyProc: 20 }, t + dt);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM telemetry WHERE kind='agregat10s'").get().n, 31);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM telemetry WHERE kind='agregat'").get().n, 6);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM telemetry WHERE kind='woda'").get().n, 2);
  await assert.rejects(h.flush());
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM outbox").get().n, 11);
  const restarted = new TelemetryHistory(db, ref);
  restarted.meter({ mocKw: 0 }, t + 300001);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM outbox").get().n, 11);
  fail = false;
  await restarted.flush();
  assert.equal(Object.keys(uploaded).length, 11);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM outbox").get().n, 0);
  sqlite.close();
});

test("ND20: kolejność słów float i mapa mocy trójfazowej", () => {
  const words = Array(66).fill(0);
  const put = (offset, value) => {
    const b = Buffer.alloc(4);
    b.writeFloatBE(value);
    words[offset] = b.readUInt16BE(0);
    words[offset + 1] = b.readUInt16BE(2);
  };
  put(0, 230);
  put(2, 125);
  put(46, 74250);
  put(56, 50);
  put(58, 400);
  const result = decodeRegisters(words);
  assert.equal(result.napiecieL1, 230);
  assert.equal(result.pradL1, 125);
  assert.equal(result.mocKw, 74.25);
  assert.equal(result.czestotliwoscHz, 50);
  assert.equal(result.napiecieL1L2, 400);
});

test("ND20: niepełna odpowiedź lub wartości alarmowe nie udają pomiaru", () => {
  assert.throws(() => decodeRegisters([1, 2]));
  const words = Array(66).fill(0);
  const alarm = Buffer.alloc(4);
  alarm.writeFloatBE(1e20);
  words[56] = alarm.readUInt16BE(0);
  words[57] = alarm.readUInt16BE(2);
  assert.equal(decodeRegisters(words).czestotliwoscHz, null);
});
