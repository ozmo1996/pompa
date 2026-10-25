"use strict";

// Osobny, tylko-odczytowy proces ND20. Nie steruje pompą ani limitem mocy.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Rejestry 7000...7065: funkcja 03, float IEEE-754, kolejność bajtów 3-2-1-0.
// Adresy są adresami protokołu, bez odejmowania 40001.
function decodeRegisters(words) {
  if (!Array.isArray(words) || words.length !== 66) throw new Error("Niepełna odpowiedź ND20");
  const value = (offset) => {
    const bytes = Buffer.allocUnsafe(4);
    bytes.writeUInt16BE(words[offset], 0);
    bytes.writeUInt16BE(words[offset + 1], 2);
    const n = bytes.readFloatBE(0);
    return Number.isFinite(n) && Math.abs(n) < 1e19 ? Math.round(n * 100) / 100 : null;
  };
  const hz = value(56);
  const u12 = value(58);
  if ((hz !== null && (hz < 0 || hz > 70)) || (u12 !== null && (u12 < 0 || u12 > 1000))) {
    throw new Error("Odczyt ND20 poza zakresem — sprawdź format transmisji i tryb sieci");
  }
  return {
    napiecieL1: value(0),
    pradL1: value(2),
    napiecieL2: value(14),
    pradL2: value(16),
    napiecieL3: value(28),
    pradL3: value(30),
    mocKw: value(46) === null ? null : Math.round(value(46) / 10) / 100,
    pf: value(52),
    czestotliwoscHz: hz,
    napiecieL1L2: u12,
    napiecieL2L3: value(60),
    napiecieL3L1: value(62),
  };
}

async function connect(client, meter) {
  await client.connectRTUBuffered(meter.urzadzenie, {
    baudRate: meter.predkosc || 9600,
    parity: meter.parzystosc || "none",
    dataBits: 8,
    stopBits: meter.bityStopu || 2,
  });
  client.setID(meter.adresModbus || 1);
}

async function main() {
  const fs = require("node:fs");
  const ModbusRTU = require("modbus-serial");
  const admin = require("firebase-admin");
  const cfg = JSON.parse(fs.readFileSync("/home/pi/pompa/config.json", "utf8"));
  const meter = cfg.nd20 || {};
  const client = new ModbusRTU();
  client.setTimeout(900);
  admin.initializeApp({
    credential: admin.credential.cert(require(cfg.firebase.plikKlucza)),
    databaseURL: cfg.firebase.adresBazy,
  });
  const { TelemetryHistory } = require("./telemetry-history");
  const Database = require(meter.modulSqlite || "/home/pi/pompa-alarmy/node_modules/better-sqlite3");
  const history = new TelemetryHistory(
    new Database("/home/pi/pompa/telemetry.db"),
    admin.database().ref(`${cfg.firebase.sciezka}/historia`),
    admin.database().ref(`${cfg.firebase.sciezka}/zdarzenia`),
  );
  const { EnergyCounters } = require("./energy-counters");
  const energy = new EnergyCounters(history.db);
  const { FlowCounter } = require("./flow-counter");
  const flow = new FlowCounter(history.db, cfg.wydajnosc?.cisnienieSsaniaBar ?? 0);
  const energyRef = admin.database().ref(`${cfg.firebase.sciezka}/status`);
  const { CounterControl } = require("./counter-control");
  const control = new CounterControl(history.db, energy, flow);
  const { CloudSync } = require("./cloud-sync"),
    local = require("./local-telemetry");
  const { storageHealth } = require("./storage-health");
  let meterStatus = { polaczony: false, aktualizacja: null };
  let storage = null,
    storageAt = 0;
  const sync = new CloudSync(
    energyRef,
    history,
    () => ({
      nd20: meterStatus,
      licznikiEnergii: energy.snapshot(),
      wydajnoscPompy: flow.snapshot(),
      sterowanieLicznikami: control.snapshot(),
      archiwumPomiarow: storage,
      lokalnyZapisPomiarow: {
        wersja: 1,
        aktualizacja: Date.now(),
        zrodlo: "lokalne",
        plikAktualny: !!status,
        kolejka: history.db.prepare("SELECT COUNT(*) n FROM outbox").get().n,
      },
    }),
    console.error,
  );
  let status = null;
  admin
    .database()
    .ref(`${cfg.firebase.sciezka}/ustawienia/liczniki`)
    .on(
      "value",
      (s) => {
        try {
          if (control.apply(s.val())) sync.tick();
        } catch (e) {
          console.error("Liczniki:", e.message);
        }
      },
      (e) => console.error("Ustawienia liczników:", e.message),
    );
  // Niezależnie od czasu odpowiedzi ND20 i wysyłki do chmury; nie zapisuje komend do falownika.
  setInterval(() => {
    try {
      const time = Date.now();
      status = local.read(time);
      const wasFlow = Number.isFinite(flow.current?.q);
      flow.observe(status, time);
      history.pressure(status, time, flow.row());
      if (wasFlow && flow.current?.q === null)
        history.save("wydajnosc-koniec", 0, { czas: time, typ: "wydajnosc", ...flow.row() }, true);
      history.water(status, time);
      if (time - storageAt >= 300000) {
        storage = storageHealth();
        storageAt = time;
      }
    } catch (error) {
      console.error("Historia ciśnienia:", error.message);
    }
    try {
      const time = Date.now(),
        driveAge = time - status?.aktualizacjaFalownika;
      energy.sample(
        "pompa",
        status?.polaczony === true && driveAge >= -1000 && driveAge < 3000 ? status.moc : null,
        status?.aktualizacjaFalownika,
        time,
      );
    } catch (error) {
      console.error("Energia:", error.message);
    }
  }, 1000);
  setInterval(() => sync.tick(), 5000);
  for (;;) {
    if (!meter.wlaczony) {
      await delay(5000);
      continue;
    }
    try {
      if (!client.isOpen) await connect(client, meter);
      const response = await client.readHoldingRegisters(7000, 66);
      const data = decodeRegisters(response.data);
      energy.sample("agregat", data.mocKw, Date.now());
      history.meter(data, Date.now());
      meterStatus = {
        polaczony: true,
        ...data,
        aktualizacja: Date.now(),
      };
    } catch (error) {
      energy.invalidate("agregat");
      console.error("ND20:", error.message);
      meterStatus = { polaczony: false, aktualizacja: null };
      try {
        client.close(() => {});
      } catch {
        /* port mógł nie zostać otwarty */
      }
    }
    await delay(meter.interwalMs || 5000);
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

module.exports = { decodeRegisters };
