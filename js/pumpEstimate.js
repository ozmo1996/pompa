import { isFresh } from "./logic.js";
// Przybliżone punkty odczytane ze zdjęcia charakterystyki 65YSm-8 użytkownika.
// Q [m³/h], H [m], P na wale [kW], krzywa odniesienia 50 Hz / około 2960 obr./min.
export const PUMP_CURVE = Object.freeze(
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
export function estimatePump(s, time, inletBar = 0) {
  const no = (reason) => ({ q: null, reason });
  if (!s?.polaczony || !isFresh(s.aktualizacja, time, 15000)) return no("Brak świeżych danych falownika");
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
    p50 = (kw * 0.947) / r ** 3;
  // Nie ekstrapolujemy krzywej, nie mylimy 90 kW znamionowych silnika z poborem pompy.
  if (p50 < PUMP_CURVE[0][2] || p50 > PUMP_CURVE.at(-1)[2])
    return no("Moc po przeliczeniu na 50 Hz jest poza zakresem dostarczonego wykresu");
  const i = PUMP_CURVE.findIndex((v) => v[2] >= p50),
    b = PUMP_CURVE[Math.max(1, i)],
    a = PUMP_CURVE[Math.max(1, i) - 1];
  const x = (p50 - a[2]) / (b[2] - a[2]),
    q50 = a[0] + x * (b[0] - a[0]);
  const head = (a[1] + x * (b[1] - a[1])) * r ** 2,
    measured = ((p.bar - inletBar) * 100000) / (1000 * 9.80665);
  if (Math.abs(head - measured) / head > 0.2)
    return no(
      "Ciśnienie i moc nie zgadzają się z charakterystyką (różnica H ponad 20%). Sprawdź ciśnienie na ssaniu i pomiary",
    );
  return {
    q: q50 * r,
    rpm: 2960 * r,
    head,
    reason: "Szacunek z krzywej P–Q i Hz; ciśnienie potwierdza zgodność H (tolerancja 20%, nie dokładność przepływu)",
  };
}
