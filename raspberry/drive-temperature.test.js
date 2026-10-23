const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { stopDrive } = require("./drive-stop");
const { readTemperature, parseTemperature } = require("./water-temperature");
test("STOP: łagodny zdejmuje STF, MRS wymaga potwierdzenia konfiguracji", async () => {
  const writes = [],
    reads = [];
  const drive = {
    writeRegister: async (...v) => writes.push(v),
    readHoldingRegisters: async (r) => {
      reads.push(r);
      return { data: [r === 1016 ? 0 : 24] };
    },
  };
  await stopDrive(drive);
  assert.deepEqual(writes, [[8, 0]]);
  await stopDrive(drive, "natychmiastowy");
  assert.deepEqual(reads, [1016, 1186]);
  assert.deepEqual(writes, [
    [8, 0],
    [8, 1024],
  ]);
  drive.readHoldingRegisters = async () => ({ data: [2] });
  await assert.rejects(stopDrive(drive, "natychmiastowy"), /NIEPOTWIERDZONE/);
  assert.deepEqual(writes.at(-1), [8, 0]);
  assert.equal(writes.filter((w) => w[1] === 2).length, 0, "STOP nie uruchamia silnika");
});
test("Temperatura: ponowienia CRC, zero poprawne, brak udawania pomiaru po 3 błędach", async () => {
  const valid = "00 crc=ab YES\n00 t=0\n";
  assert.equal(parseTemperature(valid), 0);
  let attempts = 0;
  const r = await readTemperature(
    "test",
    async () => (++attempts < 3 ? "crc=ab NO\nt=5000" : valid),
    async () => {},
  );
  assert.equal(r.retries, 2);
  assert.equal(r.celsius, 0);
  await assert.rejects(
    readTemperature(
      "test",
      async () => "crc=ab NO\nt=5000",
      async () => {},
    ),
    /3 nieudane/,
  );
});
