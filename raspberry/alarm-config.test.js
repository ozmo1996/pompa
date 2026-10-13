const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const A = require("./alarm-schema.js");

function service({ failCloses = 0 } = {}) {
  let time = 1000000,
    serial = 0;
  const records = {},
    listeners = {},
    closeAttempts = [];
  const ref = (name) => ({
    update: async (values) => {
      if (values.aktywny === false) {
        closeAttempts.push(name);
        if (failCloses-- > 0) throw new Error("Przejściowy błąd zapisu");
      }
      records[name] = { ...(records[name] || {}), ...values };
    },
    push: () => {
      const key = "alarm" + ++serial;
      return {
        key,
        set: async (value) => {
          records["pompa/alarmy/" + key] = value;
        },
      };
    },
    get: async () => ({ val: () => null, forEach: () => {} }),
    on: (_, cb) => {
      listeners[name] = cb;
    },
  });
  const admin = { initializeApp() {}, credential: { cert() {} }, database: () => ({ ref }) };
  const context = vm.createContext({
    module: { exports: {} },
    require: (name) =>
      name === "firebase-admin" ? admin : name === "path" ? path : name === "./alarm-schema" ? A : {},
    __dirname: __dirname,
    process: { env: {}, on() {} },
    Date: class extends Date {
      static now() {
        return time;
      }
    },
    console: { log() {} },
    setInterval() {},
    fetch() {},
    statusInput: null,
    configInput: null,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "alarmy.js"), "utf8"), context);
  return {
    records,
    closeAttempts,
    tick: (ms) => {
      time += ms;
    },
    configure: async (config) => {
      context.configInput = config;
      await vm.runInContext("applySettings(configInput)", context);
    },
    read: async (data) => {
      context.statusInput = {
        aktualizacja: time,
        polaczony: true,
        pracuje: false,
        sondaPolaczona: true,
        temperaturaWodyPolaczona: true,
        ...data,
      };
      vm.runInContext("status = statusInput; samples.push({t: now(), s: status}); evaluate()", context);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("Alarm: zamknięcie jest ponawiane po błędzie, także przy braku świeżych pomiarów", async () => {
  const s = service({ failCloses: 1 }),
    c = A.defaults();
  await s.configure(c);
  await s.read({ poziomWodyProc: 10, poziomWodyMa: 4, temperaturaWody: 8 });
  const name = Object.keys(s.records).find((k) => s.records[k].typ === "niskiPoziom");
  c.reguly.niskiPoziom.wlaczony = false;
  await s.configure(c);
  assert.equal(s.records[name].aktywny, true);
  assert.equal(s.closeAttempts.length, 1);
  s.tick(6000);
  await s.read({ aktualizacja: 1, poziomWodyProc: 80 });
  assert.equal(s.records[name].aktywny, false);
  assert.equal(s.closeAttempts.length, 2);
  await s.read({ poziomWodyProc: 80 });
  assert.equal(s.closeAttempts.length, 2);
});

test("Temperatura: ostrzeżenie działa poniżej progu awarii, gdy reguła awarii jest wyłączona", async () => {
  const s = service(),
    c = A.defaults();
  c.reguly.zamarzanie.wlaczony = false;
  await s.configure(c);
  await s.read({ temperaturaWody: 0.2, poziomWodyProc: 80, poziomWodyMa: 10 });
  assert.ok(Object.values(s.records).some((r) => r.typ === "zimnaWoda" && r.aktywny));
  assert.ok(!Object.values(s.records).some((r) => r.typ === "zamarzanie"));
});

test("Walidacja ustawień: poprawne domyślne, zakresy, relacje i nieznane pomiary", () => {
  const c = A.defaults();
  assert.equal(A.validate(c), "");
  c.progi.sondaMinMa = 21;
  assert.ok(A.validate(c));
  c.progi.sondaMinMa = 1;
  c.progi.tempAwaria = 2;
  assert.match(A.validate(c), /zamarzania/);
  c.progi.tempAwaria = 0.3;
  c.wlasne.rule_1 = {
    ...c.reguly.niskiPoziom,
    pomiar: "nieznany",
    operator: "gt",
    prog: 10,
    tylkoPraca: false,
    tytul: "Test",
  };
  assert.ok(A.validate(c));
});

test("Wyłączenie reguły zamyka trwający alarm, ważność zmienia się bez nowego incydentu", async () => {
  const s = service(),
    c = A.defaults();
  await s.configure(c);
  await s.read({ poziomWodyProc: 10, poziomWodyMa: 3.7, temperaturaWody: 8 });
  const [name, record] = Object.entries(s.records).find(([, r]) => r.typ === "niskiPoziom");
  assert.equal(record.poziom, "awaria");
  assert.ok(!Object.values(s.records).some((r) => r.typ === "sondaPoziomu"));
  c.reguly.niskiPoziom.poziom = "info";
  await s.configure(c);
  assert.equal(s.records[name].poziom, "info");
  c.reguly.niskiPoziom.wlaczony = false;
  await s.configure(c);
  assert.equal(s.records[name].aktywny, false);
  assert.equal(Object.values(s.records).filter((r) => r.typ === "niskiPoziom").length, 1);
});

test("Własny alert ND20: opóźnienie, niezależna świeżość i brak zerowania po utracie połączenia", async () => {
  const s = service(),
    c = A.defaults();
  c.wlasne.rule_1 = {
    ...c.reguly.przeciazenie,
    pomiar: "nd20.napiecieL1L2",
    operator: "lt",
    prog: 380,
    tylkoPraca: false,
    tytul: "Niskie napięcie",
    opoznienieS: 20,
    zakonczenieS: 0,
  };
  await s.configure(c);
  await s.read({ nd20: { polaczony: true, aktualizacja: 1000000, napiecieL1L2: 370 } });
  assert.ok(!Object.values(s.records).some((r) => r.typ === "wlasny_rule_1"));
  s.tick(21000);
  await s.read({ aktualizacja: 1, nd20: { polaczony: true, aktualizacja: 1021000, napiecieL1L2: 370 } });
  const [name, record] = Object.entries(s.records).find(([, r]) => r.typ === "wlasny_rule_1");
  assert.equal(record.poziom, "ostrzezenie");
  await s.read({ nd20: { polaczony: false, aktualizacja: 1021000, napiecieL1L2: 0 } });
  assert.equal(s.records[name].aktywny, false);
});

test("Własny alert: tylko w pracy oraz świeży czujnik, nie ostatnia zachowana wartość", async () => {
  const s = service(),
    c = A.defaults();
  c.wlasne.rule_1 = {
    ...c.reguly.zamarzanie,
    pomiar: "temperaturaWody",
    operator: "lt",
    prog: 2,
    tylkoPraca: true,
    tytul: "Zimna woda",
  };
  await s.configure(c);
  await s.read({ temperaturaWody: 1.5 });
  await s.read({ temperaturaWody: 1.5, pracuje: true, temperaturaWodyPolaczona: false });
  assert.ok(!Object.values(s.records).some((r) => r.typ === "wlasny_rule_1"));
  await s.read({ temperaturaWody: 1.5, pracuje: true });
  assert.ok(Object.values(s.records).some((r) => r.typ === "wlasny_rule_1"));
});
