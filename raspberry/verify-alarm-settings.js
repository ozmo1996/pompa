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
  let next = { ...config, id: crypto.randomUUID(), zmieniono: Date.now(), zmienil: user.email };
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
  if (process.argv.includes("--custom")) {
    const before = await fetch(url, { headers: { "X-Firebase-ETag": "true" } });
    const baseline = await before.json();
    if (!before.ok || baseline.id !== next.id || !before.headers.get("etag"))
      throw new Error("Przerwano test własnego alertu: równoległa zmiana lub brak ETag.");
    const slot = Array.from({ length: 30 }, (_, i) => "rule_" + (i + 1)).find((k) => !baseline.wlasne?.[k]);
    if (!slot) throw new Error("Brak wolnego miejsca na wyłączoną regułę testową.");
    const candidate = {
      ...baseline,
      id: crypto.randomUUID(),
      zmieniono: Date.now(),
      wlasne: {
        ...baseline.wlasne,
        [slot]: {
          tytul: "Kontrola zapisu (wyłączona)",
          pomiar: "nd20.napiecieL1L2",
          operator: "lt",
          prog: 380,
          tylkoPraca: false,
          wlaczony: false,
          poziom: "ostrzezenie",
          push: false,
          opoznienieS: 20,
          zakonczenieS: 60,
        },
      },
    };
    const testWrite = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "if-match": before.headers.get("etag"),
        "X-Firebase-ETag": "true",
      },
      body: JSON.stringify(candidate),
    });
    if (!testWrite.ok) throw new Error("Zapis własnej reguły: " + testWrite.status);
    const restore = { ...baseline, id: crypto.randomUUID(), zmieniono: Date.now() };
    if (!testWrite.headers.get("etag"))
      throw new Error("Brak ETag po zapisie reguły — nie nadpisano możliwych równoległych zmian.");
    const restored = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "if-match": testWrite.headers.get("etag") },
      body: JSON.stringify(restore),
    });
    if (!restored.ok) throw new Error("Przywrócenie po teście: " + restored.status);
    next = restore;
    console.log("WLASNA_REGULA_ZAPIS_OK_PRZYWROCONO_USTAWIENIA");
  }
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
