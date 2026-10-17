(function (root) {
  const defaults = () => ({
    wersja: 1,
    id: "domyslne",
    wlaczony: false,
    stopCm: 25,
    ostrzegaj: false,
    ostrzezenieCm: 50,
    resetId: "domyslne",
    zmieniono: 0,
    zmienil: "",
  });
  function validate(c) {
    if (!c || c.wersja !== 1 || typeof c.wlaczony !== "boolean" || typeof c.ostrzegaj !== "boolean")
      return "Nieprawidłowe ustawienia zabezpieczenia wody";
    for (const k of ["id", "resetId"])
      if (typeof c[k] !== "string" || c[k].length < 8 || c[k].length > 80) return "Nieprawidłowy identyfikator";
    if (!Number.isFinite(c.stopCm) || c.stopCm < 1 || c.stopCm > 245) return "Próg STOP: 1–245 cm";
    if (!Number.isFinite(c.ostrzezenieCm) || c.ostrzezenieCm < c.stopCm + 5 || c.ostrzezenieCm > 250)
      return "Ostrzeżenie musi być co najmniej 5 cm powyżej progu STOP (maks. 250 cm)";
    if (!Number.isFinite(c.zmieniono) || c.zmieniono < 0 || typeof c.zmienil !== "string" || c.zmienil.length > 200)
      return "Nieprawidłowe dane zapisu";
    if (Object.keys(c).some((k) => !(k in defaults()))) return "Nieznane pole ustawień";
    return null;
  }
  function level(s, now) {
    return s?.sondaPolaczona === true &&
      Number.isFinite(s.aktualizacjaPoziomu) &&
      now >= s.aktualizacjaPoziomu &&
      now - s.aktualizacjaPoziomu < 5000 &&
      Number.isFinite(s.poziomWodyProc) &&
      s.poziomWodyProc >= 0 &&
      s.poziomWodyProc <= 100
      ? s.poziomWodyProc * 2.5
      : null;
  }
  const api = Object.freeze({ defaults, validate, level });
  root.POMPA_WATER_SAFETY = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
