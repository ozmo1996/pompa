"use strict";
function buildWaterSafetyRules() {
  const num = (min, max) => ({
    ".validate": `newData.isNumber() && newData.val() >= ${min} && newData.val() <= ${max}`,
  });
  const id = { ".validate": "newData.isString() && newData.val().length >= 8 && newData.val().length <= 80" };
  return {
    ".read": "auth != null && root.child('uprawnieni').child(auth.uid).val() === true",
    ".write": "auth != null && root.child('uprawnieni').child(auth.uid).val() === true && newData.exists()",
    ".validate":
      "newData.hasChildren(['wersja','id','wlaczony','stopCm','ostrzegaj','ostrzezenieCm','resetId','zmieniono','zmienil']) && newData.child('ostrzezenieCm').val() >= newData.child('stopCm').val() + 5",
    wersja: { ".validate": "newData.val() === 1" },
    id,
    resetId: id,
    wlaczony: { ".validate": "newData.isBoolean()" },
    ostrzegaj: { ".validate": "newData.isBoolean()" },
    stopCm: num(1, 245),
    ostrzezenieCm: num(6, 250),
    zmieniono: num(0, 9999999999999),
    zmienil: { ".validate": "newData.isString() && newData.val().length <= 200" },
    $other: { ".validate": false },
  };
}
module.exports = { buildWaterSafetyRules };
