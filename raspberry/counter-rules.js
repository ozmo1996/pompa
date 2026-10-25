"use strict";
function buildCounterRules() {
  const allowed = "auth != null && root.child('uprawnieni').child(auth.uid).val() === true";
  return {
    ".read": allowed,
    ".write": allowed + " && newData.exists()",
    ".validate":
      "newData.hasChildren(['wersja','id','akcja','licznik','cisnienieSsaniaBar','zmieniono','autorUid','zmienil']) && ((newData.child('akcja').val() === 'zeruj' && newData.child('licznik').val() !== 'brak') || (newData.child('akcja').val() === 'konfiguracja' && newData.child('licznik').val() === 'brak'))",
    wersja: { ".validate": "newData.val() === 1" },
    id: { ".validate": "newData.isString() && newData.val().matches(/^[a-zA-Z0-9-]{8,80}$/)" },
    akcja: { ".validate": "newData.val() === 'zeruj' || newData.val() === 'konfiguracja'" },
    licznik: {
      ".validate":
        "newData.val() === 'pompaKwh' || newData.val() === 'agregatKwh' || newData.val() === 'wodaM3' || newData.val() === 'wszystkie' || newData.val() === 'brak'",
    },
    cisnienieSsaniaBar: { ".validate": "newData.isNumber() && newData.val() >= -1 && newData.val() <= 10" },
    zmieniono: { ".validate": "newData.isNumber() && newData.val() >= now - 120000 && newData.val() <= now + 1000" },
    autorUid: { ".validate": "newData.isString() && newData.val() === auth.uid" },
    zmienil: { ".validate": "newData.isString() && newData.val().length <= 200 && newData.val() === auth.token.email" },
    $other: { ".validate": false },
  };
}
module.exports = { buildCounterRules };
