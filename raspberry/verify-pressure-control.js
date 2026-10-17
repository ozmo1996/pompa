"use strict";
// Sprawdza zapis uprawnionego właściciela i walidację, NIGDY nie włącza regulatora.
const admin = require("firebase-admin"),
  crypto = require("node:crypto");
async function verify() {
  const service = require(process.env.SERVICE_ACCOUNT || "/home/pi/pompa-alarmy/serviceAccount.json");
  const base = "https://pompa-bdd30-default-rtdb.europe-west1.firebasedatabase.app";
  admin.initializeApp({ credential: admin.credential.cert(service), databaseURL: base });
  const user = await admin.auth().getUserByEmail("wojciech.osmelak@gmail.com");
  if (
    (
      await admin
        .database()
        .ref("uprawnieni/" + user.uid)
        .get()
    ).val() !== true
  )
    throw new Error("Brak uprawnień");
  const custom = await admin.auth().createCustomToken(user.uid);
  const response = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=AIzaSyC7jEuVnRgWDx6RpE_hc_rQ5udomIYkmtU",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: custom, returnSecureToken: true }),
    },
  );
  if (!response.ok) throw new Error("Logowanie: " + response.status);
  const token = (await response.json()).idToken,
    url = base + "/pompa/ustawienia/regulatorCisnienia.json?auth=" + encodeURIComponent(token);
  const read = await fetch(url, { headers: { "X-Firebase-ETag": "true" } });
  if (!read.ok) throw new Error("Odczyt: " + read.status);
  const cfg = await read.json();
  if (cfg.wlaczony !== false) throw new Error("Regulator włączony — test przerwany bez zmian");
  const next = { ...cfg, id: crypto.randomUUID(), zmieniono: Date.now(), zmienil: user.email };
  const headers = { "Content-Type": "application/json" };
  if (read.headers.get("etag")) headers["if-match"] = read.headers.get("etag");
  const write = await fetch(url, { method: "PUT", headers, body: JSON.stringify(next) });
  if (!write.ok) throw new Error("Zapis: " + write.status);
  const bad = await fetch(base + "/pompa/ustawienia/regulatorCisnienia/maxBar.json?auth=" + encodeURIComponent(token), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: "99",
  });
  if (![401, 403].includes(bad.status)) throw new Error("Błędny próg nie został odrzucony: " + bad.status);
  const after = await fetch(url);
  const saved = await after.json();
  if (saved.maxBar !== cfg.maxBar || saved.wlaczony !== false) throw new Error("Nieoczekiwana zmiana ustawień");
  const start = Date.now();
  let backend;
  while (Date.now() - start < 12000) {
    backend = (await admin.database().ref("pompa/statusRegulatoraCisnienia").get()).val();
    if (backend?.ustawieniaId === next.id) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (backend?.ustawieniaId !== next.id || backend.wlaczony !== false) throw new Error("Brak potwierdzenia Raspberry");
  console.log("PRESSURE_OWNER_WRITE_OK; BAD_THRESHOLD_REJECTED; RASPBERRY_ACK_OK; wlaczony=false");
  await admin.app().delete();
}
verify().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
