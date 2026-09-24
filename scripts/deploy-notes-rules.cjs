// Updates only pompa/notatki in live Firebase RTDB rules, preserving other branches.
// Set FIREBASE_SERVICE_ACCOUNT_PATH and run with --inspect or --apply.
const crypto = require("node:crypto");
const fs = require("node:fs");

const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
if (!keyPath) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_PATH");
const service = JSON.parse(fs.readFileSync(keyPath, "utf8"));
const base = "https://pompa-bdd30-default-rtdb.europe-west1.firebasedatabase.app";
const ruleUrl = base + "/.settings/rules.json";
const allowed = "auth != null && root.child('uprawnieni').child(auth.uid).val() === true";
const notesRule = {
  ".indexOn": ["utworzono"],
  $id: {
    ".write": allowed,
    ".validate":
      "newData.hasChildren(['tytul','opis','utworzono','autorUid','wykonane','zmieniono']) && newData.child('tytul').isString() && newData.child('tytul').val().length > 0 && newData.child('tytul').val().length <= 120 && newData.child('opis').isString() && newData.child('opis').val().length <= 2000 && newData.child('utworzono').isNumber() && newData.child('utworzono').val() > 0 && newData.child('autorUid').isString() && newData.child('autorUid').val().length <= 128 && (!data.exists() ? newData.child('autorUid').val() === auth.uid : (newData.child('autorUid').val() === data.child('autorUid').val() && newData.child('utworzono').val() === data.child('utworzono').val())) && newData.child('wykonane').isBoolean() && newData.child('zmieniono').isNumber() && newData.child('zmieniono').val() > 0 && (!newData.child('termin').exists() || (newData.child('termin').isNumber() && newData.child('termin').val() > 0))",
    tytul: { ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 120" },
    opis: { ".validate": "newData.isString() && newData.val().length <= 2000" },
    utworzono: { ".validate": "newData.isNumber() && newData.val() > 0" },
    autorUid: { ".validate": "newData.isString() && newData.val().length <= 128" },
    wykonane: { ".validate": "newData.isBoolean()" },
    zmieniono: { ".validate": "newData.isNumber() && newData.val() > 0" },
    termin: { ".validate": "newData.isNumber() && newData.val() > 0" },
    $other: { ".validate": false },
  },
};

async function token() {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const t = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "RS256", typ: "JWT" });
  const claim = enc({
    iss: service.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: service.token_uri,
    iat: t,
    exp: t + 3600,
  });
  const plain = `${head}.${claim}`;
  const assertion = `${plain}.${crypto.sign("RSA-SHA256", Buffer.from(plain), service.private_key).toString("base64url")}`;
  const response = await fetch(service.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error("OAuth failed: " + response.status);
  return (await response.json()).access_token;
}

async function main() {
  const bearer = await token();
  const res = await fetch(ruleUrl, { headers: { Authorization: `Bearer ${bearer}`, "X-Firebase-ETag": "true" } });
  if (!res.ok) throw new Error("Rule read failed: " + res.status);
  const etag = res.headers.get("etag");
  const rules = await res.json();
  if (!rules?.rules?.pompa || rules.rules.pompa[".write"]) throw new Error("Unexpected rule structure");
  console.log("Existing notes rule:", rules.rules.pompa.notatki ? "present" : "absent");
  if (process.argv[2] !== "--apply") return;
  // The rules endpoint does not always return ETag. Recheck for concurrent edits
  // before replacing the complete rules document.
  if (!etag) {
    const again = await fetch(ruleUrl, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!again.ok || JSON.stringify(await again.json()) !== JSON.stringify(rules))
      throw new Error("Rules changed during update");
  }
  rules.rules.pompa.notatki = notesRule;
  const headers = { Authorization: `Bearer ${bearer}`, "content-type": "application/json" };
  if (etag) headers["if-match"] = etag;
  const update = await fetch(ruleUrl, { method: "PUT", headers, body: JSON.stringify(rules) });
  if (!update.ok) throw new Error("Rule update failed: " + update.status + " " + (await update.text()).slice(0, 300));
  const check = await fetch(ruleUrl, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!check.ok || !(await check.json())?.rules?.pompa?.notatki?.["$id"]?.[".write"])
    throw new Error("Note rule verification failed");
  console.log("Notes rule installed and verified");
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
