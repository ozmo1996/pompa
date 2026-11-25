"use strict";
const fs = require("node:fs");
const path = require("node:path");
const TEMPERATURE_MS = 3 * 60000;
const OTHER_MS = 10 * 60000;
const THROTTLE_MS = 30 * 60000;

function liczba(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapujPomiar(observation, stationId) {
  const metric = observation.metric || {};
  const czasPomiaru = liczba(observation.epoch) ? Number(observation.epoch) * 1000 : Date.parse(observation.obsTimeUtc);

  return {
    zrodlo: "Weather Underground",
    stacja: observation.stationID || stationId,
    miejscowosc: observation.neighborhood || null,
    czasPomiaru: Number.isFinite(czasPomiaru) ? czasPomiaru : null,
    pobrano: Date.now(),
    temperatura: liczba(metric.temp),
    odczuwalna: liczba(metric.heatIndex ?? metric.windChill),
    punktRosy: liczba(metric.dewpt),
    wilgotnosc: liczba(observation.humidity),
    cisnienie: liczba(metric.pressure),
    wiatr: liczba(metric.windSpeed),
    poryw: liczba(metric.windGust),
    kierunekWiatru: liczba(observation.winddir),
    opadTempo: liczba(metric.precipRate),
    opadDzienny: liczba(metric.precipTotal),
    uv: liczba(observation.uv),
    promieniowanie: liczba(observation.solarRadiation),
    statusJakosci: liczba(observation.qcStatus),
  };
}

function start(cfg, onData, log = console.log, database = null) {
  const settings = cfg.pogoda || {};
  const stationId = settings.stationId || "IBYSTR6";
  const keyFile = settings.plikKlucza || "/home/pi/pompa/.wunderground-key";
  const stateFile = path.join(path.dirname(keyFile), ".pogoda-state.json");
  let apiKey;
  try {
    apiKey = fs.readFileSync(keyFile, "utf8").trim();
    if (!apiKey) throw Error("Pusty klucz");
  } catch (error) {
    log("Pogoda: brak klucza API", error.message);
    return { stop() {} };
  }
  let state = { stationId, temperatureAt: 0, otherAt: 0, nextAttempt: 0, failures: 0, data: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (
      ["temperatureAt", "otherAt", "nextAttempt", "failures"].every(
        (k) => Number.isFinite(saved[k]) && saved[k] >= 0,
      ) &&
      saved.data &&
      typeof saved.data === "object" &&
      saved.stationId === stationId
    )
      state = saved;
  } catch {}
  const status = database?.ref(cfg.firebase.sciezka + "/status/pogodaOdbior");
  let busy = false,
    stopped = false;
  function persist() {
    fs.writeFileSync(stateFile + ".new", JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(stateFile + ".new", stateFile);
  }
  async function publishStatus(error = "") {
    try {
      await status?.update({
        blad: error,
        nastepnaProba: state.nextAttempt,
        aktualizacja: Date.now(),
        temperaturaInterwalMs: TEMPERATURE_MS,
        pozostaleInterwalMs: OTHER_MS,
      });
    } catch (e) {
      log("Pogoda: błąd zapisu stanu pobierania", e.message);
    }
  }
  async function poll() {
    const time = Date.now();
    const temperatureDue = time - state.temperatureAt >= TEMPERATURE_MS;
    const otherDue = time - state.otherAt >= OTHER_MS;
    if (stopped || busy || time < state.nextAttempt || (!temperatureDue && !otherDue)) return;
    busy = true;
    let retryMs = 0;
    try {
      const params = new URLSearchParams({
        stationId,
        format: "json",
        units: "m",
        numericPrecision: "decimal",
        apiKey,
      });
      const response = await fetch("https://api.weather.com/v2/pws/observations/current?" + params, {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const body = await response.text();
        const retry = response.headers.get("retry-after");
        retryMs = retry ? (Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - time) : 0;
        const throttled = response.status === 429 || /throttl/i.test(body);
        if (throttled || response.status === 401 || response.status === 403)
          retryMs = Math.max(THROTTLE_MS, retryMs || 0);
        throw Error(throttled ? "Limit zapytań Weather Underground" : "Weather Underground HTTP " + response.status);
      }
      const body = await response.json();
      const observation = body?.observations?.[0];
      if (!observation) throw Error("Brak pomiaru Weather Underground");
      const mapped = mapujPomiar(observation, stationId);
      const data = {
        ...state.data,
        zrodlo: mapped.zrodlo,
        stacja: mapped.stacja,
        miejscowosc: mapped.miejscowosc,
        pobrano: mapped.pobrano,
      };
      if (otherDue) {
        Object.assign(data, mapped, {
          temperatura: data.temperatura ?? null,
          wilgotnosc: data.wilgotnosc ?? null,
          czasPomiaru: data.czasPomiaru ?? null,
          pobranoPozostale: time,
          czasPomiaruPozostale: mapped.czasPomiaru,
        });
      }
      if (temperatureDue) {
        Object.assign(data, {
          temperatura: mapped.temperatura,
          wilgotnosc: mapped.wilgotnosc,
          pobranoTemperatura: time,
          czasPomiaru: mapped.czasPomiaru,
        });
      }
      await onData(data);
      state = {
        stationId,
        temperatureAt: temperatureDue ? time : state.temperatureAt,
        otherAt: otherDue ? time : state.otherAt,
        nextAttempt: Math.min(
          (temperatureDue ? time : state.temperatureAt) + TEMPERATURE_MS,
          (otherDue ? time : state.otherAt) + OTHER_MS,
        ),
        failures: 0,
        data,
      };
      persist();
      await publishStatus();
      log(
        "Pogoda " +
          stationId +
          ": temperatura/wilgotność " +
          (temperatureDue ? "zaktualizowane" : "bez zmiany") +
          ", pozostałe " +
          (otherDue ? "zaktualizowane" : "bez zmiany"),
      );
    } catch (error) {
      state.failures = Math.min(state.failures + 1, 10);
      state.nextAttempt =
        Date.now() + Math.max(retryMs || 0, Math.min(THROTTLE_MS, TEMPERATURE_MS * 2 ** (state.failures - 1)));
      try {
        persist();
      } catch (e) {
        log("Pogoda: błąd zapisu harmonogramu", e.message);
      }
      await publishStatus(error.message);
      log("Pogoda: " + error.message + "; ponowienie " + new Date(state.nextAttempt).toISOString());
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => {
    void poll();
  }, 5000);
  void poll();
  log("Pogoda: temperatura i wilgotność co 3 min; pozostałe co 10 min");
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
module.exports = { start, mapujPomiar, TEMPERATURE_MS, OTHER_MS, THROTTLE_MS };
