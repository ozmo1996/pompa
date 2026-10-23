(function (root) {
  const defaults = () => ({
    wersja: 1,
    id: "domyslne",
    wlaczony: false,
    bar: 25,
    minHz: 0,
    maxHz: 50,
    maxBar: 32,
    zmieniono: 0,
    zmienil: "",
  });
  function validate(c) {
    if (
      !c ||
      c.wersja !== 1 ||
      typeof c.wlaczony !== "boolean" ||
      typeof c.id !== "string" ||
      c.id.length < 8 ||
      c.id.length > 80
    )
      return "Nieprawidłowy format ustawień";
    for (const k of ["bar", "minHz", "maxHz", "maxBar", "zmieniono"])
      if (typeof c[k] !== "number" || !Number.isFinite(c[k])) return "Nieprawidłowa liczba: " + k;
    if (c.bar < 5 || c.bar > 30) return "Ciśnienie zadane: 5–30 bar";
    if (c.minHz < 0 || c.maxHz > 50 || c.minHz >= c.maxHz) return "Zakres: 0 ≤ min Hz < max Hz ≤ 50";
    if (c.maxBar < c.bar + 2 || c.maxBar > 32) return "Próg STOP: co najmniej 2 bar ponad celem, maksymalnie 32 bar";
    if (c.zmieniono < 0 || typeof c.zmienil !== "string" || c.zmienil.length > 200) return "Nieprawidłowe dane zapisu";
    const keys = Object.keys(defaults());
    if (Object.keys(c).some((k) => !keys.includes(k))) return "Nieznane pole ustawień";
    return null;
  }
  const api = Object.freeze({ defaults, validate, pressureAgeMs: 3000, backendAgeMs: 5000 });
  root.POMPA_PRESSURE_CONTROL = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
