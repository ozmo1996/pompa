"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { execFileSync } = require("node:child_process");
function patchControl(source) {
  if (source.includes("const pressureRuntime = new PressureRuntime")) return source;
  const once = (old, next) => {
    if (source.split(old).length !== 2) throw new Error("Nieznany fragment serwisu: " + old);
    source = source.replace(old, next);
  };
  // Jeden mutex na całą lokalną transakcję falownika; operacje Firebase nie mogą go blokować.
  once(
    "const sonda = new ModbusRTU();",
    `const sonda = new ModbusRTU();
const { PressureRuntime } = require('./pressure-control-runtime');
const pressureRuntime = new PressureRuntime(baza, {dir: __dirname, base: cfg.firebase.sciezka, log, limit: limitMocy, state: () => stan, stop: () => falownik.writeRegister(REJ.sterowanie, STEROWANIE_STOP)});`,
  );
  const start = source.indexOf("async function wykonajPolecenie(p)"),
    end = source.indexOf("async function petla()", start);
  if (start < 0 || end < 0) throw new Error("Brak funkcji sterowania");
  let command = source.slice(start, end);
  command = command.replace("async function wykonajPolecenie(p)", "async function wykonajPolecenieBezBlokady(p)");
  const startWrite = "await falownik.writeRegister(REJ.sterowanie, STEROWANIE_START);";
  if (command.split(startWrite).length !== 2) throw new Error("Nieznany rozruch");
  command = command.replace(
    startWrite,
    "await pressureRuntime.beforeStart(stan, limitMocy, hz, value => falownik.writeRegister(REJ.czestotliwoscZadana, Math.round(value * 100)));\n      " +
      startWrite +
      "\n      pressureRuntime.started();",
  );
  command = command.replace(
    /await refPolecenie\.update\(([\s\S]*?)\);/g,
    "pressureRuntime.background(refPolecenie.update($1));",
  );
  command = command.replace(
    /await zapiszZdarzenie\(([\s\S]*?)\);/g,
    "pressureRuntime.background(zapiszZdarzenie($1));",
  );
  command += `async function wykonajPolecenie(p) {
  return pressureRuntime.serial(async () => {
    if (!p || !p.id || p.id === ostatniIdPolecenia) return;
    const age = (Date.now() - (p.czas || 0)) / 1000;
    if (age > cfg.bezpieczenstwo.maksWiekPoleceniaSek || age < -5) return wykonajPolecenieBezBlokady(p);
    try { const prepared = pressureRuntime.prepareCommand(p, stan, limitMocy); await wykonajPolecenieBezBlokady(prepared); }
    catch(e) { ostatniIdPolecenia = p.id; pressureRuntime.background(refPolecenie.update({wykonane:false,wykonaneCzas:Date.now(),blad:e.message})); }
  });
}
`;
  source = source.slice(0, start) + command + source.slice(end);
  const loopStart = source.indexOf("async function petla()"),
    loopEnd = source.indexOf("async function petlaPoziomu()", loopStart);
  if (loopEnd < 0) throw new Error("Brak pętli pomiarowej");
  let loop = source.slice(loopStart, loopEnd).replace("async function petla()", "async function petlaBezBlokady()");
  const old = "const korekta = limitMocy.krok({ moc: dane.moc, pracuje: dane.pracuje });";
  if (loop.split(old).length !== 2) throw new Error("Nieznany arbitraż limitu mocy");
  loop = loop.replace(old, "const korekta = await pressureRuntime.control(dane, stan, limitMocy);");
  loop = loop.replace("bledyPodRzad++;", "pressureRuntime.driveError(e);\n    bledyPodRzad++;");
  loop = loop.replace(/await zapiszZdarzenie\(([\s\S]*?)\);/g, "pressureRuntime.background(zapiszZdarzenie($1));");
  loop = loop.replace("await zapisStatusu.zapisz(stan);", "pressureRuntime.background(zapisStatusu.zapisz(stan));");
  loop = loop.replace("setTimeout(petla, cfg.falownik.interwalOdpytywaniaMs);", "setTimeout(petla, 1000);");
  loop += "async function petla() { return pressureRuntime.serial(petlaBezBlokady); }\n";
  source = source.slice(0, loopStart) + loop + source.slice(loopEnd);
  const waterStart = source.indexOf("async function petlaPoziomu()"),
    waterEnd = source.indexOf("async function petlaTemperatury()", waterStart);
  if (waterEnd < 0) throw new Error("Brak odrębnej pętli ciśnienia");
  let water = source.slice(waterStart, waterEnd);
  water = water.replace("await zapisStatusu.zapisz(stan);", "pressureRuntime.background(zapisStatusu.zapisz(stan));");
  water = water.replace(/await zapiszZdarzenie\(([\s\S]*?)\);/g, "pressureRuntime.background(zapiszZdarzenie($1));");
  const schedule = "setTimeout(petlaPoziomu, cfg.poziomWody.interwalOdpytywaniaMs);";
  if (water.split(schedule).length !== 2) throw new Error("Nieznany harmonogram ciśnienia");
  water = water.replace(schedule, "setTimeout(petlaPoziomu, 1000);");
  return source.slice(0, waterStart) + water + source.slice(waterEnd);
}
if (require.main === module) {
  const target = path.resolve(process.argv[2] || "/home/pi/pompa/index.js");
  require(path.join(path.dirname(target), "pressure-control-runtime.js"));
  const source = fs.readFileSync(target, "utf8"),
    next = patchControl(source);
  if (source === next) console.log("CONTROL_ALREADY_INSTALLED");
  else {
    const temp = target + ".control-new.js";
    fs.writeFileSync(temp, next, { flag: "wx" });
    execFileSync(process.execPath, ["--check", temp]);
    const backup = target + ".bak-control-" + Date.now();
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temp, target);
    console.log("CONTROL_INSTALLED backup=" + backup);
  }
}
module.exports = { patchControl };
