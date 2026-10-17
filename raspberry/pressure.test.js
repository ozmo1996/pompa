const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const pressure = require("./pressure");
const { patchPressure } = require("./install-pressure");
test("Ciśnienie V1: zero, środek i pełny zakres; błędny sygnał nie udaje ciśnienia", () => {
  for (const [raw, bar] of [
    [50, 0],
    [250, 20],
    [370, 32],
    [450, 40],
  ]) {
    const r = pressure.pressureSample(raw, 1234);
    assert.equal(r.bar, bar);
    assert.equal(r.napiecieV, raw / 100);
    assert.equal(r.aktualizacja, 1234);
  }
  for (const raw of [0, 49, 451, 65535, null, NaN, -1, 2.5]) assert.equal(pressure.pressureSample(raw).bar, null);
  assert.equal(pressure.disconnectedPressure().polaczony, false);
  assert.equal(pressure.disconnectedPressure().bar, null);
});
const fixture = `const untouchedBefore=1;
async function odczytajPoziom() {
 const p=cfg.poziomWody;
 if (!p.wlaczony) return {};
 if (!sonda.isOpen && !(await polaczSonde())) return { sondaPolaczona: false };
 try {
  const odczyt = await sonda.readHoldingRegisters(p.rejestr, 1);
  const mA = odczyt.data[0] / 10;
  return {poziomWodyMa: mA, sondaPolaczona: true};
 } catch(e) { return { sondaPolaczona: false }; }
}
async function untouchedAfter() { return 17; }`;
test("Integracja V1: jeden odczyt 4 rejestrów, C2 pozostaje C2, brak zapisów Modbus", async () => {
  const next = patchPressure(fixture);
  assert.equal(patchPressure(next), next);
  assert.ok(next.startsWith("const untouchedBefore=1;"));
  assert.ok(next.endsWith("async function untouchedAfter() { return 17; }"));
  assert.ok(!next.includes("writeRegister"));
  let reads = 0;
  const ctx = vm.createContext({
    require: () => pressure,
    cfg: { poziomWody: { wlaczony: true, rejestr: 3 } },
    sonda: {
      isOpen: true,
      readHoldingRegisters: async (from, count) => {
        assert.equal(from, 0);
        assert.equal(count, 4);
        reads++;
        return { data: [50, 0, 0, 40] };
      },
    },
  });
  vm.runInContext(next, ctx);
  const r = await vm.runInContext("odczytajPoziom()", ctx);
  assert.equal(r.poziomWodyMa, 4);
  assert.equal(r.cisnienieTloczenia.bar, 0);
  assert.equal(reads, 1);
});
test("Instalator odmawia zmiany nieznanego kodu", () => {
  assert.throws(() => patchPressure("inny kod"));
  assert.throws(() => patchPressure(fixture.replace("p.rejestr, 1", "99, 1")));
});
