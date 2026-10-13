"use strict";
const { PROGI, RULES, METRICS } = require("./alarm-schema");
const allowed = "auth != null && root.child('uprawnieni').child(auth.uid).val() === true";
const levels =
  "newData.val() === 'info' || newData.val() === 'ostrzezenie' || newData.val() === 'awaria' || newData.val() === 'auto'";
const range = (min, max) => ({
  ".validate": `newData.isNumber() && newData.val() >= ${min} && newData.val() <= ${max}`,
});
const has = (keys) => `newData.hasChildren(${JSON.stringify(keys)})`;
function rule(extra = {}) {
  const children = {
    wlaczony: { ".validate": "newData.isBoolean()" },
    poziom: { ".validate": levels },
    push: { ".validate": "newData.isBoolean()" },
    opoznienieS: range(0, 7200),
    zakonczenieS: range(0, 7200),
    ...extra,
  };
  return { ".validate": has(Object.keys(children)), ...children, $other: { ".validate": false } };
}
function buildAlarmRules() {
  const progi = Object.fromEntries(Object.entries(PROGI).map(([key, p]) => [key, range(p.min, p.max)]));
  const fields = Object.fromEntries(
    Object.entries(METRICS).map(([key, m]) => [
      key.replaceAll(".", "_"),
      `(newData.child('pomiar').val() === '${key}' && newData.child('prog').val() >= ${m.min} && newData.child('prog').val() <= ${m.max})`,
    ]),
  );
  const custom = rule({
    tytul: { ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 100" },
    pomiar: { ".validate": "newData.isString()" },
    operator: { ".validate": "newData.val() === 'lt' || newData.val() === 'gt'" },
    prog: { ".validate": "newData.isNumber()" },
    tylkoPraca: { ".validate": "newData.isBoolean()" },
  });
  custom[".validate"] += " && (" + Object.values(fields).join(" || ") + ")";
  return {
    ".write": allowed,
    ".validate": has(["wersja", "id", "zmieniono", "zmienil", "progi", "reguly"]),
    wersja: { ".validate": "newData.val() === 1" },
    id: { ".validate": "newData.isString() && newData.val().matches(/^[a-zA-Z0-9_-]{1,80}$/)" },
    zmieniono: { ".validate": "newData.isNumber() && newData.val() >= now - 60000 && newData.val() <= now + 60000" },
    zmienil: { ".validate": "newData.isString() && newData.val().length <= 254" },
    progi: {
      ".validate":
        has(Object.keys(progi)) +
        " && newData.child('sondaMinMa').val() < newData.child('sondaMaxMa').val() && newData.child('poziomNiski').val() < newData.child('poziomWysoki').val() && newData.child('tempAwaria').val() <= newData.child('tempOstrzezenie').val()",
      ...progi,
      $other: { ".validate": false },
    },
    reguly: {
      ".validate": has(Object.keys(RULES)),
      ...Object.fromEntries(Object.keys(RULES).map((key) => [key, rule()])),
      $other: { ".validate": false },
    },
    wlasne: {
      $id: { ...custom, ".validate": custom[".validate"] + " && $id.matches(/^rule_([1-9]|[12][0-9]|30)$/)" },
    },
    $other: { ".validate": false },
  };
}
module.exports = { buildAlarmRules };
