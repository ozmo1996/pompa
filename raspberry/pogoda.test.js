"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");

function fixture(files = new Map([["/test/key", "secret"]])) {
  let time = 1000000000000,
    tick,
    responseStatus = 200,
    requests = 0;
  const data = [],
    statuses = [];
  const context = {
    require: (name) =>
      name === "node:path"
        ? require(name)
        : {
            readFileSync: (p) => {
              if (!files.has(p)) throw Error("ENOENT");
              return files.get(p);
            },
            writeFileSync: (p, value) => files.set(p, value),
            renameSync: (from, to) => {
              files.set(to, files.get(from));
              files.delete(from);
            },
          },
    module: { exports: {} },
    Date: class extends Date {
      static now() {
        return time;
      }
    },
    URLSearchParams,
    AbortSignal,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
    fetch: async () => {
      requests++;
      return {
        ok: responseStatus === 200,
        status: responseStatus,
        headers: { get: () => null },
        text: async () => "API key is throttled",
        json: async () => ({
          observations: [
            {
              stationID: "IBYSTR6",
              epoch: time / 1000,
              humidity: 80 + requests,
              metric: { temp: requests, pressure: 940 + requests, windSpeed: requests },
            },
          ],
        }),
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("./pogoda"), "utf8"), context);
  const module = context.module.exports;
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    files,
    data,
    statuses,
    module,
    flush,
    begin: () =>
      module.start(
        { pogoda: { plikKlucza: "/test/key" }, firebase: { sciezka: "pompa" } },
        async (v) => data.push(structuredClone(v)),
        () => {},
        { ref: () => ({ update: async (v) => statuses.push(v) }) },
      ),
    advance: async (minutes) => {
      time = 1000000000000 + minutes * 60000;
      tick();
      await flush();
    },
    setStatus: (value) => {
      responseStatus = value;
    },
    requests: () => requests,
  };
}

test("Pogoda: temperatura/wilgotność co 3 min, pozostałe co 10 min, wspólne pobranie", async () => {
  const f = fixture();
  f.begin();
  await f.flush();
  assert.equal(f.requests(), 1);
  assert.equal(f.data[0].temperatura, 1);
  await f.advance(2);
  assert.equal(f.requests(), 1);
  await f.advance(3);
  assert.equal(f.data.at(-1).temperatura, 2);
  assert.equal(f.data.at(-1).cisnienie, 941);
  await f.advance(6);
  await f.advance(9);
  const tempAt9 = f.data.at(-1).temperatura;
  await f.advance(10);
  assert.equal(f.data.at(-1).temperatura, tempAt9);
  assert.equal(f.data.at(-1).cisnienie, 945);
  assert.equal(f.data.at(-1).pobranoTemperatura, 1000000000000 + 9 * 60000);
  await f.advance(12);
  await f.advance(15);
  await f.advance(18);
  await f.advance(20);
  await f.advance(21);
  await f.advance(24);
  await f.advance(27);
  await f.advance(30);
  assert.equal(f.requests(), 13);
  assert.equal(f.data.at(-1).pobranoTemperatura, f.data.at(-1).pobranoPozostale);
});

test("Pogoda: blokada API odsuwa ponowienie o 30 min i zachowuje harmonogram po restarcie", async () => {
  const f = fixture();
  f.setStatus(401);
  f.begin();
  await f.flush();
  assert.equal(f.requests(), 1);
  await f.advance(3);
  await f.advance(10);
  await f.advance(29);
  assert.equal(f.requests(), 1);
  assert.match(f.statuses.at(-1).blad, /Limit zapytań/);
  const g = fixture(f.files);
  g.setStatus(401);
  g.begin();
  await g.flush();
  assert.equal(g.requests(), 0);
  await g.advance(30);
  assert.equal(g.requests(), 1);
});

test("Pogoda: null w odpowiedzi nie jest pomiarem zera", () => {
  const f = fixture();
  const data = f.module.mapujPomiar({ metric: { temp: null }, humidity: null }, "IBYSTR6");
  assert.equal(data.temperatura, null);
  assert.equal(data.wilgotnosc, null);
});
