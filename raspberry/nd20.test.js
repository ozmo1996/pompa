const { test } = require("node:test");
const assert = require("node:assert/strict");
const { decodeRegisters } = require("./nd20.js");
const { TelemetryHistory, waterSample } = require("./telemetry-history.js");
const { DatabaseSync } = require("node:sqlite");

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
  for (let dt = 0; dt <= 300000; dt += 5000) {
    h.meter({ mocKw: 0, czestotliwoscHz: 50 }, t + dt);
    h.water({ sondaPolaczona: true, aktualizacja: t + dt, poziomWodyProc: 20 }, t + dt);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM telemetry WHERE kind='agregat10s'").get().n, 31);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM telemetry WHERE kind='agregat'").get().n, 6);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM telemetry WHERE kind='woda'").get().n, 2);
  await assert.rejects(h.flush());
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM outbox").get().n, 8);
  const restarted = new TelemetryHistory(db, ref);
  restarted.meter({ mocKw: 0 }, t + 300001);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM outbox").get().n, 8);
  fail = false;
  await restarted.flush();
  assert.equal(Object.keys(uploaded).length, 8);
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
