"use strict";
const fs = require("node:fs"),
  crypto = require("node:crypto");
async function deploy() {
  const service = require(process.env.SERVICE_ACCOUNT || "/home/pi/pompa-alarmy/serviceAccount.json");
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url"),
    t = Math.floor(Date.now() / 1000);
  const claim =
    enc({ alg: "RS256", typ: "JWT" }) +
    "." +
    enc({
      iss: service.client_email,
      scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
      aud: service.token_uri,
      iat: t,
      exp: t + 3600,
    });
  const response = await fetch(service.token_uri, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: claim + "." + crypto.sign("RSA-SHA256", Buffer.from(claim), service.private_key).toString("base64url"),
    }),
  });
  if (!response.ok) throw Error("OAuth: " + response.status);
  const headers = { Authorization: "Bearer " + (await response.json()).access_token };
  const url = "https://pompa-bdd30-default-rtdb.europe-west1.firebasedatabase.app/.settings/rules.json";
  const r = await fetch(url, { headers: { ...headers, "X-Firebase-ETag": "true" } });
  if (!r.ok) throw Error("Odczyt reguł: " + r.status);
  const current = await r.json();
  if (!current.rules?.pompa?.ustawienia || current.rules.pompa[".write"] || current.rules.pompa.ustawienia[".write"])
    throw Error("Nieoczekiwane reguły — przerwano");
  if (process.argv[2] !== "--apply") {
    console.log("WATER_RULES", !!current.rules.pompa.ustawienia.zabezpieczenieWody);
    return;
  }
  const backup = __dirname + "/rules-before-water-safety-" + Date.now() + ".json";
  fs.writeFileSync(backup, JSON.stringify(current, null, 2), { mode: 0o600, flag: "wx" });
  const proposed = structuredClone(current);
  proposed.rules.pompa.ustawienia.zabezpieczenieWody = require("./water-safety-rules").buildWaterSafetyRules();
  const etag = r.headers.get("etag");
  if (!etag) throw Error("Brak ETag — przerwano, aby nie nadpisać równoległej zmiany");
  const write = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json", "if-match": etag },
    body: JSON.stringify(proposed),
  });
  if (!write.ok) throw Error("Zapis reguł: " + write.status);
  const admin = require("firebase-admin");
  admin.initializeApp({
    credential: admin.credential.cert(service),
    databaseURL: "https://pompa-bdd30-default-rtdb.europe-west1.firebasedatabase.app",
  });
  const ref = admin.database().ref("pompa/ustawienia/zabezpieczenieWody");
  await ref.transaction(
    (v) =>
      v ?? {
        ...require("./water-safety-schema").defaults(),
        id: "init-" + Date.now(),
        zmieniono: Date.now(),
        zmienil: "wdrożenie — wyłączone",
      },
  );
  console.log("WATER_RULES_OK backup=" + backup, "wlaczony=" + (await ref.get()).val().wlaczony);
  await admin.app().delete();
}
if (require.main === module)
  deploy().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
