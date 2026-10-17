const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createGateway } = require("./camera-gateway.js");

const origin = "https://ozmo1996.github.io",
  token = "a".repeat(40);
const headers = { Origin: origin, Authorization: "Bearer " + token };
const mime = 'video/mp4; codecs="avc1.42E01E"';
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });

test("kamera: domyślna odmowa, brak API administracji i brak dowolnego źródła", async () => {
  let calls = 0;
  const server = createGateway({
    authorize: async () => {
      calls++;
      return null;
    },
    streamUrl: "http://127.0.0.1:1984/api/stream.mp4?src=kamera_test",
    mime,
    allowedOrigin: origin,
  });
  const base = await listen(server);
  try {
    assert.equal((await fetch(base + "/stream")).status, 403);
    assert.equal((await fetch(base + "/stream", { headers: { Origin: origin } })).status, 401);
    assert.equal((await fetch(base + "/api/config", { headers })).status, 404);
    assert.equal((await fetch(base + "/stream?src=exec:evil", { headers })).status, 404);
    assert.equal((await fetch(base + "/stream", { method: "POST", headers })).status, 404);
    assert.equal(calls, 0);
    assert.equal((await fetch(base + "/stream", { headers })).status, 403);
    assert.equal(calls, 1);
    const options = await fetch(base + "/stream", { method: "OPTIONS", headers: { Origin: origin } });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-origin"), origin);
  } finally {
    await close(server);
  }
});

test("kamera: uprawnienia przed strumieniem, przekazanie obrazu bez cache", async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCalls++;
    assert.equal(req.url, "/api/stream.mp4?src=kamera_test");
    res.end("testowe bajty MP4");
  });
  const upstreamBase = await listen(upstream);
  const server = createGateway({
    authorize: async (value) => (value === token ? { uid: "uprawniony", exp: Date.now() / 1000 + 100 } : null),
    streamUrl: upstreamBase + "/api/stream.mp4?src=kamera_test",
    mime,
    allowedOrigin: origin,
  });
  const base = await listen(server);
  try {
    assert.equal(
      (await fetch(base + "/stream", { headers: { ...headers, Authorization: "Bearer " + "b".repeat(40) } })).status,
      403,
    );
    assert.equal(upstreamCalls, 0);
    const response = await fetch(base + "/stream", { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), mime);
    assert.equal(await response.text(), "testowe bajty MP4");
    assert.equal(upstreamCalls, 1);
  } finally {
    await close(server);
    await close(upstream);
  }
});

test("kamera: wygasły token, błędy logowania i niedozwolona konfiguracja", async () => {
  assert.throws(() => createGateway({ streamUrl: "http://192.168.1.168/api/stream.mp4", mime }), /lokalnym/);
  assert.throws(() => createGateway({ streamUrl: "http://127.0.0.1:1984/api/config", mime }), /lokalnym/);
  assert.throws(() => createGateway({ streamUrl: "http://127.0.0.1:1984/api/stream.mp4", mime: "text/html" }), /H.264/);
  for (const authorize of [
    async () => ({ exp: 1 }),
    async () => {
      throw new Error("SECRET_TOKEN_MUST_NOT_LEAK");
    },
  ]) {
    const server = createGateway({
      authorize,
      streamUrl: "http://127.0.0.1:1984/api/stream.mp4",
      mime,
      allowedOrigin: origin,
    });
    const base = await listen(server);
    try {
      const response = await fetch(base + "/stream", { headers });
      assert.equal(response.status, 403);
      assert.equal(await response.text(), "");
    } finally {
      await close(server);
    }
  }
});

test("kamera: limit klientów obejmuje weryfikację uprawnień", async () => {
  let release;
  const server = createGateway({
    authorize: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    streamUrl: "http://127.0.0.1:1984/api/stream.mp4",
    mime,
    allowedOrigin: origin,
    maxClients: 1,
  });
  const base = await listen(server);
  try {
    const first = fetch(base + "/stream", { headers });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await fetch(base + "/stream", { headers })).status, 429);
    release(null);
    assert.equal((await first).status, 403);
  } finally {
    await close(server);
  }
});
