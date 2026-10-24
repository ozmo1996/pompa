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

test("Aktualizacja: HTML i wszystkie lokalne moduły korzystają z jednej wersji cache", async () => {
  const { page, ctx, errors } = await open();
  const requests = [];
  page.on("request", (r) => {
    if (r.url().startsWith(base) && new URL(r.url()).pathname.endsWith(".js")) requests.push(r.url());
  });
  await page.reload();
  await page.waitForSelector("#dashboard:not([hidden])");
  const version = (await page.textContent("#appVersion")).split(" · v").at(-1);
  assert.ok(requests.length > 10);
  for (const url of requests) assert.equal(new URL(url).searchParams.get("v"), version, url);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Układ podglądu: kolejność, zapis, reset i odporność na obcy zapis bez poleceń pompy", async () => {
  const { page, ctx, errors } = await open();
  await page.waitForSelector("#dashboard:not([hidden])");
  const order = (selector) =>
    page.locator(selector + " > article").evaluateAll((nodes) => nodes.map((n) => n.dataset.overviewTile));
  const initial = await order(".overview-summary");
  const details = await order(".sensor-grid");
  assert.equal(initial.length, 9);
  assert.equal(details.length, 6);
  await page.click("#editOverviewLayout");
  for (const width of [320, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `width ${width}`);
  }
  await page.getByRole("button", { name: "Przesuń wcześniej: Ciśnienie tłoczenia", exact: true }).click();
  await page.getByRole("button", { name: "Przesuń wcześniej: Zbiornik", exact: true }).click();
  assert.deepEqual(await order(".overview-summary"), [initial[1], initial[0], ...initial.slice(2)]);
  assert.deepEqual(await order(".sensor-grid"), [details[0], details[2], details[1], ...details.slice(3)]);
  await page.reload();
  await page.waitForSelector("#dashboard:not([hidden])");
  assert.equal((await order(".overview-summary"))[0], initial[1]);
  assert.equal((await order(".sensor-grid"))[1], details[2]);
  await page.click("#editOverviewLayout");
  await page.click("#resetOverviewLayout");
  assert.deepEqual(await order(".overview-summary"), initial);
  assert.deepEqual(await order(".sensor-grid"), details);
  await page.evaluate(() =>
    localStorage.setItem(
      "pompa.overview.layout.v1",
      JSON.stringify({ summary: ["unknown", "summaryWater", "summaryWater"], details: null }),
    ),
  );
  await page.reload();
  await page.waitForSelector("#dashboard:not([hidden])");
  assert.equal((await order(".overview-summary"))[0], "summaryWater");
  assert.equal(new Set(await order(".overview-summary")).size, 9);
  assert.deepEqual(await order(".sensor-grid"), details);
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Dwa zatrzymania: oba dostępne bez falownika, wysyłają odrębne tryby bez Hz", async () => {
  const { page, ctx } = await open({ data: seedData(Date.now(), { fresh: false }) });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#controlTab");
  for (const [id, mode] of [
    ["gentleStopPump", "lagodny"],
    ["stopPump", "natychmiastowy"],
  ]) {
    await page.click("#" + id);
    const all = await writes(page, "pompa/polecenie");
    assert.equal(all.at(-1).value.akcja, "stop");
    assert.equal(all.at(-1).value.trybStop, mode);
    assert.equal("czestotliwosc" in all.at(-1).value, false);
  }
  await ctx.close();
});

test("Nowe skróty: pogoda, zawory i najnowszy alarm bez mylenia historii z aktywną awarią", async () => {
  const t = Date.now(),
    data = seedData(t);
  data.pompa.status.pogoda.temperatura = -8;
  data.pompa.status.cisnienieTloczenia = { bar: 32, napiecieV: 3.7, polaczony: true, aktualizacja: t };
  data.pompa.alarmy.info = { czas: t, poziom: "info", tytul: "Zwykła informacja" };
  const { page, ctx, errors } = await open({ data, clock: true });
  await page.waitForSelector("#dashboard:not([hidden])");
  assert.equal(await page.textContent("#summaryWeatherTemp"), "−8 °C".replace("−", "-"));
  assert.equal(await page.textContent("#summaryValves"), await page.textContent("#valveResult"));
  assert.match(await page.textContent("#summaryValves"), /Otwórz/);
  assert.equal(await page.textContent("#summaryLastAlarm"), "Awaria falownika");
  await page.evaluate(() =>
    globalThis.__fb.set("pompa/alarmy/new", {
      czas: Date.now(),
      poziom: "ostrzezenie",
      tytul: "Nowe ostrzeżenie",
      aktywny: false,
      zakonczono: Date.now(),
    }),
  );
  assert.equal(await page.textContent("#summaryLastAlarm"), "Nowe ostrzeżenie");
  assert.match(await page.textContent("#summaryLastAlarmState"), /historyczne/);
  assert.equal(
    await page
      .locator("#summaryLastAlarm")
      .getAttribute("class")
      .then((x) => x.includes("status-danger")),
    false,
  );
  await page.click("#summaryValvesTable");
  assert.equal(await page.isVisible("#valveTableDlg"), true);
  await page.click("#closeValveTable");
  await page.evaluate(() => globalThis.__fb.set("pompa/status/pogoda/pobrano", Date.now() - 60 * 60000));
  assert.equal(await page.textContent("#summaryWeatherTemp"), "— °C");
  assert.equal(await page.textContent("#summaryValves"), "Brak wskazówki");
  await page.click("#summaryAlarmOpen");
  assert.equal(await page.isVisible("#alarmsView"), true);
  assert.match(await page.textContent("#alarmList"), /Nowe ostrzeżenie/);
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Suwak bar/Hz: wybór bez zapisu, zmiana celu podczas pracy zachowuje granice i nie wysyła START", async () => {
  const t = Date.now(),
    data = seedData(t);
  data.pompa.ustawienia.regulatorCisnienia = {
    wersja: 1,
    id: "target-test",
    wlaczony: true,
    bar: 25,
    minHz: 0,
    maxHz: 50,
    maxBar: 32,
    zmieniono: t,
    zmienil: "test",
  };
  data.pompa.statusRegulatoraCisnienia = {
    wersja: 1,
    ustawieniaId: "target-test",
    wlaczony: true,
    aktualizacja: t,
    stan: "reguluje",
    awaria: "",
  };
  data.pompa.status.cisnienieTloczenia = { bar: 24, napiecieV: 2.9, polaczony: true, aktualizacja: t };
  const { page, ctx, errors } = await open({ data, clock: true });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#controlTab");
  await page.check("#setpointBarMode");
  assert.equal(await page.isVisible("#controlHzSlider"), false);
  assert.equal(await page.isVisible("#topPressureSlider"), true);
  assert.equal((await writes(page, "pompa/ustawienia/regulatorCisnienia")).length, 0);
  await page.fill("#topPressureBar", "26");
  assert.equal(Number(await page.inputValue("#topPressureSlider")), 26);
  page.once("dialog", (d) => d.dismiss());
  await page.click("#setPressureTarget");
  assert.equal((await writes(page, "pompa/ustawienia/regulatorCisnienia")).length, 0);
  page.once("dialog", (d) => d.accept());
  await page.click("#setPressureTarget");
  await page.waitForFunction(() => document.getElementById("topPressureMessage").textContent.includes("Zapisano"));
  const saved = (await writes(page, "pompa/ustawienia/regulatorCisnienia")).at(-1).value;
  assert.equal(saved.bar, 26);
  assert.equal(saved.minHz, 0);
  assert.equal(saved.maxHz, 50);
  assert.equal(saved.maxBar, 32);
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  assert.equal(await page.isEnabled("#setPressureTarget"), false); // oczekiwanie na nowy identyfikator Raspberry
  await page.check("#setpointHzMode");
  assert.equal(await page.isVisible("#controlHzSlider"), true);
  assert.equal(await page.isEnabled("#setFrequency"), false); // sam przełącznik nie wyłącza automatu
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Kamery wycofane: główna aplikacja nie ma zakładki ani żądań obrazu", async () => {
  const { page, ctx, errors } = await open();
  const cameraRequests = [];
  page.on("request", (request) => {
    if (/\.ts\.net|\/stream(?:\?|$)/.test(request.url())) cameraRequests.push(request.url());
  });
  await page.waitForSelector("#dashboard:not([hidden])");
  assert.equal(await page.locator("#camerasTab").count(), 0);
  assert.equal(await page.locator("video").count(), 0);
  for (const view of ["overview", "control", "stats", "notes", "alarms"]) await page.click("#" + view + "Tab");
  assert.deepEqual(cameraRequests, []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Kamery TEST: izolacja od sterowania, telefon, konfiguracja i brak automatycznej transmisji", async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 }, serviceWorkers: "block" });
  const page = await ctx.newPage(),
    requests = [],
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.route(/gstatic\.com\/firebasejs/, (r) => r.fulfill({ contentType: "text/javascript", body: MOCK }));
  await page.route("**/beta/kamery/connection.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: 'export const defaultEndpoint = "";' }),
  );
  await page.goto(base + "beta/kamery/");
  await page.waitForSelector("#account:not([hidden])");
  assert.match(await page.textContent("#message"), /Brak adresu/);
  assert.equal(await page.isDisabled("#play"), true);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  }
  await page.click("#helpTab");
  await page.fill("#endpoint", "https://admin:sekret@example.com/");
  await page.click("#endpointForm button");
  assert.match(await page.textContent("#endpointMessage"), /bez hasła/);
  await page.fill("#endpoint", "https://gateway.example.com/");
  page.once("dialog", (dialog) => dialog.accept());
  await page.click("#endpointForm button");
  assert.match(await page.textContent("#endpointMessage"), /Zapisano/);
  await page.click("#camerasTab");
  assert.equal(await page.isDisabled("#play"), false);
  assert.equal(
    requests.some((u) => /gateway\.example|database|firebase-messaging|192\.168/.test(u)),
    false,
  );
  assert.equal(await page.evaluate(() => globalThis.__fb.writes.length), 0);
  const logic = await page.evaluate(async () => {
    const { normalizeEndpoint } = await import("./camera-logic.js");
    return [
      "http://example.com",
      "https://u:p@example.com",
      "https://example.com/api",
      "https://example.com/?token=x",
      "https://example.com/#x",
    ].map((value) => {
      try {
        normalizeEndpoint(value);
        return false;
      } catch {
        return true;
      }
    });
  });
  assert.deepEqual(logic, [true, true, true, true, true]);
  await page.evaluate(() => {
    globalThis.__fb.user.getIdToken = async () => "test-only-token";
  });
  let streamRequests = 0;
  await page.route("https://gateway.example.com/stream", (route) => {
    streamRequests++;
    assert.equal(route.request().headers().authorization, "Bearer test-only-token");
    return route.fulfill({ status: 403, headers: { "access-control-allow-origin": new URL(base).origin } });
  });
  await page.click("#play");
  await page.waitForFunction(() => document.getElementById("message").textContent.includes("Brak uprawnień"));
  assert.equal(streamRequests, 1);
  assert.equal(await page.isDisabled("#stop"), true);
  assert.equal(await page.evaluate(() => globalThis.__fb.writes.length), 0);
  if (process.env.POMPA_CAMERA_CAPTURE) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: process.env.POMPA_CAMERA_CAPTURE });
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Kamery TEST: Stop, zmiana zakładki i przejście w tło przerywają żądanie", async () => {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.route(/gstatic\.com\/firebasejs/, (r) => r.fulfill({ contentType: "text/javascript", body: MOCK }));
  await page.addInitScript(() => {
    localStorage.setItem("pompaCameraTestEndpoint", "https://gateway.example.com");
    const realFetch = window.fetch;
    window.fetch = (url, options) => {
      if (url !== "https://gateway.example.com/stream") return realFetch(url, options);
      globalThis.cameraPending = true;
      return new Promise((resolve, reject) =>
        options.signal.addEventListener(
          "abort",
          () => {
            globalThis.cameraPending = false;
            reject(new Error("Przerwano test"));
          },
          { once: true },
        ),
      );
    };
  });
  await page.goto(base + "beta/kamery/");
  await page.waitForSelector("#account:not([hidden])");
  await page.evaluate(() => {
    globalThis.__fb.user.getIdToken = async () => "test-only-token";
  });
  for (const action of ["stop", "help", "background"]) {
    if (action !== "stop") await page.click("#camerasTab");
    await page.click("#play");
    await page.waitForFunction(() => globalThis.cameraPending === true);
    if (action === "stop") await page.click("#stop");
    if (action === "help") await page.click("#helpTab");
    if (action === "background")
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { value: true, configurable: true });
        document.dispatchEvent(new window.Event("visibilitychange"));
      });
    await page.waitForFunction(() => globalThis.cameraPending === false);
    assert.equal(await page.isDisabled("#stop"), true);
  }
  assert.equal(await page.evaluate(() => globalThis.__fb.writes.length), 0);
  await ctx.close();
});

test("UX: wszystkie zakładki dostępne na telefonie, podsumowanie i łączność mają osobne znaczenia", async () => {
  const data = seedData(),
    t = Date.now();
  data.pompa.alarmy = {};
  data.pompa.status.aktualizacja = t;
  data.pompa.status.aktualizacjaPoziomu = t;
  data.pompa.status.cisnienieTloczenia = { bar: 25, napiecieV: 3, polaczony: true, aktualizacja: t };
  const { page, ctx, errors } = await open({ data });
  await page.waitForSelector("#dashboard:not([hidden])");
  for (const width of [320, 360, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const inside = await page.evaluate(() =>
      [...document.querySelectorAll(".tab")].every((n) => {
        const r = n.getBoundingClientRect();
        return r.x >= 0 && r.right <= window.innerWidth && r.y >= 0 && r.bottom <= window.innerHeight;
      }),
    );
    assert.equal(inside, true, "Wszystkie zakładki widoczne: " + width);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.match(await page.textContent("#summaryPressure"), /25.*bar/);
  assert.match(await page.textContent("#summaryWater"), /160,5.*cm/);
  assert.match(await page.textContent("#cloudConnection"), /połączona/);
  assert.match(await page.textContent("#driveConnection"), /odpowiada/);
  if (process.env.POMPA_UX_CAPTURE) {
    for (const view of ["overview", "control", "stats", "notes", "alarms"]) {
      await page.click("#" + view + "Tab");
      await page.evaluate(() => window.scrollTo(0, 0));
      if (view === "stats") await page.waitForFunction(() => !document.getElementById("statsPointIndex").disabled);
      await page.screenshot({ path: process.env.POMPA_UX_CAPTURE + "-" + view + ".png" });
    }
    await page.click("#overviewTab");
  }
  await page.evaluate(() => globalThis.__fb.set("pompa/status/polaczony", false));
  assert.match(await page.textContent("#piConnection"), /aktualny zapis/);
  assert.match(await page.textContent("#driveConnection"), /brak potwierdzenia/);
  assert.match(await page.textContent("#summaryPower"), /—/);
  await page.evaluate(() => globalThis.__fb.set("pompa/status/cisnienieTloczenia/bar", 45));
  assert.match(await page.textContent("#summaryPressure"), /—/);
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("UX: alarmy przed konfiguracją, a zadania przed zwiniętym formularzem notatki", async () => {
  const { page, ctx, errors } = await open();
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#alarmsTab");
  assert.ok(
    await page.evaluate(
      () =>
        document.getElementById("alarmHistoryHeading").getBoundingClientRect().top <
        document.getElementById("alarmSettingsPanel").getBoundingClientRect().top,
    ),
  );
  assert.match(await page.textContent("#alarmList"), /nie usuwa przyczyny/);
  await page.click("#notesTab");
  assert.equal(await page.isVisible("#noteTitle"), false);
  await page.click("#newNote");
  assert.equal(await page.isVisible("#noteTitle"), true);
  assert.match(await page.textContent('label[for="noteHours"]'), /Termin za/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("UX: wykres pokazuje jedną serię i dokładną próbkę, puste dane nie udają zera", async () => {
  const { page, ctx, errors } = await open();
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#statsTab");
  await page.waitForFunction(() => !document.getElementById("statsPointIndex").disabled);
  assert.equal(await page.locator("[data-stats-chart]:not([hidden])").count(), 1);
  await page.focus("#statsPointIndex");
  await page.press("#statsPointIndex", "End");
  assert.match(await page.textContent("#statsPoint"), /\d.*%/);
  assert.equal(await page.isVisible("#historyRows"), false);
  await page.selectOption("#statsMetric", "pressureChart");
  assert.equal(await page.isVisible("#waterChart"), false);
  assert.equal(await page.isDisabled("#statsPointIndex"), true);
  assert.match(await page.textContent("#statsPoint"), /Brak próbek/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("UX: blokady są czerwone i progi alarmu nie są mylone z zatrzymaniem", async () => {
  const data = seedData(),
    t = Date.now();
  data.pompa.statusRegulatoraCisnienia = {
    wersja: 1,
    aktualizacja: t,
    ustawieniaId: "domyslne",
    wlaczony: false,
    awaria: "Blokada testowa",
  };
  data.pompa.statusZabezpieczeniaWody = {
    wersja: 1,
    aktualizacja: t,
    ustawieniaId: "domyslne",
    awaria: "Niski poziom",
    wlaczony: false,
  };
  const { page, ctx, errors } = await open({ data });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#controlTab");
  for (const id of ["waterSafetyBanner", "waterSafetyState", "controlModeSummary", "pressureControlState"])
    assert.equal(await page.locator("#" + id).evaluate((n) => n.classList.contains("status-danger")), true);
  assert.match(await page.textContent("#waterThresholdSummary"), /nie wysyła STOP/);
  await page.click("#waterAlarmSettings");
  assert.equal(await page.isVisible("#rule-niskiPoziom"), true);
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

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
  assert.ok(
    await page.locator("#stopPump").evaluate((node) => {
      const r = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
    "Dolna nawigacja nie zasłania STOP-u",
  );
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
  await page.waitForFunction(() => !document.getElementById("startPressurePump").disabled);
  assert.equal(await page.isEnabled("#startPump"), false);
  if (process.env.POMPA_CONTROL_CAPTURE)
    await page.locator("#pressureControlCard").screenshot({ path: process.env.POMPA_CONTROL_CAPTURE });
  await page.click("#startPressurePump");
  assert.match(await page.textContent("#dlgTitle"), /regulację ciśnienia/);
  assert.match(await page.textContent("#dlgLead"), /25 bar/);
  await page.click("#dlgOk");
  await page.waitForFunction(() => globalThis.__fb.writes.some((w) => w.path === "pompa/polecenie"));
  const command = (await writes(page, "pompa/polecenie")).at(-1).value;
  assert.equal(command.czestotliwosc, 35);
  await page.evaluate(() => {
    const c = globalThis.__fb.read("pompa/polecenie");
    globalThis.__fb.set("pompa/polecenie", { ...c, wykonane: true });
    globalThis.__fb.set("pompa/status/cisnienieTloczenia/aktualizacja", Date.now() - 4000);
  });
  await page.waitForFunction(() => document.getElementById("startPressurePump").disabled);
  assert.equal(await page.isEnabled("#stopPump"), true);
  await page.evaluate(() => globalThis.__fb.set("pompa/statusRegulatoraCisnienia/awaria", "Utrata czujnika"));
  assert.equal(await page.isEnabled("#startPump"), false);
  assert.equal(await page.isEnabled("#startPressurePump"), false);
  assert.equal(await page.isEnabled("#stopPump"), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Osobny start ciśnienia: 0 Hz, anulowanie, zmiana ustawień w dialogu i utrata łączności", async () => {
  const t = Date.now(),
    data = seedData(t);
  data.pompa.status.pracuje = false;
  data.pompa.status.cisnienieTloczenia = { bar: 0, napiecieV: 0.5, polaczony: true, aktualizacja: t };
  data.pompa.ustawienia.limitMocy.minHz = 0;
  data.pompa.ustawienia.regulatorCisnienia = {
    wersja: 1,
    id: "auto-zero",
    wlaczony: true,
    bar: 25,
    minHz: 0,
    maxHz: 50,
    maxBar: 32,
    zmieniono: t,
    zmienil: "test",
  };
  data.pompa.statusRegulatoraCisnienia = {
    wersja: 1,
    ustawieniaId: "auto-zero",
    wlaczony: true,
    aktualizacja: t,
    stan: "gotowy",
    awaria: "",
  };
  const { page, ctx, errors } = await open({ data, clock: true });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#controlTab");
  assert.equal(await page.isEnabled("#startPump"), false);
  await page.click("#startPressurePump");
  assert.match(await page.textContent("#dlgLead"), /0,0 Hz/);
  await page.click("#dlgCancel");
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  await page.click("#startPressurePump");
  await page.evaluate(() => {
    const cfg = globalThis.__fb.read("pompa/ustawienia/regulatorCisnienia");
    globalThis.__fb.set("pompa/ustawienia/regulatorCisnienia", { ...cfg, id: "changed", bar: 20 });
    globalThis.__fb.set("pompa/statusRegulatoraCisnienia/ustawieniaId", "changed");
  });
  await page.click("#dlgOk");
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  await page.waitForFunction(() => document.getElementById("commandMessage").textContent.includes("zmienił"));
  assert.match(await page.textContent("#commandMessage"), /zmienił/);
  await page.click("#startPressurePump");
  await page.click("#dlgOk");
  await page.waitForFunction(() => globalThis.__fb.writes.some((w) => w.path === "pompa/polecenie"));
  const command = (await writes(page, "pompa/polecenie")).at(-1).value;
  assert.equal(command.akcja, "start");
  assert.equal(command.czestotliwosc, 0);
  await page.evaluate(() => globalThis.__fb.setConnected(false));
  assert.equal(await page.isEnabled("#startPressurePump"), false);
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

test("Praca automatyczna → ręczna: bez STOP/START ani zapisu Hz, dopiero po potwierdzeniu Raspberry", async () => {
  const t = Date.now(),
    data = seedData(t);
  data.pompa.ustawienia.regulatorCisnienia = {
    wersja: 1,
    id: "running-auto",
    wlaczony: true,
    bar: 25,
    minHz: 0,
    maxHz: 50,
    maxBar: 32,
    zmieniono: t,
    zmienil: "test",
  };
  data.pompa.statusRegulatoraCisnienia = {
    wersja: 1,
    ustawieniaId: "running-auto",
    wlaczony: true,
    aktualizacja: t,
    stan: "reguluje",
    awaria: "",
  };
  const { page, ctx, errors } = await open({ data, clock: true });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#controlTab");
  assert.equal(await page.locator("#pumpControlCard #startPressurePump").count(), 1);
  assert.equal(await page.isEnabled("#setFrequency"), false);
  page.once("dialog", (d) => d.dismiss());
  await page.click("#switchToManual");
  assert.equal((await writes(page, "pompa/ustawienia/regulatorCisnienia")).length, 0);
  page.once("dialog", (d) => d.accept());
  await page.click("#switchToManual");
  const saved = (await writes(page, "pompa/ustawienia/regulatorCisnienia")).at(-1).value;
  assert.equal(saved.wlaczony, false);
  assert.equal(saved.bar, 25);
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  assert.equal(await page.isEnabled("#setFrequency"), false);
  await page.evaluate(() => {
    globalThis.__fb.set("pompa/statusRegulatoraCisnienia/wlaczony", false);
  });
  assert.equal(await page.isEnabled("#setFrequency"), false); // stary identyfikator potwierdzenia
  await page.evaluate(() => {
    const cfg = globalThis.__fb.read("pompa/ustawienia/regulatorCisnienia");
    globalThis.__fb.set("pompa/statusRegulatoraCisnienia/ustawieniaId", cfg.id);
  });
  assert.equal(await page.isEnabled("#setFrequency"), true);
  assert.equal(Number(await page.inputValue("#controlHz")), 42);
  assert.match(await page.textContent("#manualModeMessage"), /potwierdziło/);
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("Statystyki: dokładny okres filtruje próbki, przybliżenie i walidacja nie tworzą danych", async () => {
  const t = Math.floor(Date.now() / 60000) * 60000,
    data = seedData(t);
  data.pompa.historia = {
    before: { czas: t - 21 * 60000, poziom: 99 },
    first: { czas: t - 19 * 60000, poziom: 10 },
    second: { czas: t - 11 * 60000, poziom: 20 },
    after: { czas: t - 9 * 60000, poziom: 88 },
  };
  const { page, ctx, errors } = await open({ data, clock: true });
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.click("#statsTab");
  const local = (value) => {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Warsaw",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(new Date(value))
      .replace(" ", "T");
  };
  await page.fill("#statsFrom", local(t - 20 * 60000));
  await page.fill("#statsTo", local(t - 10 * 60000));
  await page.locator("#statsPeriodForm button[type=submit]").click();
  await page.waitForFunction(() => document.getElementById("sampleCount").textContent === "2 próbek");
  await page.click("#statsZoomIn");
  await page.waitForFunction(() => document.getElementById("sampleCount").textContent === "0 próbek");
  const width = await page.evaluate(
    () => new Date(document.getElementById("statsTo").value) - new Date(document.getElementById("statsFrom").value),
  );
  assert.equal(width, 5 * 60000);
  await page.fill("#statsFrom", local(t - 5 * 60000));
  await page.fill("#statsTo", local(t - 10 * 60000));
  await page.locator("#statsPeriodForm button[type=submit]").click();
  assert.match(await page.textContent("#statsPeriodMessage"), /początek musi/);
  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  }
  assert.equal((await writes(page, "pompa/polecenie")).length, 0);
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
  assert.match(await page.textContent("#connectionText"), /aktualny zapis/);
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
  assert.equal(await page.textContent("#summaryMeterPower"), "— kW");
  assert.equal(await page.textContent("#summaryMeterHz"), "— Hz");
  assert.equal(await page.locator("#summaryPressureMode").count(), 0);
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
  assert.equal(await page.textContent("#summaryMeterPower"), "74,3 kW");
  assert.equal(await page.textContent("#summaryMeterHz"), "50 Hz");
  await page.evaluate(() => globalThis.__fb.set("pompa/status/polaczony", false));
  assert.equal(await page.textContent("#summaryMeterHz"), "50 Hz");
  await page.evaluate(() => globalThis.__fb.set("pompa/status/nd20/aktualizacja", Date.now() - 20000));
  assert.equal(await page.textContent("#summaryMeterPower"), "— kW");
  assert.equal(await page.textContent("#summaryMeterHz"), "— Hz");
  assert.match(await page.textContent("#summaryMeterState"), /Brak aktualnego/);
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

test("ND20: nowy kafelek zachowuje pozycję poprzedniego skrótu regulacji ciśnienia", async () => {
  const { page, ctx, errors } = await open();
  await page.waitForSelector("#dashboard:not([hidden])");
  await page.evaluate(() =>
    localStorage.setItem(
      "pompa.overview.layout.v1",
      JSON.stringify({ summary: ["summaryPressureMode", "summaryWater", "summaryPump"] }),
    ),
  );
  await page.reload();
  await page.waitForSelector("#dashboard:not([hidden])");
  const tiles = await page
    .locator(".overview-summary > article")
    .evaluateAll((nodes) => nodes.map((n) => n.dataset.overviewTile));
  assert.equal(tiles[0], "summaryMeterPower");
  assert.equal(tiles[1], "summaryWater");
  assert.equal(new Set(tiles).size, 9);
  await page.click("#editOverviewLayout");
  assert.equal(
    await page
      .getByRole("button", { name: "Przesuń później: Agregat — moc i częstotliwość ND20", exact: true })
      .count(),
    1,
  );
  assert.deepEqual(errors, []);
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
  for (const chart of ["pumpChart", "pumpHzChart", "pumpCurrentChart"]) {
    await page.selectOption("#statsMetric", chart);
    assert.equal(await page.isVisible("#" + chart), true);
  }
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
  await page.selectOption("#statsMetric", "pressureChart");
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
  await page.click("#newNote");
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
  await page.waitForFunction(
    () => document.getElementById("connectionText").textContent === "Raspberry: aktualny zapis",
  );
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
