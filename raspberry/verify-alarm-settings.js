"use strict";
// Kontrola zapisu z uprawnieniami właściciela. Zachowuje wszystkie wartości;
// aktualizuje tylko identyfikator i metadane zapisu. Nie tworzy alarmu testowego.
const admin = require("firebase-admin");
const crypto = require("node:crypto");
const schema = require("./alarm-schema");
const base = "https://pompa-bdd30-default-rtdb.europe-west1.firebasedatabase.app";
async function verify() {
  admin.initializeApp({ credential: admin.credential.cert(require("./serviceAccount.json")), databaseURL: base });
  const user = await admin.auth().getUserByEmail("wojciech.osmelak@gmail.com");
  if (
    (
      await admin
        .database()
        .ref("uprawnieni/" + user.uid)
        .get()
    ).val() !== true
  )
    throw new Error("Konto nieuprawnione.");
  const custom = await admin.auth().createCustomToken(user.uid);
  const auth = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=AIzaSyC7jEuVnRgWDx6RpE_hc_rQ5udomIYkmtU",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: custom, returnSecureToken: true }),
    },
  );
  if (!auth.ok) throw new Error("Logowanie testowe: " + auth.status);
  const token = (await auth.json()).idToken;
  const url = base + "/pompa/ustawienia/alarmy.json?auth=" + encodeURIComponent(token);
  const read = await fetch(url, { headers: { "X-Firebase-ETag": "true" } });
  if (!read.ok) throw new Error("Odczyt użytkownika: " + read.status);
  const current = await read.json(),
    config = current || schema.defaults();
  const validation = schema.validate(config);
  if (validation) throw new Error(validation);
  const next = { ...config, id: crypto.randomUUID(), zmieniono: Date.now(), zmienil: user.email };
  const headers = { "Content-Type": "application/json" };
  if (read.headers.get("etag")) headers["if-match"] = read.headers.get("etag");
  const write = await fetch(url, { method: "PUT", headers, body: JSON.stringify(next) });
  if (!write.ok) throw new Error("Zapis użytkownika: " + write.status + " " + (await write.text()).slice(0, 200));
  console.log("ZAPIS_KONTA_OK", Object.keys(next.reguly).length, "reguł");
  const bad = await fetch(base + "/pompa/ustawienia/alarmy/progi/poziomNiski.json?auth=" + encodeURIComponent(token), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "101",
  });
  if (![401, 403].includes(bad.status)) throw new Error("Błędny próg nie został odrzucony: " + bad.status);
  const unchanged = await fetch(url);
  if (!unchanged.ok || (await unchanged.json()).progi.poziomNiski !== next.progi.poziomNiski)
    throw new Error("Zapisany próg zmienił się podczas negatywnego testu.");
  console.log("BLEDNY_PROG_ODRZUCONY");
  for (let i = 0; i < 10; i++) {
    const applied = (await admin.database().ref("pompa/statusAlarmow").get()).val();
    if (applied?.ustawieniaId === next.id && Date.now() - applied.aktualizacja < 90000) {
      console.log("RASPBERRY_ZASTOSOWALO_USTAWIENIA", applied.wersja);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Brak potwierdzenia nowych ustawień z Raspberry.");
}
if (require.main === module)
  verify()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
