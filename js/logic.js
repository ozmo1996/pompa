// Czysta logika aplikacji — bez DOM i bez Firebase, dzięki czemu jest testowana jednostkowo (test/logic.test.js).
import "../config.js";

export const CFG = globalThis.POMPA_CONFIG;
const { silnik: M, progi: P } = CFG;

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** Liczba z pola formularza — akceptuje przecinek dziesiętny. Pusty tekst to NaN, nie 0. */
export const parseDecimal = (s) => {
  const t = String(s ?? "")
    .trim()
    .replace(",", ".");
  return t === "" ? NaN : Number(t);
};
export const round1 = (v) => Math.round(v * 10) / 10;

export const fmt = (v, suffix = "", digits = 1) =>
  isNum(v) ? v.toLocaleString("pl-PL", { maximumFractionDigits: digits }) + suffix : "—" + suffix;
export const f1 = (n) => Number(n).toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const signed1 = (d) => (d > 0 ? "+" : "") + f1(d);

/** Czy znacznik czasu jest świeży. Toleruje niewielkie przesunięcie zegara „w przyszłość”. */
export const isFresh = (t, now, maxAge = P.swiezoscStatusuMs) =>
  isNum(t) && t > 0 && now - t >= -P.tolerancjaPrzyszlosciMs && now - t < maxAge;

export function duration(ms) {
  if (!isNum(ms) || ms <= 0) return "—";
  const min = Math.round(ms / 60000);
  if (min < 60) return min + " min";
  const h = Math.floor(min / 60),
    m = min % 60;
  return h + " godz." + (m ? " " + m + " min" : "");
}

// ---------- pogoda ----------

/** Temperatura termometru mokrego (psychrometrycznie, nad lodem poniżej 0 °C). */
export function wetBulb(t, rh, p = P.cisnienieStacjiHpa) {
  if (!isNum(t) || !isNum(rh) || rh <= 0 || rh > 100) return null;
  const es = (x) =>
      x < 0 ? 6.112 * Math.exp((22.46 * x) / (272.62 + x)) : 6.112 * Math.exp((17.62 * x) / (243.12 + x)),
    e = (rh / 100) * 6.112 * Math.exp((17.62 * t) / (243.12 + t));
  let lo = t - 40,
    hi = t;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2,
      f = es(m) - (m < 0 ? 5.84e-4 : 6.62e-4) * p * (t - m) - e;
    if (f > 0) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}

const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function windDirection(deg) {
  if (!isNum(deg)) return "—";
  const d = ((deg % 360) + 360) % 360;
  return DIRS[Math.round(d / 22.5) % 16] + " · " + Math.round(deg) + "°";
}

/** Czas pomiaru pogody — Raspberry zapisuje `pobrano` albo `czasPomiaru`. */
export const weatherTime = (w) => Number(w?.pobrano || w?.czasPomiaru);

// ---------- falownik i moc ----------

export const estimatePowerKw = (u, i) => (Math.sqrt(3) * u * i * M.cosPhi) / 1000;

/** Moc z bieżącego statusu: odczyt falownika, szacunek z U·I albo 0 na postoju. */
export function powerReading(s) {
  if (isNum(s?.moc)) return { kw: s.moc, est: false };
  if (s?.pracuje && isNum(s.prad) && isNum(s.napiecie)) return { kw: estimatePowerKw(s.napiecie, s.prad), est: true };
  if (s?.polaczony && !s.pracuje) return { kw: 0, est: false };
  return null;
}

/** Moc z rekordu historii (inne nazwy pól niż w statusie). */
export function rowPower(r) {
  if (isNum(r?.moc)) return r.moc;
  if (r?.pracuje && isNum(r.prad) && isNum(r.napiecie)) return estimatePowerKw(r.napiecie, r.prad);
  return null;
}

/** Jednolity opis stanu napędu dla wszystkich zakładek. */
export function driveStateText(status, live) {
  if (!live || !status) return "Stan niepotwierdzony";
  if (!status.polaczony) return "Falownik niepołączony";
  if (status.awaria) return "Awaria falownika";
  return status.pracuje ? "Pompa pracuje" : "Pompa zatrzymana";
}

export const activeLimit = (cfg) => (cfg?.wlaczony && isNum(cfg.kw) ? cfg.kw : null);

/** Częstotliwość, którą użytkownik faktycznie zadał (gdy limit mocy obniżył pracę — cel sprzed obniżenia). */
export function currentSetpoint(s) {
  if (s?.limitAktywny === true && isNum(s.czestotliwoscCel)) return s.czestotliwoscCel;
  return isNum(s?.czestotliwoscZadana) ? s.czestotliwoscZadana : null;
}

/** Prognoza mocy po zmianie częstotliwości (prawo podobieństwa pomp: P ~ f³). */
export function predictKw(status, live, hz) {
  if (!live || status?.pracuje !== true) return null;
  const f = Number(status.czestotliwoscWyjsciowa),
    p = powerReading(status);
  if (!p || !(f >= 10) || !(p.kw > 1)) return null;
  return { kw: p.kw * (hz / f) ** 3, now: p.kw, f, est: p.est };
}

export function powerCap(limitCfg) {
  const lim = activeLimit(limitCfg);
  return {
    lim,
    cap: Math.min(lim ?? M.mocZnamionowaKw, M.mocZnamionowaKw),
    isLimit: lim !== null && lim <= M.mocZnamionowaKw,
  };
}

const nearCap = (pr, hz, cap) => !!pr && hz > pr.f && pr.kw >= cap * P.blizkoLimituMocy;

/** Ostrzeżenia przed zmianą częstotliwości pracującej pompy. */
export function analyzeChange({ status, live, hz, limitCfg }) {
  const items = [];
  if (!live || status?.pracuje !== true) return { items, hot: false };
  const ref = Number(status.czestotliwoscZadana);
  if (Number.isFinite(ref)) {
    const d = round1(hz - ref);
    if (Math.abs(d) > P.ostrzezenieSkokuHz)
      items.push({
        hot: true,
        t: `Duża zmiana: ${signed1(d)} Hz`,
        d:
          `Z ${f1(ref)} Hz na ${f1(hz)} Hz (próg ostrzeżenia ${P.ostrzezenieSkokuHz} Hz). ` +
          (d > 0
            ? "Gwałtowny wzrost ciśnienia w rurociągu i poboru mocy."
            : "Spadek ciśnienia — armatki mogą zejść poniżej ciśnienia roboczego."),
      });
  }
  const pr = predictKw(status, live, hz),
    { lim, cap, isLimit } = powerCap(limitCfg);
  if (nearCap(pr, hz, cap))
    items.push({
      hot: true,
      t:
        (pr.kw >= cap ? "Przekroczenie " : "Na granicy ") +
        (isLimit ? `limitu mocy ${lim} kW` : `mocy znamionowej silnika ${M.mocZnamionowaKw} kW`),
      d:
        `Teraz ${fmt(pr.now, " kW")} przy ${f1(pr.f)} Hz → prognoza ≈ ${fmt(pr.kw, " kW", 0)} przy ${f1(hz)} Hz` +
        (pr.est ? " (moc szacowana z prądu i napięcia)" : "") +
        ". " +
        (isLimit
          ? "Automatyczny limit obniży częstotliwość, więc pompa może nie osiągnąć zadanej wartości."
          : lim === null
            ? "Automatyczny limit mocy jest wyłączony — nic nie ograniczy obciążenia."
            : `Limit ${lim} kW jest ustawiony powyżej mocy znamionowej.`),
    });
  return { items, hot: items.some((i) => i.hot) };
}

/** Podgląd pod suwakiem częstotliwości. */
export function changePreview({ status, live, hz, limitCfg }) {
  if (!live || !status?.polaczony || !Number.isFinite(hz)) return { text: "", warn: false };
  if (status.pracuje !== true)
    return { text: "Pompa zatrzymana — ta wartość zostanie użyta przy starcie.", warn: false };
  const ref = Number(status.czestotliwoscZadana),
    d = round1(hz - ref),
    pr = predictKw(status, live, hz),
    { lim, cap } = powerCap(limitCfg),
    parts = [];
  if (Number.isFinite(ref)) parts.push(`Teraz ${f1(ref)} Hz`, `zmiana ${signed1(d)} Hz`);
  if (pr) parts.push(`prognoza ≈ ${fmt(pr.kw, " kW", 0)}` + (lim !== null ? ` (limit ${lim} kW)` : ""));
  return { text: parts.join(" · "), warn: Math.abs(d) > P.ostrzezenieSkokuHz || nearCap(pr, hz, cap) };
}

/** Walidacja ustawień limitu mocy z formularza. Zwraca {cfg} albo {error, field}. */
export function validateLimit({ on, kw, minHz }) {
  const { limitKwMin: lo, limitKwMax: hi } = CFG.limity;
  if (!Number.isFinite(kw) || kw < lo || kw > hi)
    return { error: `Podaj limit mocy od ${lo} do ${hi} kW.`, field: "limitKw" };
  if (!Number.isFinite(minHz) || minHz < 0 || minHz > M.maxHz)
    return { error: `Podaj najniższą częstotliwość od 0 do ${M.maxHz} Hz.`, field: "limitMinHz" };
  return { cfg: { wlaczony: !!on, kw: Math.round(kw), minHz: round1(minHz) } };
}

/** Walidacja częstotliwości do polecenia. Zwraca liczbę (0,1 Hz) albo null. */
export function validHz(v) {
  const hz = typeof v === "number" ? v : parseDecimal(v);
  return Number.isFinite(hz) && hz >= 0 && hz <= M.maxHz ? round1(hz) : null;
}

/** Cyfry licznika energii: 6 pozycji, wiodące zera oznaczone jako „lead”. */
export function energyDigits(e) {
  if (!isNum(e)) return [..."------"].map((d) => ({ d, lead: true }));
  const s = String(Math.max(0, Math.floor(e))).padStart(6, "0"),
    first = s.search(/[1-9]/),
    sig = first < 0 ? s.length - 1 : first;
  return [...s].map((d, i) => ({ d, lead: i < sig }));
}

// ---------- historia ----------

/** Wykrywa cykle napełniania/opróżniania zbiornika z kolejnych próbek poziomu. */
export function cyclesFrom(rows, { minStep = 0.3, minChange = 1, minMs = 60000, maxGapMs = 15 * 60000 } = {}) {
  const result = [],
    keep = (c) => c && Math.abs(c.endLevel - c.startLevel) >= minChange && c.end - c.start >= minMs;
  let cycle = null;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1],
      b = rows[i];
    if (!isNum(a.poziom) || !isNum(b.poziom) || b.czas - a.czas > maxGapMs) continue;
    const delta = b.poziom - a.poziom,
      dir = delta >= minStep ? "up" : delta <= -minStep ? "down" : null;
    if (!dir || cycle?.dir !== dir) {
      if (keep(cycle)) result.push(cycle);
      cycle = dir ? { dir, start: a.czas, end: b.czas, startLevel: a.poziom, endLevel: b.poziom } : null;
    } else {
      cycle.end = b.czas;
      cycle.endLevel = b.poziom;
    }
  }
  if (keep(cycle)) result.push(cycle);
  return result;
}

/** Scala posortowane rekordy historii (po `czas`), bez duplikatów. */
export function mergeRows(a, b) {
  if (!b.length) return a;
  if (!a.length) return b;
  const out = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i],
      y = b[j];
    const next = y === undefined || (x !== undefined && x.czas <= y.czas) ? a[i++] : b[j++];
    if (out.length && out.at(-1).czas === next.czas) out[out.length - 1] = next;
    else out.push(next);
  }
  return out;
}

/** Indeks pierwszego rekordu z czas >= t (rekordy posortowane). */
export function lowerBound(rows, t) {
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (rows[m].czas < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Krok osi wykresu: 1, 2, 2,5, 5 × 10^n. */
export function niceStep(x) {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const e = 10 ** Math.floor(Math.log10(x)),
    f = x / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

// ---------- alarmy ----------

export const ALARM_LEVELS = { awaria: "Awaria", ostrzezenie: "Ostrzeżenie", info: "Informacja" };
export const needsReview = (a) => a.poziom !== "info" && (a.aktywny === true || !a.potwierdzono);
export const canAck = (a) => a.aktywny !== true && !a.potwierdzono && a.poziom !== "info";
export function filterAlarms(alarms, filter) {
  if (filter === "open") return alarms.filter(needsReview);
  if (filter === "all") return alarms;
  return alarms.filter((a) => a.poziom === filter);
}
