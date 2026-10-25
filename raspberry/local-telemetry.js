"use strict";
// Publikacja do prywatnego katalogu RAM. Brak sieci i brak await w sterowaniu.
const fs = require("node:fs"),
  path = require("node:path");
const dir = () => "/dev/shm/pompa-" + process.getuid();
const file = () => path.join(dir(), "status.json");
const FIELDS = [
  "polaczony",
  "pracuje",
  "awaria",
  "moc",
  "prad",
  "napiecie",
  "czestotliwoscWyjsciowa",
  "czestotliwoscZadana",
  "aktualizacjaFalownika",
  "sondaPolaczona",
  "poziomWodyProc",
  "poziomWodyMa",
  "aktualizacjaPoziomu",
  "temperaturaWody",
  "temperaturaWodyPolaczona",
  "aktualizacjaTemperatury",
  "cisnienieTloczenia",
];
function snapshot(s, now = Date.now()) {
  return {
    ...Object.fromEntries(FIELDS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])),
    aktualizacja: now,
    lokalnaTelemetria: 1,
  };
}
let writing = false,
  last = 0,
  ready = false,
  lastError = 0;
function publish(s) {
  const now = Date.now();
  if (writing || now - last < 500) return;
  writing = true;
  last = now;
  const tmp = () => path.join(dir(), "status-" + process.pid + "-" + require("node:crypto").randomUUID() + ".tmp");
  let target;
  try {
    if (!ready) {
      fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir());
      if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
        throw Error("Nieprywatny katalog telemetrii");
      ready = true;
    }
    target = tmp();
    const data = JSON.stringify(snapshot(s, now));
    fs.writeFile(target, data, { mode: 0o600, flag: "wx" }, (e) => {
      if (e) return done(e);
      fs.rename(target, file(), done);
    });
  } catch (e) {
    done(e);
  }
  function done(e) {
    writing = false;
    if (e && target) fs.unlink(target, () => {});
    if (e && now - lastError > 60000) {
      console.error("Lokalna telemetria:", e.message);
      lastError = now;
    }
  }
}
function read(now = Date.now()) {
  try {
    const s = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (
      s.lokalnaTelemetria !== 1 ||
      !Number.isFinite(s.aktualizacja) ||
      now - s.aktualizacja < -1000 ||
      now - s.aktualizacja > 3000
    )
      return null;
    return s;
  } catch {
    return null;
  }
}
module.exports = { publish, read, snapshot };
