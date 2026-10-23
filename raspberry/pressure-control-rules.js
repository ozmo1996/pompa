"use strict";
function buildPressureControlRules() {
  const number = (lo, hi) => ({
    ".validate": `newData.isNumber() && newData.val() >= ${lo} && newData.val() <= ${hi}`,
  });
  return {
    ".read": "auth != null && root.child('uprawnieni').child(auth.uid).val() === true",
    ".write": "auth != null && root.child('uprawnieni').child(auth.uid).val() === true && newData.exists()",
    ".validate":
      "newData.hasChildren(['wersja','id','wlaczony','bar','minHz','maxHz','maxBar','zmieniono','zmienil']) && newData.child('minHz').val() < newData.child('maxHz').val() && newData.child('maxBar').val() >= newData.child('bar').val() + 2",
    wersja: { ".validate": "newData.val() === 1" },
    id: { ".validate": "newData.isString() && newData.val().length >= 8 && newData.val().length <= 80" },
    wlaczony: { ".validate": "newData.isBoolean()" },
    bar: number(5, 30),
    minHz: number(0, 49.9),
    maxHz: number(0.1, 50),
    maxBar: number(7, 32),
    zmieniono: number(0, 9999999999999),
    zmienil: { ".validate": "newData.isString() && newData.val().length <= 200" },
    $other: { ".validate": false },
  };
}
module.exports = { buildPressureControlRules };
