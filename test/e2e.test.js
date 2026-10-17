// Scenariusze w prawdziwej przeglądarce (Chromium) z atrapą Firebase — m.in. zachowanie przy awariach połączenia.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { seedData } from "./support/seed.js";

// przechwytywanie żądań service workera (importScripts Firebase) przez page/context.route
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOCK = fs.readFileSync(path.join(ROOT, "test/support/firebase-mock.js"), "utf8");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};
let server, base, browser;

before(async () => {
  server = http
    .createServer((req, res) => {
      let p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
      if (!p.startsWith(ROOT)) return res.writeHead(403).end();
      if (p.endsWith(path.sep)) p += "index.html";
      fs.readFile(p, (err, body) => {
        if (err) return res.writeHead(404).end();
        res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream" }).end(body);
      });
    })
    .listen(0);
  base = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** Otwiera aplikację z podanym stanem bazy. clockSkew — o ile zegar telefonu różni się od rzeczywistego. */
async function open({ data, seed = {}, clockSkew = 0, sdkFails = false, clock = false } = {}) {
  const ctx = await browser.newContext({ locale: "pl-PL", timezoneId: "Europe/Warsaw", serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (clockSkew || clock) await page.clock.install({ time: Date.now() + clockSkew });
  await page.route(/gstatic\.com\/firebasejs/, (r) =>
    sdkFails ? r.abort() : r.fulfill({ contentType: "text/javascript", body: MOCK }),
  );
  await page.addInitScript((s) => (globalThis.__FB_SEED = s), { data: data ?? seedData(Date.now()), ...seed });
  await page.goto(base);
  return { page, ctx, errors };
}
const writes = (page, p) => page.evaluate((p) => globalThis.__fb.writes.filter((w) => w.path === p), p);

test("Sterowanie: obsługa pompy przed ustawieniami, zwinięte formularze i poprawny układ telefonu", async () => {
  const { page, ctx, errors } = await open();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#controlTab");
  const positions = await page.evaluate(() => {
    const y = (id) => document.getElementById(id).getBoundingClientRect().top;
    return {
      pump: y("pumpControlCard"),
      power: y("powerLimitCard"),
      water: y("waterSafetyCard"),
      pressure: y("pressureControlCard"),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      ids: [...document.querySelectorAll("[id]")].map((x) => x.id),
    };
  });
  for (const key of ["power", "water", "pressure"]) assert.ok(positions.pump < positions[key]);
  assert.equal(positions.overflow, false);
  assert.equal(new Set(positions.ids).size, positions.ids.length);
  assert.equal(await page.isVisible("#startPump"), true);
  assert.equal(await page.isVisible("#stopPump"), true);
  const stopBox = await page.locator("#stopPump").boundingBox();
  assert.ok(stopBox.y + stopBox.height <= 844, "STOP mieści się na pierwszym ekranie telefonu");
  assert.equal(await page.isVisible("#waterStopCm"), false);
  assert.equal(await page.isVisible("#pressureSetBar"), false);
  assert.equal(await page.isVisible("#limitKw"), false);
  if (process.env.POMPA_LAYOUT_CAPTURE) {
    await page.screenshot({ path: process.env.POMPA_LAYOUT_CAPTURE });
  }
  await page.click("#powerLimitSettings > summary");
  assert.equal(await page.isVisible("#limitKw"), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Zabezpieczenie wody: niezależne opcje, walidacja, cm/% i zapis bez rozruchu", async () => {
  const { page, ctx, errors } = await open();
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#controlTab");
  assert.equal(await page.isChecked("#waterStopOn"), false);
  await page.click("#waterSettings > summary");
  await page.check("#waterStopOn");
  await page.check("#waterWarnOn");
  await page.fill("#waterStopCm", "40");
  await page.fill("#waterWarnCm", "42");
  await page.click("#saveWaterSafety");
  assert.match(await page.textContent("#waterSafetyMessage"), /co najmniej 5 cm/);
  await page.fill("#waterWarnCm", "60");
  page.once("dialog", (d) => d.accept());
  await page.click("#saveWaterSafety");
  await page.waitForFunction(() => globalThis.__fb.store.pompa.ustawienia.zabezpieczenieWody?.stopCm === 40);
  assert.match(await page.textContent("#waterSafetyPercents"), /16.*24/);
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Zabezpieczenie wody: ostrzeżenie i trwała blokada widoczne w całej aplikacji", async () => {
  const data = seedData(Date.now()),
    t = Date.now();
  data.pompa.ustawienia.zabezpieczenieWody = {
    wersja: 1,
    id: "water-test",
    wlaczony: true,
    stopCm: 25,
    ostrzegaj: true,
    ostrzezenieCm: 50,
    resetId: "domyslne",
    zmieniono: t,
    zmienil: "test",
  };
  data.pompa.status.aktualizacjaPoziomu = t;
  data.pompa.status.poziomWodyProc = 18;
  data.pompa.statusZabezpieczeniaWody = {
    wersja: 1,
    ustawieniaId: "water-test",
    aktualizacja: t,
    wlaczony: true,
    ostrzegaj: true,
    ostrzezenie: true,
    awaria: "",
    poziomCm: 45,
    stopCm: 25,
    ostrzezenieCm: 50,
  };
  const { page, ctx, errors } = await open({ data });
  await page.waitForSelector("#dashboard:not([hidden])");
  assert.equal(await page.isVisible("#waterSafetyBanner"), true);
  assert.match(await page.textContent("#waterSafetyBanner"), /45/);
  await page.evaluate(() => globalThis.__fb.set("pompa/statusZabezpieczeniaWody/awaria", "Niski poziom wody"));
  await page.click("#controlTab");
  assert.equal(await page.isDisabled("#startPump"), true);
  assert.equal(await page.isDisabled("#stopPump"), false);
  assert.match(await page.textContent("#waterSafetyState"), /BLOKADA/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Regulator ciśnienia: opcjonalny, zapis nie uruchamia pompy, blokada Hz i start od minimum", async () => {
  const data = seedData(Date.now()),
    t = Date.now();
  const cfg = {
    wersja: 1,
    id: "test-pressure-init",
    wlaczony: false,
    bar: 25,
    minHz: 35,
    maxHz: 50,
    maxBar: 32,
    zmieniono: t,
    zmienil: "test",
  };
  data.pompa.ustawienia.regulatorCisnienia = cfg;
  data.pompa.status.pracuje = false;
  data.pompa.status.cisnienieTloczenia = { bar: 20, napiecieV: 2.5, polaczony: true, aktualizacja: t };
  data.pompa.statusRegulatoraCisnienia = {
    wersja: 1,
    aktualizacja: t,
    ustawieniaId: cfg.id,
    wlaczony: false,
    stan: "wyłączony",
    awaria: "",
  };
  const { page, ctx, errors } = await open({ data });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#controlTab");
  assert.equal(await page.isChecked("#pressureAutoOn"), false);
  await page.click("#pressureSettings > summary");
  await page.check("#pressureAutoOn");
  page.once("dialog", (dialog) => dialog.accept());
  await page.click("#savePressureControl");
  await page.waitForFunction(() => document.getElementById("pressureControlMessage").textContent.includes("Zapisano"));
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  assert.equal(await page.isEnabled("#setFrequency"), false);
  assert.equal(await page.isEnabled("#startPump"), false);
  await page.evaluate(() => {
    const c = globalThis.__fb.read("pompa/ustawienia/regulatorCisnienia");
    globalThis.__fb.set("pompa/statusRegulatoraCisnienia", {
      wersja: 1,
      aktualizacja: Date.now(),
      ustawieniaId: c.id,
      wlaczony: true,
      stan: "gotowy",
      awaria: "",
    });
    globalThis.__fb.set("pompa/status/cisnienieTloczenia/aktualizacja", Date.now());
    globalThis.__fb.set("pompa/status/aktualizacja", Date.now());
  });
  await page.waitForFunction(() => !document.getElementById("startPump").disabled);
  if (process.env.POMPA_CONTROL_CAPTURE)
    await page.locator("#pressureControlCard").screenshot({ path: process.env.POMPA_CONTROL_CAPTURE });
  await page.click("#startPump");
  await page.click("#dlgOk");
  await page.waitForFunction(() => globalThis.__fb.writes.some((w) => w.path === "pompa/polecenie"));
  const command = (await writes(page, "pompa/polecenie")).at(-1).value;
  assert.equal(command.czestotliwosc, 35);
  await page.evaluate(() => {
    const c = globalThis.__fb.read("pompa/polecenie");
    globalThis.__fb.set("pompa/polecenie", { ...c, wykonane: true });
    globalThis.__fb.set("pompa/status/cisnienieTloczenia/aktualizacja", Date.now() - 4000);
  });
  await page.waitForFunction(() => document.getElementById("startPump").disabled);
  assert.equal(await page.isEnabled("#stopPump"), true);
  await page.evaluate(() => globalThis.__fb.set("pompa/statusRegulatoraCisnienia/awaria", "Utrata czujnika"));
  assert.equal(await page.isEnabled("#startPump"), false);
  assert.equal(await page.isEnabled("#stopPump"), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Regulator ciśnienia: nie pozwala włączyć nowego trybu podczas pracy ani zapisać progu ponad 32 bar", async () => {
  const data = seedData(Date.now()),
    t = Date.now();
  data.pompa.statusRegulatoraCisnienia = {
    wersja: 1,
    aktualizacja: t,
    ustawieniaId: "domyslne",
    wlaczony: false,
    stan: "wyłączony",
    awaria: "",
  };
  const { page, ctx, errors } = await open({ data });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#controlTab");
  await page.click("#pressureSettings > summary");
  await page.fill("#pressureStopBar", "35");
  await page.click("#savePressureControl");
  assert.match(await page.textContent("#pressureControlMessage"), /32 bar/);
  await page.fill("#pressureStopBar", "32");
  await page.check("#pressureAutoOn");
  await page.click("#savePressureControl");
  assert.match(await page.textContent("#pressureControlMessage"), /zatrzymanej/);
  assert.equal((await writes(page, "pompa/ustawienia/regulatorCisnienia")).length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Ciśnienie na tłoczeniu: pomiar, błędny sygnał, rozłączenie i ręczny wybór do tabeli", async () => {
  const { page, ctx, errors } = await open();
  await page.waitForSelector("#dashboard:not([hidden])");
  assert.equal(await page.textContent("#dischargePressure"), "—");
  await page.evaluate(() =>
    globalThis.__fb.set("pompa/status/cisnienieTloczenia", {
      bar: 32,
      napiecieV: 3.7,
      polaczony: true,
      aktualizacja: Date.now(),
    }),
  );
  await page.waitForFunction(() => document.getElementById("dischargePressure").textContent === "32");
  assert.equal(await page.textContent("#dischargeVoltage"), "3,7 V");
  assert.equal(await page.textContent("#valvePressure"), "32 bar");
  await page.check("#manualPressureOverride");
  await page.fill("#manualWaterPressure", "28");
  await page.locator("#waterPressureForm button[type=submit]").click();
  assert.equal(await page.textContent("#valvePressure"), "28 bar");
  assert.equal(await page.textContent("#dischargePressure"), "32");
  await page.uncheck("#manualPressureOverride");
  assert.equal(await page.textContent("#valvePressure"), "32 bar");
  if (process.env.POMPA_PRESSURE_CAPTURE)
    await page
      .locator("#dischargePressure")
      .locator("xpath=ancestor::article")
      .screenshot({ path: process.env.POMPA_PRESSURE_CAPTURE });
  await page.evaluate(() =>
    globalThis.__fb.set("pompa/status/cisnienieTloczenia", {
      bar: null,
      napiecieV: 0,
      polaczony: true,
      aktualizacja: Date.now(),
      blad: "Sygnał poza zakresem 0,5–4,5 V",
    }),
  );
  await page.waitForFunction(() => document.getElementById("dischargePressure").textContent === "—");
  assert.match(await page.textContent("#dischargePressureState"), /poza zakresem/);
  assert.equal(await page.textContent("#dischargeVoltage"), "0 V");
  await page.evaluate(() =>
    globalThis.__fb.set("pompa/status/cisnienieTloczenia", {
      bar: 32,
      napiecieV: 3.7,
      polaczony: false,
      aktualizacja: Date.now(),
    }),
  );
  await page.waitForFunction(() => document.getElementById("dischargeVoltage").textContent === "— V");
  assert.equal(await page.textContent("#dischargePressure"), "—");
  await page.evaluate(() =>
    globalThis.__fb.set("pompa/status/cisnienieTloczenia", {
      bar: 32,
      napiecieV: 3.7,
      polaczony: true,
      aktualizacja: Date.now() - 60000,
    }),
  );
  assert.equal(await page.textContent("#dischargePressure"), "—");
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("600 ECO: ciśnienie ręczne, czujnik, wygaśnięcie i nieaktualna pogoda", async () => {
  const { page, ctx, errors } = await open({ clock: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.evaluate(() =>
    globalThis.__fb.set("pompa/status/pogoda", {
      stacja: "IBYSTR6",
      pobrano: Date.now(),
      temperatura: -5,
      wilgotnosc: 100,
      cisnienie: 1013.25,
    }),
  );
  await page.fill("#manualWaterPressure", "31,0");
  await page.locator("#waterPressureForm button[type=submit]").click();
  assert.equal(await page.textContent("#valveResult"), "Otwórz: 1 + 3");
  assert.match(await page.textContent("#valveBasis"), /−?\-?5 °C \/ 32 bar/);
  assert.match(await page.textContent("#wetBulbMethod"), /800 m/);
  assert.equal(await page.locator("#valve2").textContent(), "Zawór 2: zamknięty");
  await page.click("#showValveTable");
  assert.equal(await page.isVisible("#valveTableDlg"), true);
  assert.equal(await page.locator("#valveTableBody tr").count(), 17);
  assert.equal(await page.locator("#valveTableBody td").count(), 272);
  assert.equal(await page.locator("#valveTableHead th").count(), 17);
  assert.equal(await page.locator("#fullValveTable .selected-cell").textContent(), "1+3");
  assert.equal(await page.locator("#fullValveTable .selected-cell").getAttribute("data-pressure"), "32");
  assert.ok(await page.locator(".valve-table-scroll").evaluate((node) => node.scrollWidth > node.clientWidth));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (process.env.POMPA_TABLE_CAPTURE)
    await page.locator("#valveTableDlg").screenshot({ path: process.env.POMPA_TABLE_CAPTURE });
  await page.keyboard.press("Escape");
  assert.equal(await page.isVisible("#valveTableDlg"), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), "showValveTable");
  if (process.env.POMPA_VALVE_CAPTURE)
    await page.locator(".valve-card").screenshot({ path: process.env.POMPA_VALVE_CAPTURE });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.evaluate(() =>
    globalThis.__fb.set("pompa/status/cisnienieTloczenia", { bar: 40, polaczony: true, aktualizacja: Date.now() }),
  );
  await page.waitForFunction(() => document.getElementById("valvePressure").textContent === "40 bar");
  assert.equal(await page.isVisible("#waterPressureForm"), false);
  assert.equal(await page.textContent("#valveResult"), "Otwórz: 3");
  await page.evaluate(() => globalThis.__fb.set("pompa/status/cisnienieTloczenia/bar", 45));
  await page.waitForFunction(() => document.getElementById("valveResult").textContent === "Brak wskazówki");
  await page.clock.fastForward(16 * 60000);
  await page.evaluate(() => globalThis.__fb.set("pompa/status/pogoda/pobrano", Date.now()));
  await page.waitForFunction(() => document.getElementById("valvePressureSource").textContent.includes("wygasł"));
  assert.equal(await page.textContent("#valveResult"), "Brak wskazówki");
  await page.fill("#manualWaterPressure", "32");
  await page.locator("#waterPressureForm button[type=submit]").click();
  await page.evaluate(() => globalThis.__fb.set("pompa/status/pogoda/pobrano", Date.now() - 13 * 60000));
  await page.waitForFunction(() => document.getElementById("valveBasis").textContent.includes("aktualne dane"));
  assert.equal(await page.textContent("#valveResult"), "Brak wskazówki");
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  await page.click("#showValveTable");
  assert.equal(await page.locator("#fullValveTable .selected-cell").count(), 0);
  await page.click("#closeValveTable");
  assert.equal(await page.isVisible("#valveTableDlg"), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Mokry termometr: kolor korzysta z ustawionego progu i włączenia reguły", async () => {
  const { page, ctx, errors } = await open();
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#alarmsTab");
  await page.click("#alarmSettingsPanel > summary");
  await page.fill("#alarmRuleSearch", "ciepło");
  await page.locator('#rule-zaCieplo input[data-setting="mokryMaxC"]').fill("-10");
  await page.click("#saveAlarmSettings");
  await page.waitForFunction(() => document.getElementById("weatherWet").classList.contains("warm"));
  await page.locator("#rule-zaCieplo input[type=checkbox]").first().uncheck();
  await page.click("#saveAlarmSettings");
  await page.waitForFunction(() => !document.getElementById("weatherWet").classList.contains("warm"));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("pracująca pompa: wszystkie zakładki działają bez błędów", async () => {
  const { page, ctx, errors } = await open();
  await page.waitForSelector("#dashboard:not([hidden])");
  assert.match(await page.textContent("#connectionText"), /Dane aktualne/);
  assert.equal(await page.textContent("#sensorDriveState"), "Pompa pracuje");
  for (const tab of ["control", "stats", "notes", "alarms", "overview"]) {
    await page.click(`#${tab}Tab`);
    assert.equal(await page.isVisible(`#${tab}View`), true);
  }
  assert.equal(await page.isVisible("#alarmBanner"), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("ND20: brak miernika i świeży odczyt są wyraźnie rozróżnione", async () => {
  const data = seedData(Date.now());
  const { page, ctx } = await open({ data });
  await page.waitForSelector("#dashboard:not([hidden])");
  assert.match(await page.textContent("#nd20State"), /Oczekiwanie na podłączenie/);
  assert.equal(await page.textContent("#nd20Power"), "— kW");
  await page.evaluate(() =>
    globalThis.__fb.set("pompa/status/nd20", {
      polaczony: true,
      aktualizacja: Date.now(),
      mocKw: 74.25,
      czestotliwoscHz: 50,
      napiecieL1L2: 400,
      pradL1: 125,
    }),
  );
  await page.waitForFunction(() => document.getElementById("nd20Power").textContent.includes("74,3"));
  assert.equal(await page.textContent("#nd20Hz"), "50 Hz");
  await page.evaluate(() =>
    globalThis.__fb.set("pompa/historia/agregat-test", {
      czas: Date.now() - 60000,
      typ: "agregat",
      nd20: { mocKw: 70 },
    }),
  );
  await page.click('[data-param="nd20Power"]');
  await page.waitForFunction(() => document.getElementById("pcNote").textContent.includes("agregat: zapis"));
  assert.equal(await page.textContent("#pcTitle"), "Moc czynna agregatu");
  assert.match(await page.textContent("#pcMin"), /70/);
  await ctx.close();
});

test("Ustawienia alarmów: progi, ważność i własny alert zapisują się; edycja nie jest nadpisywana statusem", async () => {
  const { page, ctx, errors } = await open();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#alarmsTab");
  await page.click("#alarmSettingsPanel > summary");
  await page.locator(".alarm-setting-group > summary").filter({ hasText: "Woda" }).click();
  await page.locator('#rule-niskiPoziom input[type="checkbox"]').first().uncheck();
  await page.locator("#rule-niskiPoziom select").selectOption("info");
  await page.fill('[data-setting="poziomNiski"]', "15");
  await page.click("#addCustomAlarm");
  const custom = page.locator("#customAlarmList .alarm-rule");
  await custom.getByLabel("Nazwa alertu", { exact: true }).fill("Niskie napięcie agregatu");
  await custom.getByLabel("Pomiar", { exact: true }).selectOption("nd20.napiecieL1L2");
  await custom.getByLabel("Próg (V)", { exact: true }).fill("380");
  await page.evaluate(() => globalThis.__fb.set("pompa/status/temperaturaWody", 9));
  assert.equal(await page.inputValue('[data-setting="poziomNiski"]'), "15");
  await page.click("#saveAlarmSettings");
  await page.waitForFunction(() =>
    document.getElementById("alarmSettingsMessage").textContent.includes("Ustawienia zapisane"),
  );
  const saved = await page.evaluate(() => globalThis.__fb.store.pompa.ustawienia.alarmy);
  assert.equal(saved.reguly.niskiPoziom.wlaczony, false);
  assert.equal(saved.reguly.niskiPoziom.poziom, "info");
  assert.equal(saved.progi.poziomNiski, 15);
  assert.equal(Object.values(saved.wlasne)[0].prog, 380);
  assert.equal(Object.values(saved.wlasne)[0].pomiar, "nd20.napiecieL1L2");
  await page.evaluate(() => {
    globalThis.__fb.set("pompa/status/poziomWodyProc", 10);
    globalThis.__fb.set("pompa/status/alarmPoziomu", true);
  });
  assert.ok(!(await page.textContent("#dataMessage")).includes("Niski poziom"));
  await page.evaluate(
    (id) => globalThis.__fb.set("pompa/statusAlarmow", { wersja: "2.19", aktualizacja: Date.now(), ustawieniaId: id }),
    saved.id,
  );
  await page.waitForFunction(() =>
    document.getElementById("alarmBackendState").textContent.includes("Raspberry stosuje"),
  );
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (process.env.POMPA_UI_CAPTURE) {
    await page.locator("#alarmSettingsPanel").evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: process.env.POMPA_UI_CAPTURE });
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Ustawienia alarmów: błędne progi i konflikt drugiego urządzenia nie nadpisują zapisanych ustawień", async () => {
  const { page, ctx } = await open();
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#alarmsTab");
  await page.click("#alarmSettingsPanel > summary");
  await page.locator(".alarm-setting-group > summary").filter({ hasText: "Woda" }).click();
  await page.fill('[data-setting="poziomNiski"]', "99");
  await page.click("#saveAlarmSettings");
  assert.match(await page.textContent("#alarmSettingsMessage"), /Niski poziom/);
  assert.equal((await writes(page, "pompa/ustawienia/alarmy")).length, 0);
  await page.fill('[data-setting="poziomNiski"]', "15");
  await page.evaluate(async () => {
    const A = globalThis.POMPA_ALARM_SCHEMA;
    globalThis.__fb.set("pompa/ustawienia/alarmy", { ...A.defaults(), id: "other-device" });
  });
  await page.click("#saveAlarmSettings");
  await page.waitForFunction(() =>
    document.getElementById("alarmSettingsMessage").textContent.includes("innym urządzeniu"),
  );
  assert.equal((await writes(page, "pompa/ustawienia/alarmy")).length, 0);
  await ctx.close();
});

test("Sondy: odłączone i nieaktualne czujniki nie pokazują ostatnich wartości jako bieżących", async () => {
  const { page, ctx } = await open();
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.evaluate(() => {
    globalThis.__fb.set("pompa/status/sondaPolaczona", false);
    globalThis.__fb.set("pompa/status/temperaturaWodyPolaczona", false);
  });
  await page.waitForFunction(() => document.getElementById("water").textContent === "—");
  assert.match(await page.textContent("#waterState"), /niepołączona/);
  assert.equal(await page.textContent("#waterTemp"), "— °C");
  assert.match(await page.textContent("#tankCaption"), /Brak odczytu/);
  assert.equal(await page.getAttribute("#waterBar", "aria-valuenow"), null);
  await page.click("#waterTempBox");
  await page.waitForSelector("#paramDlg[open]");
  assert.equal(await page.textContent("#pcNow"), "— °C");
  await page.click("#pcClose");
  await page.evaluate(() => {
    globalThis.__fb.set("pompa/status/sondaPolaczona", true);
    globalThis.__fb.set("pompa/status/temperaturaWodyPolaczona", true);
    globalThis.__fb.set("pompa/status/aktualizacja", Date.now() - 60000);
  });
  await page.waitForFunction(() => document.getElementById("waterState").textContent.includes("Brak aktualnego"));
  assert.equal(await page.textContent("#waterTemp"), "— °C");
  await ctx.close();
});

test("Statystyki: automatycznie dociągają nową próbkę i mają osobne wykresy z jednostkami", async () => {
  const { page, ctx, errors } = await open({ clock: true });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#statsTab");
  await page.waitForFunction(() => document.getElementById("sampleCount").textContent !== "0 próbek");
  const count = parseInt(await page.textContent("#sampleCount"));
  await page.evaluate(() =>
    globalThis.__fb.set("pompa/historia/new-water", { czas: Date.now() + 1000, typ: "woda", poziom: 40 }),
  );
  await page.clock.fastForward(61000);
  await page.waitForFunction((n) => parseInt(document.getElementById("sampleCount").textContent) === n + 1, count);
  assert.equal(await page.isVisible("#pumpChart"), true);
  assert.equal(await page.isVisible("#pumpHzChart"), true);
  assert.equal(await page.isVisible("#pumpCurrentChart"), true);
  assert.match(await page.getAttribute("#pumpChart", "aria-label"), /kW/);
  assert.match(await page.textContent("#statsRefreshState"), /ostatnio/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Statystyki ciśnienia: wykres, bar i podsumowanie historii pracy", async () => {
  const data = seedData(Date.now()),
    t = Date.now();
  data.pompa.historia.pressure1 = {
    czas: t - 20000,
    typ: "cisnienie",
    pracuje: true,
    cisnienieBar: 20,
    sesjaCisnienia: 1,
  };
  data.pompa.historia.pressure2 = {
    czas: t - 10000,
    typ: "cisnienie",
    pracuje: true,
    cisnienieBar: 24,
    sesjaCisnienia: 1,
  };
  const { page, ctx, errors } = await open({ data });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#statsTab");
  await page.waitForFunction(() => document.getElementById("pressureSummary").textContent.includes("2 próbek"));
  assert.equal(await page.isVisible("#pressureChart"), true);
  assert.match(await page.textContent("#pressureSummary"), /20.*22.*24/);
  assert.match(await page.textContent("#historyRows"), /24.*bar/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Alarmy na telefonie: wyszukiwanie i zapis dostępny podczas przewijania, grupa pozostaje otwarta", async () => {
  const { page, ctx, errors } = await open();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#alarmsTab");
  await page.click("#alarmSettingsPanel > summary");
  await page.fill("#alarmRuleSearch", "temperatura");
  assert.equal(await page.isVisible("#rule-zimnaWoda"), true);
  assert.equal(await page.isVisible("#rule-przelew"), false);
  await page.locator("#rule-zimnaWoda select").selectOption("info");
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => {
    const r = document.querySelector(".alarm-settings-actions").getBoundingClientRect();
    return r.y >= 0 && r.bottom <= window.innerHeight + 2;
  });
  const bar = await page.locator(".alarm-settings-actions").boundingBox();
  assert.ok(bar.y >= 0 && bar.y + bar.height <= 846);
  await page.click("#saveAlarmSettings");
  await page.waitForFunction(() =>
    document.getElementById("alarmSettingsMessage").textContent.includes("Ustawienia zapisane"),
  );
  assert.equal(await page.isVisible("#rule-zimnaWoda"), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (process.env.POMPA_UI_CAPTURE) await page.screenshot({ path: process.env.POMPA_UI_CAPTURE });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("notatka z terminem zapisuje się w bazie i można ją oznaczyć jako wykonaną; poziom pokazuje cm", async () => {
  const { page, ctx, errors } = await open();
  await page.waitForSelector("#dashboard:not([hidden])");
  assert.equal(await page.textContent("#waterCm"), "160,5 cm");
  await page.click("#notesTab");
  await page.fill("#noteTitle", "Przestawić armatkę nr 2");
  await page.fill("#noteBody", "Po 3 godzinach sprawdzić kierunek wiatru.");
  await page.fill("#noteHours", "3");
  await page.click("#noteSave");
  await page.waitForSelector("#noteOpenList .note-item");
  const created = await page.evaluate(() => Object.entries(globalThis.__fb.store.pompa.notatki)[0]);
  assert.equal(created[1].tytul, "Przestawić armatkę nr 2");
  assert.ok(created[1].termin - created[1].utworzono > 2.9 * 3600e3);
  await page.getByRole("button", { name: "Wykonane" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#noteDoneList .note-item").length === 1);
  assert.equal(await page.evaluate(([id]) => globalThis.__fb.store.pompa.notatki[id].wykonane, created), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("zmiana częstotliwości: ostrzeżenie, potwierdzenie, polecenie z terminem ważności i odpowiedź Raspberry", async () => {
  const { page, ctx } = await open();
  await page.click("#controlTab");
  await page.fill("#controlHz", "49");
  await page.click("#setFrequency");
  await page.waitForSelector("#confirmDlg[open]");
  assert.match(await page.textContent("#dlgList"), /Duża zmiana/);
  await page.click("#dlgOk");
  await page.waitForFunction(() => globalThis.__fb.writes.some((w) => w.path === "pompa/polecenie"));
  const [w] = await writes(page, "pompa/polecenie");
  assert.equal(w.value.akcja, "czestotliwosc");
  assert.equal(w.value.czestotliwosc, 49);
  assert.equal(w.value.wazneDo - w.value.czas, 20000);
  assert.equal(await page.isDisabled("#setFrequency"), true); // czeka na potwierdzenie
  await page.evaluate(() => globalThis.__fb.set("pompa/polecenie/wykonane", true));
  await page.waitForFunction(() => /wykonane/.test(document.getElementById("commandMessage").textContent));
  assert.equal(await page.isDisabled("#setFrequency"), false);
  await ctx.close();
});

test("anulowanie w oknie potwierdzenia nie wysyła polecenia", async () => {
  const { page, ctx } = await open();
  await page.click("#controlTab");
  await page.fill("#controlHz", "30");
  await page.click("#setFrequency");
  await page.click("#dlgCancel");
  await page.waitForFunction(() => /Anulowano/.test(document.getElementById("commandMessage").textContent));
  assert.deepEqual(await writes(page, "pompa/polecenie"), []);
  await ctx.close();
});

test("nieaktualne dane z Raspberry: Start zablokowany, Stop nadal działa", async () => {
  const { page, ctx } = await open({ data: seedData(Date.now(), { fresh: false }) });
  await page.click("#controlTab");
  await page.waitForFunction(() => /nieaktualne/.test(document.getElementById("connectionText").textContent));
  assert.equal(await page.isDisabled("#startPump"), true);
  assert.equal(await page.isDisabled("#setFrequency"), true);
  assert.equal(await page.isDisabled("#stopPump"), false);
  assert.equal(await page.isVisible("#stopNote"), true);
  await page.click("#stopPump");
  await page.waitForFunction(() => globalThis.__fb.writes.some((w) => w.path === "pompa/polecenie"));
  const [w] = await writes(page, "pompa/polecenie");
  assert.equal(w.value.akcja, "stop");
  assert.equal("czestotliwosc" in w.value, false);
  await ctx.close();
});

test("awaria falownika: Start zablokowany, Stop dostępny", async () => {
  const data = seedData(Date.now());
  data.pompa.status.awaria = true;
  data.pompa.status.kodAwarii = "F0001";
  const { page, ctx } = await open({ data });
  await page.click("#controlTab");
  await page.waitForFunction(() => document.getElementById("fault").textContent === "F0001");
  assert.equal(await page.isDisabled("#startPump"), true);
  assert.equal(await page.isDisabled("#stopPump"), false);
  await ctx.close();
});

test("utrata połączenia z bazą: sterowanie zablokowane, komunikat widoczny", async () => {
  const { page, ctx } = await open();
  await page.click("#controlTab");
  await page.waitForFunction(() => !document.getElementById("startPump").disabled);
  await page.evaluate(() => globalThis.__fb.setConnected(false));
  assert.equal(await page.textContent("#connectionText"), "Brak połączenia");
  assert.equal(await page.isDisabled("#startPump"), true);
  assert.equal(await page.isDisabled("#stopPump"), true);
  await page.evaluate(() => globalThis.__fb.setConnected(true));
  assert.equal(await page.isDisabled("#stopPump"), false);
  await ctx.close();
});

test("brak potwierdzenia z Raspberry: po 20 s komunikat i odblokowanie przycisków", async () => {
  const { page, ctx } = await open({ clockSkew: 1 });
  await page.click("#controlTab");
  await page.click("#stopPump");
  await page.clock.fastForward(21000);
  await page.waitForFunction(() => /Brak potwierdzenia/.test(document.getElementById("commandMessage").textContent));
  await ctx.close();
});

test("zły zegar telefonu: świeżość liczona względem czasu serwera", async () => {
  // telefon spieszy się o 10 min; Firebase zgłasza przesunięcie −10 min
  const skew = 10 * 60000;
  const { page, ctx } = await open({ clockSkew: skew, seed: { serverOffset: -skew } });
  await page.waitForFunction(() => document.getElementById("connectionText").textContent === "Dane aktualne");
  await ctx.close();
});

test("brak uprawnień do statusu: komunikat zamiast danych", async () => {
  const { page, ctx } = await open({ seed: { failPaths: ["pompa/status"] } });
  await page.waitForFunction(() => document.getElementById("connectionText").textContent === "Brak dostępu");
  assert.match(await page.textContent("#dataMessage"), /nie ma dostępu/);
  await ctx.close();
});

test("uszkodzone dane w bazie nie zatrzymują aplikacji", async () => {
  const data = seedData(Date.now());
  Object.assign(data.pompa.status, { moc: "abc", prad: null, pogoda: "zła wartość", energia: -5 });
  data.pompa.alarmy.zly = "tekst zamiast obiektu";
  data.pompa.ustawienia.limitMocy = 42;
  const { page, ctx, errors } = await open({ data });
  await page.waitForSelector("#dashboard:not([hidden])");
  for (const tab of ["control", "stats", "alarms", "overview"]) await page.click(`#${tab}Tab`);
  await page.click('[data-param="tPow"]');
  await page.click("#pcClose");
  assert.deepEqual(errors, []);
  assert.equal(await page.textContent("#sensorDriveCurrent"), "— A");
  await ctx.close();
});

test("statystyki: zmiana zakresu pobiera tylko brakujące dane", async () => {
  const { page, ctx } = await open();
  await page.click("#statsTab");
  await page.waitForFunction(() => /próbek/.test(document.getElementById("sampleCount").textContent));
  await page.click('#statsView .range button[data-days="7"]');
  await page.click('#statsView .range button[data-days="1"]');
  await page.click('#statsView .range button[data-days="7"]');
  const gets = await page.evaluate(() => globalThis.__fb.gets.filter((g) => g.path === "pompa/historia").length);
  // 1× pierwsze 24 h, 2× przy przejściu na 7 dni (starsze dni + nowe rekordy); powrót do 24 h i 7 dni — z pamięci
  assert.equal(gets, 3);
  await ctx.close();
});

test("niedostępny Firebase SDK: komunikat i przycisk ponowienia", async () => {
  const { page, ctx } = await open({ sdkFails: true });
  await page.waitForSelector("#retryLoad:not([hidden])");
  assert.match(await page.textContent("#loginMessage"), /Nie udało się załadować/);
  await ctx.close();
});

test("logowanie i wylogowanie", async () => {
  const { page, ctx } = await open({ seed: { user: null } });
  await page.waitForSelector("#submit:not([disabled])");
  await page.fill("#email", "jan@example.com");
  await page.fill("#password", "zlehaslo");
  await page.click("#submit");
  await page.waitForFunction(() => /Nie udało się zalogować/.test(document.getElementById("loginMessage").textContent));
  await page.fill("#password", "haslo123");
  await page.click("#submit");
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#logout");
  await page.waitForSelector("#login:not([hidden])");
  assert.equal(await page.inputValue("#password"), "");
  await ctx.close();
});

test("bez sieci: aplikacja otwiera się z pamięci service workera", async () => {
  const ctx = await browser.newContext({ locale: "pl-PL" });
  // skrypty compat Firebase dla service workera — minimalna atrapa
  const swStub = "self.firebase={initializeApp(){},messaging(){return{onBackgroundMessage(){}}}};";
  await ctx.route(/gstatic\.com\/firebasejs\/.*-compat\.js/, (r) =>
    r.fulfill({ contentType: "text/javascript", body: swStub }),
  );
  await ctx.route(/gstatic\.com\/firebasejs\/(?!.*-compat)/, (r) =>
    r.fulfill({ contentType: "text/javascript", body: MOCK }),
  );
  const page = await ctx.newPage();
  await page.addInitScript((s) => (globalThis.__FB_SEED = s), { data: seedData(Date.now()) });
  await page.goto(base);
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    // poczekaj, aż pliki aplikacji trafią do pamięci
    for (let i = 0; i < 50 && (await caches.keys()).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    return reg.active?.state;
  });
  await ctx.setOffline(true);
  await ctx.unrouteAll();
  await ctx.route(/gstatic\.com/, (r) => r.abort("internetdisconnected"));
  await page.reload();
  // szkielet aplikacji z pamięci + czytelny komunikat zamiast pustej strony błędu przeglądarki
  await page.waitForSelector("#retryLoad:not([hidden])");
  assert.match(await page.textContent("#loginMessage"), /Sprawdź internet/);
  assert.equal(await page.isVisible(".brand"), true);
  await ctx.close();
});
