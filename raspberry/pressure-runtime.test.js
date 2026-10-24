const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  vm = require("node:vm");
const { PressureRuntime } = require("./pressure-control-runtime"),
  A = require("./pressure-control-schema"),
  { patchControl } = require("./install-pressure-control");
function setup(t, { offline = false, failStop = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pompa-pressure-control-test-"));
  let listener,
    stops = 0;
  const pending = () => (offline ? new Promise(() => {}) : Promise.resolve());
  const db = {
    ref: (name) => ({
      on: (_, cb) => {
        if (name.endsWith("/zabezpieczenieWody")) cb({ val: () => null });
        else listener = cb;
      },
      update: pending,
      push: pending,
    }),
  };
  const state = { cisnienieTloczenia: { polaczony: true, bar: 20, napiecieV: 2.5, aktualizacja: Date.now() } };
  const limit = {
    cfg: { wlaczony: true, kw: 85, minHz: 0 },
    hzEff: 40,
    hzCel: 40,
    ustawCel(hz) {
      this.hzCel = hz;
      this.hzEff = hz;
    },
    krok() {
      return { hz: null };
    },
  };
  const options = {
    dir,
    base: "pompa",
    state: () => state,
    log() {},
    limit,
    stop: async () => {
      stops++;
      if (failStop-- > 0) throw new Error("timeout");
    },
  };
  const r = new PressureRuntime(db, options);
  t.after(() => {
    clearInterval(r.timer);
    assert.ok(dir.startsWith(path.join(os.tmpdir(), "pompa-pressure-control-test-")));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { r, dir, db, options, state, limit, stops: () => stops, configure: (c) => listener({ val: () => c }) };
}
const drive = () => ({ pracuje: true, awaria: false, moc: 60, czestotliwoscZadana: 40, czestotliwoscWyjsciowa: 40 });
test("Runtime: hamowanie operatora nie jest awarią i nie zwiększa Hz", async (t) => {
  const x = setup(t);
  x.configure({ ...A.defaults(), wlaczony: true });
  x.r.prepareCommand({ akcja: "stop" }, x.state, x.limit);
  assert.throws(() => x.r.prepareCommand({ akcja: "start" }, x.state, x.limit), /zatrzymywanie/);
  assert.equal((await x.r.control(drive(), x.state, x.limit)).hz, null);
  assert.equal(x.r.engine.fault, "");
  await x.r.control({ ...drive(), pracuje: false, czestotliwoscWyjsciowa: 0 }, x.state, x.limit);
  assert.equal(x.r.operatorStopping, false);
  assert.throws(() => x.r.prepareCommand({ akcja: "start", czas: 1 }, x.state, x.limit), /starsze od ostatniego STOP/);
});
test("Runtime: nie wysyła poleceń przy wyłączonym trybie", async (t) => {
  const x = setup(t);
  x.configure(A.defaults());
  assert.equal(x.r.prepareCommand({ akcja: "start", czestotliwosc: 42 }, {}, x.limit).czestotliwosc, 42);
  await x.r.control(drive(), x.state, x.limit);
  assert.equal(x.stops(), 0);
});
test("Runtime: start automatu od minimum, ręczne Hz odrzucone, Stop zawsze dostępny", (t) => {
  const x = setup(t);
  x.configure({ ...A.defaults(), wlaczony: true });
  const state = { ...x.state, polaczony: true, aktualizacja: Date.now(), awaria: false };
  x.limit.cfg.minHz = 0;
  assert.equal(x.r.prepareCommand({ akcja: "start", czestotliwosc: 50 }, state, x.limit).czestotliwosc, 0);
  assert.throws(() => x.r.prepareCommand({ akcja: "czestotliwosc" }, state, x.limit));
  assert.equal(x.r.prepareCommand({ akcja: "stop" }, {}, x.limit).akcja, "stop");
});
test("Runtime: limit kW obcina cel regulatora; nie ma drugiego nadpisującego polecenia", async (t) => {
  const x = setup(t);
  x.configure({ ...A.defaults(), wlaczony: true });
  x.r.engine.started(Date.now() - 2000);
  x.limit.krok = () => ({ hz: 39.5 });
  const result = await x.r.control(drive(), x.state, x.limit);
  assert.equal(result.hz, 39.5);
  assert.equal(x.stops(), 0);
});
test("Runtime: niedostępna chmura nie blokuje lokalnego STOP i trwałego zatrzasku", async (t) => {
  const x = setup(t, { offline: true });
  x.configure({ ...A.defaults(), wlaczony: true });
  x.r.engine.started(Date.now() - 2000);
  x.state.cisnienieTloczenia.aktualizacja = Date.now() - 4000;
  x.r.watchdog();
  await x.r.tail;
  assert.equal(x.stops(), 1);
  assert.ok(x.r.engine.fault);
  assert.ok(JSON.parse(fs.readFileSync(x.r.file, "utf8")).fault);
  const restored = new PressureRuntime(x.db, x.options);
  clearInterval(restored.timer);
  assert.ok(restored.engine.fault);
  assert.equal(restored.engine.armed, false);
});
test("Runtime: nieudany STOP jest ponawiany, bez auto-wznowienia", async (t) => {
  const x = setup(t, { failStop: 1 });
  x.configure({ ...A.defaults(), wlaczony: true });
  x.r.engine.started(Date.now() - 2000);
  x.state.cisnienieTloczenia.bar = 32;
  await assert.rejects(x.r.control(drive(), x.state, x.limit));
  assert.equal(x.r.stopNeeded, true);
  x.r.watchdog();
  await x.r.tail;
  assert.equal(x.stops(), 2);
  assert.equal(x.r.stopNeeded, false);
  assert.equal(x.r.engine.armed, false);
  await x.r.control({ ...drive(), pracuje: false }, x.state, x.limit);
  assert.equal(x.stops(), 2);
});
test("Runtime: wyłączenie pozostawia bieżące Hz, bez powrotu do starego celu", async (t) => {
  const x = setup(t);
  x.configure({ ...A.defaults(), wlaczony: true });
  x.r.engine.started(Date.now() - 2000);
  await x.r.control(drive(), x.state, x.limit);
  x.configure(A.defaults());
  await x.r.tail;
  await x.r.control({ ...drive(), czestotliwoscZadana: 38 }, x.state, x.limit);
  assert.equal(x.limit.hzCel, 38);
  assert.equal(x.stops(), 0);
});

test("Runtime: jawne świeże przejęcie pracującej pompy zachowuje 40 Hz i nie wysyła STOP", async (t) => {
  const x = setup(t);
  Object.assign(x.state, drive(), { polaczony: true, aktualizacja: Date.now() });
  x.configure({ ...A.defaults(), id: "manual-first" });
  await x.r.control(drive(), x.state, x.limit);
  x.limit.hzCel = 48;
  x.configure({ ...A.defaults(), id: "handoff-new", wlaczony: true, zmieniono: Date.now() });
  await x.r.tail;
  assert.equal(x.r.engine.fault, "");
  assert.equal(x.r.engine.armed, true);
  assert.equal(x.limit.hzCel, 40);
  assert.equal(x.limit.hzEff, 40);
  assert.equal((await x.r.control(drive(), x.state, x.limit)).hz, null);
  assert.equal(x.stops(), 0);
});

test("Runtime: stare przełączenie, brak pomiaru i przejęcie po restarcie nie uzbrajają automatu", async (t) => {
  for (const variant of ["old", "sensor", "restart", "stopping"]) {
    const x = setup(t);
    Object.assign(x.state, drive(), { polaczony: true, aktualizacja: Date.now() });
    if (variant !== "restart") x.configure({ ...A.defaults(), id: "manual-first" });
    await x.r.control(drive(), x.state, x.limit);
    if (variant === "sensor") x.state.cisnienieTloczenia.aktualizacja = Date.now() - 4000;
    if (variant === "stopping") x.r.operatorStopping = true;
    x.configure({
      ...A.defaults(),
      id: "handoff-new",
      wlaczony: true,
      zmieniono: Date.now() - (variant === "old" ? 20000 : 0),
    });
    await x.r.tail;
    assert.equal(x.r.engine.armed, false, variant);
    assert.ok(x.r.engine.fault, variant);
  }
});
test("Runtime: transakcje falownika są wykonywane kolejno, nie równolegle", async (t) => {
  const x = setup(t);
  let inFlight = 0,
    max = 0;
  await Promise.all(
    [1, 2, 3].map(() =>
      x.r.serial(async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
      }),
    ),
  );
  assert.equal(max, 1);
});
const fixture = `const sonda = new ModbusRTU();
async function wykonajPolecenie(p) {
 if(p.id===ostatniIdPolecenia)return;
 ostatniIdPolecenia=p.id;
 await falownik.writeRegister(REJ.sterowanie, STEROWANIE_START);
 await refPolecenie.update({wykonane:true, wykonaneCzas:Date.now()});
 await zapiszZdarzenie('start', 'ok');
}
async function petla() {
 try {
 const dane = await odczytajFalownik();
 const korekta = limitMocy.krok({ moc: dane.moc, pracuje: dane.pracuje });
 if(korekta.hz!==null)await falownik.writeRegister(REJ.czestotliwoscZadana,korekta.hz*100);
 } catch(e) { bledyPodRzad++; }
 await zapisStatusu.zapisz(stan);
 setTimeout(petla, cfg.falownik.interwalOdpytywaniaMs);
}
async function petlaPoziomu() {
 const dane = await odczytajPoziom();
 await zapiszZdarzenie('woda','ok');
 await zapisStatusu.zapisz(stan);
 setTimeout(petlaPoziomu, cfg.poziomWody.interwalOdpytywaniaMs);
}
async function petlaTemperatury() { return 'bez zmian'; }`;
test("Instalator: wspólny mutex, 1 s, brak await Firebase wewnątrz sterowania i brak zmiany temperatury", () => {
  const next = patchControl(fixture);
  new vm.Script(next);
  assert.equal(patchControl(next), next);
  assert.ok(next.includes("setTimeout(petlaPoziomu, 1000)"));
  assert.ok(next.includes("setTimeout(petla, 1000)"));
  assert.ok(next.includes("await pressureRuntime.control(dane, stan, limitMocy)"));
  for (const old of ["await refPolecenie.update", "await zapisStatusu.zapisz", "await zapiszZdarzenie"])
    assert.ok(!next.includes(old));
  assert.ok(next.includes("p.id === ostatniIdPolecenia) return"));
  assert.ok(next.endsWith("async function petlaTemperatury() { return 'bez zmian'; }"));
  assert.throws(() => patchControl("nieznany serwis"));
});
