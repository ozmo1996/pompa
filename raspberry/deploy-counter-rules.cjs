"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { buildCounterRules } = require("./counter-rules");
async function deploy() {
  const service = JSON.parse(
    fs.readFileSync(process.env.SERVICE_ACCOUNT || "/home/pi/pompa-alarmy/serviceAccount.json", "utf8"),
  );
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
  const assertion =
    claim + "." + crypto.sign("RSA-SHA256", Buffer.from(claim), service.private_key).toString("base64url");
  const oauth = await fetch(service.token_uri, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!oauth.ok) throw new Error("OAuth: " + oauth.status);
  const headers = { Authorization: "Bearer " + (await oauth.json()).access_token };
  const url = "https://pompa-bdd30-default-rtdb.europe-west1.firebasedatabase.app/.settings/rules.json";
  const response = await fetch(url, { headers: { ...headers, "X-Firebase-ETag": "true" } });
  if (!response.ok) throw new Error("Odczyt reguł: " + response.status);
  const current = await response.json();
  if (!current.rules?.pompa?.ustawienia || current.rules.pompa[".write"] || current.rules.pompa.ustawienia[".write"])
    throw new Error("Nieoczekiwane reguły — przerwano");
  if (process.argv[2] !== "--apply") {
    console.log("COUNTER_RULES", !!current.rules.pompa.ustawienia.liczniki);
    return;
  }
  const backup = path.join(__dirname, "rules-before-counters-" + Date.now() + ".json");
  fs.writeFileSync(backup, JSON.stringify(current, null, 2), { mode: 0o600 });
  const proposed = structuredClone(current);
  proposed.rules.pompa.ustawienia.liczniki = buildCounterRules();
  const etag = response.headers.get("etag");
  if (etag) headers["if-match"] = etag;
  else {
    const again = await fetch(url, { headers });
    if (!again.ok || JSON.stringify(await again.json()) !== JSON.stringify(current))
      throw new Error("Reguły zmieniono w trakcie wdrożenia");
  }
  const write = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(proposed),
  });
  if (!write.ok) throw new Error("Zapis reguł: " + write.status + " " + (await write.text()).slice(0, 400));

  const verify = await fetch(url, { headers: { Authorization: headers.Authorization } });
  if (
    !verify.ok ||
    !require("node:util").isDeepStrictEqual(
      (await verify.json()).rules?.pompa?.ustawienia?.liczniki,
      buildCounterRules(),
    )
  )
    throw Error("Weryfikacja reguł nie powiodła się");
  console.log("COUNTER_RULES_OK backup=" + backup);
}
deploy().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
