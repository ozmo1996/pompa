"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  vm = require("node:vm");
const { execFileSync } = require("node:child_process");
function once(source, old, next) {
  if (source.split(old).length !== 2) throw Error("Nieznana wersja pliku: " + old);
  return source.replace(old, next);
}
function patchIndex(s) {
  if (s.includes("dane.aktualizacjaFalownika = Date.now(); // local-measurements-v1")) return s;
  return once(
    s,
    "const dane = await odczytajFalownik();",
    "const dane = await odczytajFalownik();\n    dane.aktualizacjaFalownika = Date.now(); // local-measurements-v1",
  );
}
function patchWriter(s) {
  if (s.includes("// local-measurements-v1")) return s;
  return once(
    s,
    "module.exports = { ZapisStatusu, PROGI };",
    `// local-measurements-v1
const originalZapisz = ZapisStatusu.prototype.zapisz;
let lastLocalError = 0;
ZapisStatusu.prototype.zapisz = function(stan, ...args) {
  try { require('./local-telemetry').publish(stan); }
  catch(e) { if(Date.now()-lastLocalError>60000) { console.error('Lokalny zapis:', e.message); lastLocalError=Date.now(); } }
  return originalZapisz.call(this, stan, ...args);
};
module.exports = { ZapisStatusu, PROGI };`,
  );
}
function main() {
  const mode = process.argv[2];
  if (!["--check", "--apply-stopped"].includes(mode))
    throw Error("Wymagane --check albo --apply-stopped po potwierdzeniu postoju");
  const dir = "/home/pi/pompa";
  const expected = {
    "index.js": "a845b6f513c8e1648e38ed66305097ae9a2461400624ec258967e63b825a8bde",
    "zapis-statusu.js": "4931121106eb3dba253e628171ab28ad1e9cd961c063e2f0f6b7b477ca0124ba",
  };
  const updates = [];
  for (const [name, patch] of [
    ["index.js", patchIndex],
    ["zapis-statusu.js", patchWriter],
  ]) {
    const current = fs.readFileSync(path.join(dir, name));
    if (
      !current.toString().includes("// local-measurements-v1") &&
      crypto.createHash("sha256").update(current).digest("hex") !== expected[name]
    )
      throw Error("Plik zmienił się od przeglądu: " + name);
    updates.push([name, patch(current.toString())]);
  }
  for (const name of [
    "nd20.js",
    "telemetry-history.js",
    "energy-counters.js",
    "flow-counter.js",
    "pump-estimate.js",
    "counter-control.js",
    "cloud-sync.js",
    "local-telemetry.js",
    "storage-health.js",
  ])
    updates.push([name, fs.readFileSync(path.join(__dirname, name), "utf8")]);
  for (const [name, text] of updates) new vm.Script(text, { filename: name });
  console.log("SYNTAX_AND_SOURCE_OK");
  if (mode === "--check") return;
  const backup = path.join(dir, "backup-measurements-" + Date.now());
  fs.mkdirSync(backup, { mode: 0o700 });
  for (const [name] of updates)
    if (fs.existsSync(path.join(dir, name))) fs.copyFileSync(path.join(dir, name), path.join(backup, name));
  execFileSync("sudo", ["systemctl", "stop", "pompa", "pompa-nd20"], { stdio: "inherit" });
  try {
    for (const [name, text] of updates) {
      const tmp = path.join(dir, name + ".measurement-new");
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, path.join(dir, name));
    }
    execFileSync("sudo", ["systemctl", "start", "pompa", "pompa-nd20"], { stdio: "inherit" });
  } catch (e) {
    for (const [name] of updates)
      if (fs.existsSync(path.join(backup, name))) fs.copyFileSync(path.join(backup, name), path.join(dir, name));
    execFileSync("sudo", ["systemctl", "start", "pompa", "pompa-nd20"], { stdio: "inherit" });
    throw e;
  }
  console.log("INSTALLED_BACKUP=" + backup);
}
if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
module.exports = { patchIndex, patchWriter };
