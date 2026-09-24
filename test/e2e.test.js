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
async function open({ data, seed = {}, clockSkew = 0, sdkFails = false } = {}) {
  const ctx = await browser.newContext({ locale: "pl-PL", timezoneId: "Europe/Warsaw", serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (clockSkew) await page.clock.install({ time: Date.now() + clockSkew });
  await page.route(/gstatic\.com\/firebasejs/, (r) =>
    sdkFails ? r.abort() : r.fulfill({ contentType: "text/javascript", body: MOCK }),
  );
  await page.addInitScript((s) => (globalThis.__FB_SEED = s), { data: data ?? seedData(Date.now()), ...seed });
  await page.goto(base);
  return { page, ctx, errors };
}
const writes = (page, p) => page.evaluate((p) => globalThis.__fb.writes.filter((w) => w.path === p), p);

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
