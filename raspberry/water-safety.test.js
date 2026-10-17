const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const A = require("./water-safety-schema"),
  { WaterSafety } = require("./water-safety"),
  { PressureRuntime } = require("./pressure-control-runtime");
const cfg = () => ({ ...A.defaults(), wlaczony: true, ostrzegaj: true });
function setup(t, offline = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pompa-water-test-")),
    listeners = {};
  const state = {
    polaczony: true,
    pracuje: false,
    aktualizacja: Date.now(),
    sondaPolaczona: true,
    poziomWodyProc: 40,
    aktualizacjaPoziomu: Date.now(),
  };
  let stops = 0;
  const db = {
    ref: (name) => ({
      on: (_, cb) => {
        listeners[name] = cb;
      },
      update: () => (offline ? new Promise(() => {}) : Promise.resolve()),
      push: () => Promise.resolve(),
    }),
  };
  const o = {
    dir,
    base: "pompa",
    state: () => state,
    log() {},
    limit: { ustawCel() {} },
    stop: async () => {
      stops++;
    },
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, db, o, state, listeners, stops: () => stops };
}
test("Woda: walidacja progów, cm i własny znacznik świeżości sondy", () => {
  assert.equal(A.validate(cfg()), null);
  assert.ok(A.validate({ ...cfg(), stopCm: 0 }));
  assert.ok(A.validate({ ...cfg(), ostrzezenieCm: 29 }));
  assert.ok(A.validate({ ...cfg(), wlaczony: "true" }));
  assert.equal(A.level({ sondaPolaczona: true, poziomWodyProc: 20, aktualizacjaPoziomu: 1000 }, 1000), 50);
  assert.equal(
    A.level({ sondaPolaczona: true, poziomWodyProc: 20, aktualizacja: 6000, aktualizacjaPoziomu: 1000 }, 6000),
    null,
  );
});
test("Woda: opcjonalny STOP, ostrzeganie niezależne i histereza 5 cm", (t) => {
  const x = setup(t),
    w = new WaterSafety(x.db, x.o);
  w.configure({ ...cfg(), wlaczony: false });
  x.state.pracuje = true;
  x.state.poziomWodyProc = 20;
  w.check(x.state);
  assert.equal(w.warning, true);
  assert.equal(w.fault, "");
  x.state.poziomWodyProc = 22;
  w.check(x.state);
  assert.equal(w.warning, true);
  x.state.poziomWodyProc = 23;
  w.check(x.state);
  assert.equal(w.warning, false);
  x.state.poziomWodyProc = 0;
  w.check(x.state);
  assert.equal(w.stopNeeded, false);
  w.configure({ ...cfg(), wlaczony: false, ostrzegaj: false });
  assert.equal(w.warning, false);
});
test("Woda: STOP na granicy, trwała blokada i brak automatycznego wznowienia", (t) => {
  const x = setup(t),
    w = new WaterSafety(x.db, x.o);
  w.configure(cfg());
  x.state.pracuje = true;
  x.state.poziomWodyProc = 10;
  w.check(x.state);
  assert.ok(w.fault);
  assert.equal(w.stopNeeded, true);
  x.state.pracuje = false;
  x.state.poziomWodyProc = 80;
  w.check(x.state);
  assert.ok(w.validateStart(x.state));
  const restored = new WaterSafety(x.db, x.o);
  assert.ok(restored.fault);
  assert.equal(restored.cfg.wlaczony, true);
  restored.configure({ ...cfg(), resetId: "reset-123" });
  assert.equal(restored.fault, "");
  assert.equal(restored.validateStart(x.state), null);
});
test("Woda: brak pomiaru zatrzymuje; reset niemożliwy w ruchu, przy niskiej wodzie lub bez komunikacji", (t) => {
  const x = setup(t),
    w = new WaterSafety(x.db, x.o);
  w.configure(cfg());
  x.state.pracuje = true;
  x.state.aktualizacjaPoziomu = Date.now() - 5000;
  w.check(x.state);
  assert.match(w.fault, /odczytu/);
  w.configure({ ...cfg(), resetId: "reset-111" });
  assert.ok(w.fault);
  x.state.pracuje = false;
  x.state.aktualizacjaPoziomu = Date.now();
  x.state.poziomWodyProc = 12;
  w.configure({ ...cfg(), resetId: "reset-222" });
  assert.ok(w.fault);
  x.state.poziomWodyProc = 50;
  x.state.polaczony = false;
  w.configure({ ...cfg(), resetId: "reset-333" });
  assert.ok(w.fault);
});

test("Woda: ostatnia lokalna konfiguracja działa bez Firebase po restarcie", (t) => {
  const x = setup(t),
    first = new WaterSafety(x.db, x.o);
  first.configure(cfg());
  const next = new WaterSafety(x.db, x.o);
  x.state.pracuje = true;
  x.state.poziomWodyProc = 5;
  next.check(x.state);
  assert.equal(next.loaded, true);
  assert.ok(next.fault);
  assert.equal(next.stopNeeded, true);
  next.configure({ ...cfg(), wlaczony: false });
  assert.ok(next.fault);
});

test("Woda: utrata komunikacji falownika nie udaje postoju i nie znosi ochrony sondy", (t) => {
  const x = setup(t),
    w = new WaterSafety(x.db, x.o);
  w.configure(cfg());
  x.state.pracuje = true;
  w.check(x.state);
  x.state.pracuje = false;
  x.state.polaczony = false;
  x.state.aktualizacjaPoziomu = Date.now() - 6000;
  w.check(x.state);
  assert.ok(w.fault);
  assert.equal(w.stopNeeded, true);
});
test("Woda: watchdog lokalnie ponawia STOP i blokuje Start nawet bez chmury i bez automatu ciśnienia", async (t) => {
  const x = setup(t, true),
    r = new PressureRuntime(x.db, x.o);
  t.after(() => clearInterval(r.timer));
  x.listeners["pompa/ustawienia/regulatorCisnienia"]({ val: () => null });
  x.listeners["pompa/ustawienia/zabezpieczenieWody"]({ val: () => cfg() });
  x.state.pracuje = true;
  x.state.poziomWodyProc = 1;
  let attempts = 0;
  x.o.stop = async () => {
    if (++attempts === 1) throw Error("timeout");
  };
  r.watchdog();
  await r.tail;
  assert.equal(r.water.stopNeeded, true);
  r.watchdog();
  await r.tail;
  assert.equal(attempts, 2);
  assert.equal(r.water.stopNeeded, false);
  assert.throws(() => r.prepareCommand({ akcja: "start" }, x.state, {}), /wody/);
  assert.equal(r.prepareCommand({ akcja: "stop" }, x.state, {}).akcja, "stop");
});
