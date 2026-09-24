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
  const meter = cfg.nd20;
  if (!meter?.wlaczony) {
    console.log("ND20 wyłączony w config.json; oczekiwanie na montaż i konfigurację miernika.");
    return;
  }
  const client = new ModbusRTU();
  client.setTimeout(900);
  admin.initializeApp({
    credential: admin.credential.cert(require(cfg.firebase.plikKlucza)),
    databaseURL: cfg.firebase.adresBazy,
  });
  const ref = admin.database().ref(`${cfg.firebase.sciezka}/status/nd20`);
  for (;;) {
    try {
      if (!client.isOpen) await connect(client, meter);
      const response = await client.readHoldingRegisters(7000, 66);
      await ref.update({
        polaczony: true,
        ...decodeRegisters(response.data),
        aktualizacja: Date.now(),
      });
    } catch (error) {
      console.error("ND20:", error.message);
      await ref.update({ polaczony: false, aktualizacja: null }).catch((e) => console.error("Firebase:", e.message));
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
