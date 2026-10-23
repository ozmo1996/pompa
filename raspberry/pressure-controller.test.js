const { test } = require("node:test"),
  assert = require("node:assert/strict");
const A = require("./pressure-control-schema"),
  { PressureController } = require("./pressure-controller");
const L = { wlaczony: true, kw: 85, minHz: 35 };
const p = (t, bar = 20) => ({ polaczony: true, aktualizacja: t, bar, napiecieV: 0.5 + bar / 10 });
const d = (hz = 40) => ({ pracuje: true, awaria: false, moc: 60, czestotliwoscZadana: hz, czestotliwoscWyjsciowa: hz });
test("Regulator: minimum 0 Hz i brak RUN nie blokują ręcznie uzbrojonego rozruchu", () => {
  const c = new PressureController();
  c.configure({ ...A.defaults(), wlaczony: true });
  c.started(100000);
  assert.equal(A.validate({ ...A.defaults(), minHz: 0 }), null);
  const r = c.step({ ...d(0), pracuje: false, moc: 0 }, p(101000, 0), { ...L, minHz: 0 }, 101000);
  assert.equal(r.hz, 0.2);
  assert.equal(c.fault, "");
  c.stopped();
  assert.equal(c.step({ ...d(0), pracuje: false, moc: 0 }, p(102000, 0), { ...L, minHz: 0 }, 102000).hold, true);
});
function setup() {
  const c = new PressureController();
  c.configure({ ...A.defaults(), minHz: 35, wlaczony: true });
  c.started(100000);
  return c;
}
test("Regulator: domyślnie wyłączony, konfiguracja walidowana", () => {
  const c = new PressureController();
  c.configure(null);
  assert.equal(c.cfg.wlaczony, false);
  assert.deepEqual(c.step(d(), null, L, 100), { manual: true });
  for (const change of [
    { bar: 31 },
    { maxBar: 26 },
    { minHz: -1 },
    { maxHz: 51 },
    { id: "a" },
    { bar: NaN },
    { minHz: 50, maxHz: 40 },
    { extra: 1 },
  ])
    assert.ok(A.validate({ ...A.defaults(), ...change }));
});
test("Regulator: brak samoczynnego startu i uzbrojenia po restarcie", () => {
  const c = new PressureController();
  c.configure({ ...A.defaults(), wlaczony: true });
  assert.deepEqual(c.step({ ...d(), pracuje: false }, p(100000), L, 100000), { hold: true });
  assert.equal(c.step(d(), p(101000), L, 101000).stop, true);
  assert.ok(c.fault);
});
test("Regulator: Start wymaga świeżego czujnika, falownika i limitu mocy", () => {
  const c = setup(),
    t = 101000,
    s = { polaczony: true, awaria: false, aktualizacja: t, cisnienieTloczenia: p(t) };
  assert.equal(c.validateStart(s, L, t), null);
  for (const source of [
    { ...s, cisnienieTloczenia: p(t - 3000) },
    { ...s, cisnienieTloczenia: { ...p(t), napiecieV: 0 } },
    { ...s, polaczony: false },
    { ...s, aktualizacja: t - 6000 },
    { ...s, awaria: true },
  ])
    assert.ok(c.validateStart(source, L, t));
  assert.ok(c.validateStart(s, { ...L, wlaczony: false }, t));
  assert.ok(c.validateStart(s, { ...L, kw: 110 }, t));
});
test("Regulator: zmiany Hz ograniczone, strefa nieczułości i oczekiwanie na rampę", () => {
  const c = setup();
  assert.equal(c.step(d(), p(101000, 20), L, 101000).hz, 40.2);
  assert.equal(c.step(d(), p(101200, 20), L, 101200).hold, true);
  const c2 = setup();
  assert.equal(c2.step(d(), p(101000, 25), L, 101000).hz, 40);
  const c3 = setup();
  assert.equal(c3.step(d(), p(101000, 30), L, 101000).hz, 39.8);
  const c4 = setup();
  assert.equal(c4.step({ ...d(), czestotliwoscWyjsciowa: 37 }, p(101000, 20), L, 101000).hz, 40);
});
test("Regulator: limit mocy i granice Hz mają pierwszeństwo nad celem", () => {
  const c = setup();
  assert.equal(c.step({ ...d(), moc: 84 }, p(101000, 10), L, 101000).hz, 40);
  const high = setup();
  assert.equal(high.step(d(50), p(101000, 20), L, 101000).hz, 50);
  const low = setup();
  assert.equal(low.step(d(35), p(101000, 30), L, 101000).hz, 35);
});
for (const [name, pressure, drive, lim, time] of [
  ["nadciśnienie", (t) => p(t, 32), d(), L, 101000],
  ["stary pomiar", (t) => p(t - 3000), d(), L, 101000],
  ["brak czujnika", () => null, d(), L, 101000],
  ["błędny sygnał", (t) => ({ ...p(t), napiecieV: 0 }), d(), L, 101000],
  ["brak mocy", (t) => p(t), { ...d(), moc: null }, L, 104000],
  ["limit wyłączony", (t) => p(t), d(), { ...L, wlaczony: false }, 101000],
  ["awaria napędu", (t) => p(t), { ...d(), awaria: true }, L, 101000],
  ["brak narastania", (t) => p(t, 0), d(), L, 111000],
  ["błędna częstotliwość", (t) => p(t), { ...d(), czestotliwoscZadana: NaN }, L, 101000],
])
  test("Regulator: zatrzymanie i zatrzask — " + name, () => {
    const c = setup();
    if (name === "brak narastania") c.step(drive, pressure(100000), lim, 100000);
    assert.equal(c.step(drive, pressure(time), lim, time).stop, true);
    assert.equal(c.step(d(), p(time + 1000), L, time + 1000).stop, true);
    assert.ok(c.validateStart({}, L, time + 1000));
  });
test("Regulator: blokada znika dopiero po wyłączeniu trybu i potwierdzeniu postoju", () => {
  const c = setup();
  c.trip("test");
  c.configure(A.defaults());
  assert.equal(c.step(d(), p(102000), L, 102000).stop, true);
  assert.equal(c.step({ ...d(), pracuje: false }, p(103000), L, 103000).manual, true);
  assert.equal(c.fault, "");
  c.configure({ ...A.defaults(), wlaczony: true });
  assert.equal(c.armed, false);
});
test("Regulator: toleruje krótki rozruch, STOP i zewnętrzne zatrzymanie nie powodują restartu", () => {
  const c = setup();
  c.step({ ...d(), pracuje: false }, p(101000), L, 101000);
  assert.equal(c.armed, true);
  c.step(d(), p(102000), L, 102000);
  assert.equal(c.fault, "");
  c.stopped();
  assert.equal(c.step({ ...d(), pracuje: false }, p(103000), L, 103000).hold, true);
  assert.equal(c.armed, false);
});
test("Regulator: po 60 s przy maksimum bez osiągnięcia celu zatrzymuje pompę", () => {
  const c = setup();
  c.step(d(50), p(101000, 20), L, 101000);
  assert.equal(c.step(d(50), p(162000, 20), L, 162000).stop, true);
});
test("Regulator: zmiana granic lub włączenie podczas pracy blokują automat", () => {
  const c = setup();
  c.configure({ ...c.cfg, maxHz: 48 }, true);
  assert.ok(c.fault);
  const c2 = new PressureController();
  c2.configure({ ...A.defaults(), wlaczony: true }, true);
  assert.ok(c2.fault);
});
test("Symulacja pompy: dojście do 25 bar, bez skoków Hz i bez przekroczenia 32 bar", () => {
  const c = setup();
  let hz = 35,
    bar = 15;
  for (let i = 1; i <= 400; i++) {
    const time = 100000 + i * 1000;
    const r = c.step(d(hz), p(time, bar), L, time);
    assert.ok(!r.stop, c.fault);
    if (r.hz !== undefined) {
      assert.ok(Math.abs(r.hz - hz) <= 0.201);
      hz = r.hz;
    }
    bar += 0.25 * ((hz / 40) ** 2 * 25 - bar);
    assert.ok(bar < 32);
  }
  assert.ok(Math.abs(bar - 25) < 0.6, bar);
  assert.ok(hz >= 35 && hz <= 50);
});
