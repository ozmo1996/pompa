"use strict";
// Minimalna, walidowana poprawka aktualnego serwisu; bez przepisywania jego konfiguracji.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
function patchPressure(source) {
  if (source.includes("cisnienieTloczenia: require('./pressure').pressureSample")) return source;
  const start = source.indexOf("async function odczytajPoziom()"),
    end = source.indexOf("async function ", start + 20);
  if (start < 0 || end < 0) throw new Error("Nieznany układ serwisu — nic nie zmieniono");
  let block = source.slice(start, end);
  const replace = (old, next, count = 1) => {
    if (block.split(old).length - 1 !== count) throw new Error("Nieznany fragment: " + old);
    block = block.split(old).join(next);
  };
  replace("await sonda.readHoldingRegisters(p.rejestr, 1)", "await sonda.readHoldingRegisters(0, 4)");
  replace("const mA = odczyt.data[0] / 10;", "const mA = odczyt.data[p.rejestr] / 10;");
  replace(
    "poziomWodyMa:",
    "cisnienieTloczenia: require('./pressure').pressureSample(odczyt.data[0]),\n      poziomWodyMa:",
  );
  replace(
    "return { sondaPolaczona: false };",
    "return { sondaPolaczona: false, cisnienieTloczenia: require('./pressure').disconnectedPressure() };",
    2,
  );
  return source.slice(0, start) + block + source.slice(end);
}
if (require.main === module) {
  const target = path.resolve(process.argv[2] || "/home/pi/pompa/index.js");
  const dir = path.dirname(target);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  if (cfg.poziomWody?.wlaczony !== true || cfg.poziomWody?.rejestr !== 3)
    throw new Error("Oczekiwano działającego C2, rejestr 3 — nic nie zmieniono");
  require(path.join(dir, "pressure.js"));
  const source = fs.readFileSync(target, "utf8"),
    next = patchPressure(source);
  if (next === source) console.log("PRESSURE_ALREADY_INSTALLED");
  else {
    const temp = target + ".pressure-new.js";
    fs.writeFileSync(temp, next, { flag: "wx" });
    execFileSync(process.execPath, ["--check", temp]);
    const backup = target + ".bak-pressure-" + Date.now();
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temp, target);
    console.log("PRESSURE_INSTALLED backup=" + backup);
  }
}
module.exports = { patchPressure };
