"use strict";
const fs = require("node:fs");
function storageHealth(dir = "/home/pi/pompa", archive = "/home/pi/pompa-alarmy/historia.db") {
  const size = (name) => {
    try {
      return fs.statSync(name).size;
    } catch {
      return 0;
    }
  };
  const totalFile = (name) => size(name) + size(name + "-wal") + size(name + "-shm");
  const stat = fs.statfsSync(dir),
    free = stat.bavail * stat.bsize,
    total = stat.blocks * stat.bsize;
  return {
    aktualizacja: Date.now(),
    wolneBajty: free,
    pojemnoscBajty: total,
    telemetriaBajty: totalFile(dir + "/telemetry.db"),
    archiwumBajty: totalFile(archive),
    ostrzezenie: free < 2 * 1024 ** 3 || free / total < 0.15,
    bezUsuwaniaHistorii: true,
  };
}
module.exports = { storageHealth };
