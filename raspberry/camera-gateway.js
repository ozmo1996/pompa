// Osobna bramka tylko do odczytu. Nie importuje kodu sterowania pompą.
// Uruchomienie wymaga lokalnego go2rtc, danych Admin SDK i tunelu HTTPS.
const http = require("node:http");
const { Readable } = require("node:stream");

function createGateway({ authorize, streamUrl, mime, allowedOrigin, maxClients = 2, maxSessionMs = 15 * 60000 }) {
  const source = new URL(streamUrl);
  if (source.protocol !== "http:" || source.hostname !== "127.0.0.1" || source.pathname !== "/api/stream.mp4")
    throw new Error("Źródło musi być lokalnym strumieniem go2rtc, nie adresem podanym przez klienta.");
  if (!/^video\/mp4; codecs="avc1\.[a-fA-F0-9]{6}"$/.test(mime)) throw new Error("Wymagany dokładny kodek H.264.");
  let clients = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Vary", "Origin");
    if (req.headers.origin !== allowedOrigin) return res.writeHead(403).end();
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    if (req.method === "OPTIONS" && req.url === "/stream") {
      res.setHeader("Access-Control-Allow-Headers", "Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET");
      return res.writeHead(204).end();
    }
    if (req.method !== "GET" || req.url !== "/stream") return res.writeHead(404).end();
    const token = /^Bearer ([A-Za-z0-9._-]{20,8192})$/.exec(req.headers.authorization || "")?.[1];
    if (!token) return res.writeHead(401).end();
    // Rezerwujemy także autoryzowane połączenia w trakcie weryfikacji, bez nieograniczonej kolejki.
    if (clients >= maxClients) return res.writeHead(429).end();
    clients++;
    let body, timer;
    const abort = new globalThis.AbortController();
    const closed = () => {
      abort.abort();
      body?.destroy();
    };
    res.once("close", closed);
    try {
      const user = await authorize(token);
      if (abort.signal.aborted) return;
      if (!user || !Number.isFinite(user.exp) || user.exp * 1000 <= Date.now()) return res.writeHead(403).end();
      // Po wygaśnięciu tokenu/15 minutach sesja kończy się; ponowne uruchomienie wymaga weryfikacji.
      timer = setTimeout(closed, Math.min(maxSessionMs, user.exp * 1000 - Date.now()));
      const initialTimeout = setTimeout(closed, 10000);
      let upstream;
      try {
        upstream = await fetch(source, { signal: abort.signal, redirect: "error" });
      } finally {
        clearTimeout(initialTimeout);
      }
      if (!upstream.ok || !upstream.body) return res.writeHead(502).end();
      res.writeHead(200, { "Content-Type": mime });
      body = Readable.fromWeb(upstream.body);
      // pipe utrzymuje backpressure; nie przechowujemy całego filmu w pamięci.
      await new Promise((resolve, reject) => {
        body.once("error", reject);
        res.once("error", reject);
        res.once("close", resolve);
        body.once("end", resolve);
        body.pipe(res);
      });
    } catch {
      // Nie wypisujemy tokenu, URL źródła, hasła ani odpowiedzi kamery w logach.
      if (!res.headersSent && !res.destroyed) res.writeHead(403).end();
    } finally {
      clearTimeout(timer);
      closed();
      if (!res.writableEnded) res.end();
      clients--;
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.maxConnections = 8;
  return server;
}

if (require.main === module) {
  const fs = require("node:fs");
  const cfg = JSON.parse(
    fs.readFileSync(process.env.CAMERA_GATEWAY_CONFIG || "/home/pi/pompa-kamery-test/gateway.json", "utf8"),
  );
  // Wykorzystaj istniejący Admin SDK na Pi; nie kopiuj klucza do katalogu publikowanego na GitHubie.
  const admin = require(cfg.adminModule);
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(fs.readFileSync(cfg.serviceAccount, "utf8"))),
    databaseURL: cfg.databaseURL,
  });
  const authorize = async (token) => {
    const decoded = await admin.auth().verifyIdToken(token, true);
    const allowed = (
      await admin
        .database()
        .ref("uprawnieni/" + decoded.uid)
        .get()
    ).val();
    if (allowed !== true) return null;
    return decoded;
  };
  createGateway({ authorize, streamUrl: cfg.streamUrl, mime: cfg.mime, allowedOrigin: cfg.allowedOrigin }).listen(
    1986,
    "127.0.0.1",
    () => console.log("Bramka testowa kamer: tylko localhost:1986"),
  );
}

module.exports = { createGateway };
