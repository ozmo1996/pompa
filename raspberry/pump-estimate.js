// Wspólny model dla Raspberry i przeglądarki; żadne obliczenie nie steruje pompą.
(function (root, factory) {
  const api = factory();
  root.POMPA_PUMP_ESTIMATE = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function () {
  const isFresh = (t, now, age) => Number.isFinite(t) && t <= now + 1000 && now - t < age;
  // Przybliżone punkty odczytane ze zdjęcia charakterystyki 65YSm-8 użytkownika.
  // Q [m³/h], H [m], P na wale [kW], krzywa odniesienia 50 Hz / około 2960 obr./min.
  const PUMP_CURVE = Object.freeze(
    [
      [0, 360, 32],
      [8, 376, 38],
      [16, 382, 43],
      [24, 382, 48],
      [32, 371, 53],
      [40, 354, 58],
      [48, 329, 63],
      [56, 300, 68],
      [58, 292, 70],
    ].map(Object.freeze),
  );
  function estimateFromHead(measured, ratio, power50) {
    const head50 = measured / ratio ** 2;
    // Poniżej wysokości przy Q=0 krzywa H–Q ma tylko jedno przecięcie.
    if (head50 >= PUMP_CURVE[0][1] || head50 < PUMP_CURVE.at(-1)[1]) return null;
    const i = PUMP_CURVE.findIndex((point, index) => index >= 4 && point[1] <= head50);
    if (i < 1) return null;
    const a = PUMP_CURVE[i - 1],
      b = PUMP_CURVE[i],
      fraction = (a[1] - head50) / (a[1] - b[1]),
      expectedPower = a[2] + fraction * (b[2] - a[2]);
    if (Math.abs(power50 - expectedPower) / expectedPower > 0.2) return null;
    return {
      q: (a[0] + fraction * (b[0] - a[0])) * ratio,
      rpm: 2960 * ratio,
      head: measured,
      reason: "Szacunek z jednoznacznej krzywej H–Q i Hz; moc potwierdza zgodność (tolerancja 20%, nie dokładność przepływu)",
    };
  }
  function estimatePump(s, time, inletBar = 0) {
    const no = (reason) => ({ q: null, reason });
    if (!s?.polaczony || !isFresh(s.aktualizacja, time, 15000)) return no("Brak świeżych danych falownika");
    if (s.aktualizacjaFalownika !== undefined && !isFresh(s.aktualizacjaFalownika, time, 3000))
      return no("Nieaktualny pomiar falownika");
    if (s.pracuje !== true) return no("Pompa nie ma potwierdzonej pracy — brak szacunku przepływu");
    const hz = s.czestotliwoscWyjsciowa,
      kw = s.moc,
      p = s.cisnienieTloczenia;
    if (!Number.isFinite(hz) || hz < 10 || hz > 50 || !Number.isFinite(kw) || kw <= 0 || kw > 200)
      return no("Wymagane 10–50 Hz i prawidłowy odczyt mocy falownika");
    if (
      !p?.polaczony ||
      !isFresh(p.aktualizacja, time, 3000) ||
      !Number.isFinite(p.bar) ||
      p.bar < 0 ||
      p.bar > 40 ||
      !Number.isFinite(inletBar) ||
      inletBar < -1 ||
      inletBar > 10 ||
      p.bar - inletBar < 1
    )
      return no("Wymagane aktualne ciśnienie i różnica tłoczenie–ssanie co najmniej 1 bar");
    const r = hz / 50,
      p50 = (kw * 0.947) / r ** 3,
      measured = ((p.bar - inletBar) * 100000) / (1000 * 9.80665);
    // Nie ekstrapolujemy krzywej, nie mylimy 90 kW znamionowych silnika z poborem pompy.
    if (p50 < PUMP_CURVE[0][2] || p50 > PUMP_CURVE.at(-1)[2])
      return (
        estimateFromHead(measured, r, p50) ||
        no("Moc i ciśnienie po przeliczeniu na 50 Hz nie pozwalają oszacować przepływu z wykresu")
      );
    const i = PUMP_CURVE.findIndex((v) => v[2] >= p50),
      b = PUMP_CURVE[Math.max(1, i)],
      a = PUMP_CURVE[Math.max(1, i) - 1];
    const x = (p50 - a[2]) / (b[2] - a[2]),
      q50 = a[0] + x * (b[0] - a[0]);
    const head = (a[1] + x * (b[1] - a[1])) * r ** 2;
    if (Math.abs(head - measured) / head > 0.2)
      return (
        estimateFromHead(measured, r, p50) ||
        no("Ciśnienie i moc nie zgadzają się z charakterystyką. Sprawdź ciśnienie na ssaniu i pomiary")
      );
    return {
      q: q50 * r,
      rpm: 2960 * r,
      head,
      reason: "Szacunek z krzywej P–Q i Hz; ciśnienie potwierdza zgodność H (tolerancja 20%, nie dokładność przepływu)",
    };
  }
  return { PUMP_CURVE, estimatePump };
});
