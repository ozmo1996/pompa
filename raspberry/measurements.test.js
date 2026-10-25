const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { TelemetryHistory, waterSample } = require("./telemetry-history");
const { EnergyCounters } = require("./energy-counters");
const { FlowCounter } = require("./flow-counter");
const { CounterControl, validateRequest } = require("./counter-control");
const { CloudSync } = require("./cloud-sync");
const { snapshot } = require("./local-telemetry");
const { patchIndex, patchWriter } = require("./install-measurements.cjs");
function setup() {
  const raw = new DatabaseSync(":memory:");
  const db = {
    exec: (s) => raw.exec(s),
    prepare: (s) => raw.prepare(s),
    pragma: (s) => raw.exec("PRAGMA " + s),
    transaction: (fn) => () => {
      raw.exec("BEGIN");
      try {
        fn();
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const uploaded = {},
    h = new TelemetryHistory(db, { update: async (x) => Object.assign(uploaded, x) }),
    e = new EnergyCounters(db),
    f = new FlowCounter(db),
    c = new CounterControl(db, e, f);
  return { db, raw, h, e, f, c, uploaded };
}
const sample = (t) => ({
  aktualizacja: t,
  aktualizacjaFalownika: t,
  polaczony: true,
  pracuje: true,
  moc: (58 * 0.8 ** 3) / 0.947,
  czestotliwoscWyjsciowa: 40,
  cisnienieTloczenia: { polaczony: true, aktualizacja: t, bar: 354 * 0.8 ** 2 * 0.0980665 },
});
const request = (t, patch = {}) => ({
  wersja: 1,
  id: "reset-0001",
  akcja: "zeruj",
  licznik: "wszystkie",
  cisnienieSsaniaBar: 0,
  zmieniono: t,
  autorUid: "u1",
  zmienil: "test@example.com",
  ...patch,
});
test("Zerowanie: tylko punkty odniesienia, historia i sumy całkowite zachowane, idempotencja i restart", () => {
  const { raw, db, h, e, f, c } = setup(),
    t = 1000000;
  h.save("water", 0, { czas: t, poziom: 50 }, true);
  for (let i = 0; i <= 10; i++) {
    e.sample("pompa", 36, t + i * 1000, t + i * 1000);
    e.sample("agregat", 40, t + i * 1000, t + i * 1000);
    f.observe(sample(t + i * 1000), t + i * 1000);
  }
  const totals = JSON.stringify([e.state, f.state]),
    n = raw.prepare("SELECT COUNT(*) n FROM telemetry").get().n;
  assert.equal(c.apply(request(t + 10000), t + 10000), true);
  assert.equal(JSON.stringify([e.state, f.state]), totals);
  assert.equal(c.state.baselines.wodaM3.value, f.state.m3);
  assert.equal(c.state.baselines.pompaKwh.value, e.state.pompa.kwh);
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM telemetry").get().n, n + 1);
  assert.equal(c.apply(request(t + 10000), t + 11000), false);
  const again = new CounterControl(db, e, f);
  assert.deepEqual(again.state, c.state);
  assert.equal(again.apply(request(t + 10000), t + 20000), false);
  e.sample("pompa", 36, t + 11000, t + 11000);
  assert.ok(e.state.pompa.kwh > again.state.baselines.pompaKwh.value);
  raw.close();
});
test("Konfiguracja wspólna: zapis wersji, bez zerowania i bez całkowania przez zmianę modelu", () => {
  const { raw, c, f } = setup(),
    t = 1000000;
  f.observe(sample(t), t);
  f.observe(sample(t + 1000), t + 1000);
  const old = f.state.m3;
  c.apply(request(t + 1000, { akcja: "konfiguracja", licznik: "brak", cisnienieSsaniaBar: 2 }), t + 1000);
  assert.equal(f.inletBar, 2);
  assert.equal(f.row().konfiguracjaWydajnosciId, "reset-0001");
  assert.equal(f.previous, null);
  assert.equal(f.state.m3, old);
  f.observe(sample(t + 2000), t + 2000);
  assert.equal(f.state.m3, old);
  assert.deepEqual(c.state.baselines, {});
  raw.close();
});
test("Zlecenie stare, uszkodzone lub bez autora nie zeruje wskazań", () => {
  const { raw, c } = setup(),
    t = 1000000;
  for (const patch of [{ zmieniono: t - 121000 }, { licznik: "inny" }, { autorUid: "" }, { cisnienieSsaniaBar: 11 }])
    assert.ok(validateRequest(request(t, patch), t));
  c.apply(request(t, { zmieniono: t - 121000 }), t);
  assert.equal(c.state.ack.wynik, "odrzucono");
  assert.deepEqual(c.state.baselines, {});
  raw.close();
});
test("Brak internetu: oczekująca wysyłka nie blokuje lokalnych liczników, jedna wysyłka i późniejsze opróżnienie kolejki", async () => {
  const { raw, h, e, f, uploaded } = setup(),
    t = 1000000;
  let resolve,
    calls = 0;
  const sync = new CloudSync(
    {
      update: () => {
        calls++;
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
    h,
    () => ({ value: 1 }),
    () => {},
  );
  const pending = sync.tick();
  await Promise.resolve();
  for (let i = 0; i <= 10; i++) {
    const now = t + i * 1000;
    e.sample("pompa", 36, now, now);
    f.observe(sample(now), now);
    h.pressure(sample(now), now, f.row());
    sync.tick();
  }
  assert.equal(calls, 1);
  assert.ok(e.state.pompa.kwh > 0);
  assert.ok(f.state.m3 > 0);
  assert.ok(raw.prepare("SELECT COUNT(*) n FROM outbox").get().n > 0);
  resolve();
  await pending;
  assert.equal(raw.prepare("SELECT COUNT(*) n FROM outbox").get().n, 0);
  assert.ok(Object.keys(uploaded).length > 0);
  raw.close();
});
test("Świeżość czujników niezależna od pogody i innych zapisów; lokalny status bez sekretów", () => {
  const t = 1000000,
    s = {
      sondaPolaczona: true,
      poziomWodyProc: 50,
      aktualizacja: t,
      aktualizacjaPoziomu: t - 3600000,
      temperaturaWodyPolaczona: true,
      temperaturaWody: 5,
      aktualizacjaTemperatury: t - 3600000,
    };
  assert.equal(waterSample(s, t), null);
  assert.equal(waterSample({ ...s, aktualizacjaPoziomu: t }, t).temperaturaWody, null);
  const v = snapshot({ ...sample(t), apiKey: "secret" }, t);
  assert.equal(v.apiKey, undefined);
  assert.equal(v.aktualizacjaFalownika, t);
});
test("Instalator: tylko znane punkty integracji, brak blokowania sterowania, idempotencja", () => {
  const index = "const dane = await odczytajFalownik();";
  assert.match(patchIndex(index), /aktualizacjaFalownika/);
  assert.equal(patchIndex(patchIndex(index)), patchIndex(index));
  const writer = "module.exports = { ZapisStatusu, PROGI };";
  assert.match(patchWriter(writer), /publish\(stan\)/);
  assert.ok(!patchWriter(writer).includes("await"));
  assert.throws(() => patchWriter("nieznany kod"));
  assert.throws(() => patchIndex("nieznany kod"));
});
