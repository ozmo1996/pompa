"use strict";
const fs = require("node:fs/promises");
function parseTemperature(text) {
  const [crc, value] = String(text).trim().split("\n");
  const match = /\bt=(-?\d+)\b/.exec(value || "");
  if (!/\bcrc=[0-9a-f]+ YES\b/i.test(crc || "") || !match) throw new Error("CRC lub brak odpowiedzi DS18B20");
  const c = Number(match[1]) / 1000;
  if (!Number.isFinite(c) || c < -55 || c > 125) throw new Error("Temperatura poza zakresem DS18B20");
  return Math.round(c * 10) / 10;
}
async function readTemperature(
  file,
  read = fs.readFile,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      return {
        celsius: parseTemperature(await read(file, { encoding: "utf8", signal: controller.signal })),
        retries: attempt,
      };
    } catch (error) {
      last = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await wait(150);
  }
  throw new Error("DS18B20: 3 nieudane próby: " + last.message);
}
module.exports = { parseTemperature, readTemperature };
