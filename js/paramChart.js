// Wykresy podglądu: jedna lub dwie serie, osobne osie i wybrany okres historii.
import {
  CFG,
  fmt,
  isFresh,
  isNum,
  niceStep,
  powerReading,
  rowPower,
  waterVolumeM3,
  wetBulb,
  stationPressure,
  counterReading,
} from "./logic.js";
import { weatherHistory, workHistory } from "./history.js";
import { $, S, isLive, now, safe, user } from "./state.js";

const { silnik: M } = CFG,
  WIN = CFG.historia.oknoWykresuParametruMs,
  GAP = 5 * 60e3, // przerwa w danych dłuższa niż to przerywa linię
  COLORS = { Falownik: "#d6f48a", Zbiornik: "#4cc9e8", Pogoda: "#a9b8ff", Agregat: "#f0c995" },
  WARN = "#f0c995";
const pw = (r) => r?.pogoda || {};
const wb = (w) => wetBulb(w?.temperatura, w?.wilgotnosc, stationPressure(w));

/**
 * g — grupa, n — nazwa, u — jednostka, d — miejsca po przecinku, pole — nazwa pola w historii (do komunikatu),
 * get — wartość z rekordu historii, now — wartość z bieżącego statusu, lo/hi — zakres osi, span — minimalna rozpiętość,
 * refs — linie odniesienia.
 */
const meterParams = Object.fromEntries(
  [
    ["nd20Power", "mocKw", "Moc czynna agregatu", " kW"],
    ["nd20Hz", "czestotliwoscHz", "Częstotliwość agregatu", " Hz"],
    ["nd20U12", "napiecieL1L2", "Napięcie L1–L2", " V"],
    ["nd20U23", "napiecieL2L3", "Napięcie L2–L3", " V"],
    ["nd20U31", "napiecieL3L1", "Napięcie L3–L1", " V"],
    ["nd20I1", "pradL1", "Prąd L1", " A"],
    ["nd20I2", "pradL2", "Prąd L2", " A"],
    ["nd20I3", "pradL3", "Prąd L3", " A"],
  ].map(([key, field, n, u]) => [
    key,
    {
      g: "Agregat",
      n,
      u,
      d: 1,
      pole: `nd20.${field}`,
      get: (r) => r.nd20?.[field],
      now: (s) => (isFresh(s?.nd20?.aktualizacja, now(), 15000) && s.nd20.polaczony ? s.nd20[field] : null),
      timestamp: (s) => s?.nd20?.aktualizacja,
      span: 1,
    },
  ]),
);
const PARAMS = {
  ...meterParams,
  pompa: {
    g: "Falownik",
    n: "Praca pompy",
    u: "",
    d: 0,
    pole: "pracuje",
    get: (r) => (r.falownikPolaczony === true && typeof r.pracuje === "boolean" ? Number(r.pracuje) : null),
    now: (s) => (typeof s?.pracuje === "boolean" ? Number(s.pracuje) : null),
    lo: 0,
    hi: 1,
    step: 1,
    dots: true,
    note: "1 = pompa pracuje, 0 = zatrzymana. Brak łączności nie oznacza zatrzymania.",
  },
  tloczenie: {
    g: "Pomiar",
    n: "Ciśnienie tłoczenia",
    u: " bar",
    d: 1,
    pole: "cisnienieBar",
    get: (r) => r.cisnienieBar,
    now: (s) =>
      s?.cisnienieTloczenia?.polaczony === true && isFresh(s.cisnienieTloczenia.aktualizacja, now(), 3000)
        ? s.cisnienieTloczenia.bar
        : null,
    timestamp: (s) => s?.cisnienieTloczenia?.aktualizacja,
    lo: 0,
    span: 1,
    note: "Historia ciśnienia jest zapisywana tylko podczas pracy pompy.",
  },
  poziomCm: {
    g: "Zbiornik",
    n: "Wysokość słupa wody",
    u: " cm",
    d: 1,
    pole: "poziom",
    get: (r) => (isNum(r.poziom) ? (r.poziom * CFG.zbiornik.wysokoscCm) / 100 : null),
    now: (s) => (isNum(s?.poziomWodyProc) ? (s.poziomWodyProc * CFG.zbiornik.wysokoscCm) / 100 : null),
    lo: 0,
    hi: CFG.zbiornik.wysokoscCm,
  },
  przepompowane: {
    g: "Pomiar",
    n: "Przepompowana woda · licznik całkowity (szacunek)",
    u: " m³",
    d: 2,
    pole: "przepompowaneM3",
    get: (r) => r.przepompowaneM3,
    now: (s) => counterReading(s, "wodaM3")?.total,
    timestamp: (s) => s?.wydajnoscPompy?.ostatniPomiar,
    lo: 0,
    span: 1,
    note: "Wykres pokazuje sumę całkowitą. Zerowanie wskazania okresowego nie zmienia historii. Wartość szacowana, nie pomiar przepływomierzem.",
  },
  wydajnosc: {
    g: "Pomiar",
    n: "Szacowana wydajność pompy",
    u: " m³/h",
    d: 1,
    pole: "wydajnoscM3h",
    get: (r) => r.wydajnoscM3h,
    now: (s) => (isFresh(s?.wydajnoscPompy?.aktualizacja, now(), 3000) ? s?.wydajnoscPompy?.wydajnoscM3h : null),
    timestamp: (s) => s?.wydajnoscPompy?.aktualizacja,
    lo: 0,
    span: 1,
    note: "Szacunek z charakterystyki pompy; nie zastępuje przepływomierza.",
  },
  hz: {
    g: "Falownik",
    n: "Częstotliwość wyjściowa",
    u: " Hz",
    d: 1,
    pole: "hz",
    get: (r) => r.hz,
    now: (s) => s?.czestotliwoscWyjsciowa,
    lo: 0,
    hi: M.maxHz,
  },
  zadana: {
    g: "Falownik",
    n: "Częstotliwość zadana",
    u: " Hz",
    d: 1,
    pole: "hzZadana",
    get: (r) => r.hzZadana ?? r.czestotliwoscZadana,
    now: (s) => s?.czestotliwoscZadana,
    lo: 0,
    hi: M.maxHz,
  },
  moc: {
    g: "Falownik",
    n: "Moc",
    u: " kW",
    d: 1,
    pole: "moc",
    get: rowPower,
    now: (s) => {
      const p = powerReading(s);
      return p ? Math.max(0, p.kw) : null;
    },
    lo: 0,
    refs: () => [
      { v: M.mocZnamionowaKw, t: `znamionowa ${M.mocZnamionowaKw} kW` },
      ...(S.limitCfg?.wlaczony && isNum(S.limitCfg.kw)
        ? [{ v: S.limitCfg.kw, t: `limit ${S.limitCfg.kw} kW`, c: "#e85d5d" }]
        : []),
    ],
  },
  prad: {
    g: "Falownik",
    n: "Prąd",
    u: " A",
    d: 1,
    pole: "prad",
    get: (r) => r.prad,
    now: (s) => s?.prad,
    lo: 0,
    refs: () => [{ v: M.pradZnamionowyA, t: `znamionowy ${M.pradZnamionowyA} A` }],
  },
  napiecie: {
    g: "Falownik",
    n: "Napięcie",
    u: " V",
    d: 0,
    pole: "napiecie",
    get: (r) => r.napiecie,
    now: (s) => s?.napiecie,
    lo: 0,
  },
  poziom: {
    g: "Zbiornik",
    n: "Poziom wody",
    u: " %",
    d: 1,
    pole: "poziom",
    get: (r) => r.poziom,
    now: (s) => s?.poziomWodyProc,
    lo: 0,
    hi: 100,
  },
  m3: {
    g: "Zbiornik",
    n: "Objętość wody",
    u: " m³",
    d: 1,
    pole: "m3",
    get: (r) => waterVolumeM3(r.poziom),
    now: (s) => waterVolumeM3(s?.poziomWodyProc),
    lo: 0,
  },
  mA: {
    g: "Zbiornik",
    n: "Prąd sondy poziomu",
    u: " mA",
    d: 2,
    pole: "mA",
    get: (r) => r.mA,
    now: (s) => s?.poziomWodyMa,
    span: 1,
    refs: () => [
      { v: 4, t: "4 mA" },
      { v: 20, t: "20 mA" },
    ],
  },
  tWody: {
    g: "Zbiornik",
    n: "Temperatura wody",
    u: " °C",
    d: 1,
    pole: "temperaturaWody",
    get: (r) => r.temperaturaWody,
    now: (s) => s?.temperaturaWody,
    span: 2,
    refs: () => [
      {
        v: S.alarmCfg?.progi.tempOstrzezenie ?? CFG.progi.temperaturaZamarzaniaC,
        t: `${S.alarmCfg?.progi.tempOstrzezenie ?? CFG.progi.temperaturaZamarzaniaC} °C — próg zimnej wody`,
        c: WARN,
      },
    ],
  },
  tPow: {
    g: "Pogoda",
    n: "Temperatura powietrza",
    u: " °C",
    d: 1,
    pole: "pogoda.temperatura",
    get: (r) => pw(r).temperatura,
    now: (s) => s?.pogoda?.temperatura,
    span: 2,
    refs: () => [{ v: 0, t: "0 °C" }],
  },
  odcz: {
    g: "Pogoda",
    n: "Temperatura odczuwalna",
    u: " °C",
    d: 1,
    pole: "pogoda.odczuwalna",
    get: (r) => pw(r).odczuwalna,
    now: (s) => s?.pogoda?.odczuwalna,
    span: 2,
  },
  mokry: {
    g: "Pogoda",
    n: "Termometr mokry",
    u: " °C",
    d: 1,
    pole: "pogoda.temperatura i pogoda.wilgotnosc",
    get: (r) => wb(pw(r)),
    now: (s) => wb(s?.pogoda),
    span: 2,
    refs: () => [
      {
        v: S.alarmCfg?.progi.mokryMaxC ?? CFG.progi.termometrMokryMaxC,
        t: `${fmt(S.alarmCfg?.progi.mokryMaxC ?? CFG.progi.termometrMokryMaxC).replace("-", "−")} °C — próg ostrzeżenia`,
        c: WARN,
      },
    ],
  },
  wilg: {
    g: "Pogoda",
    n: "Wilgotność",
    u: " %",
    d: 0,
    pole: "pogoda.wilgotnosc",
    get: (r) => pw(r).wilgotnosc,
    now: (s) => s?.pogoda?.wilgotnosc,
    lo: 0,
    hi: 100,
  },
  cisn: {
    g: "Pogoda",
    n: "Ciśnienie",
    u: " hPa",
    d: 1,
    pole: "pogoda.cisnienie",
    get: (r) => pw(r).cisnienie,
    now: (s) => s?.pogoda?.cisnienie,
    span: 4,
  },
  wiatr: {
    g: "Pogoda",
    n: "Wiatr",
    u: " km/h",
    d: 1,
    pole: "pogoda.wiatr",
    get: (r) => pw(r).wiatr,
    now: (s) => s?.pogoda?.wiatr,
    lo: 0,
    span: 10,
  },
  poryw: {
    g: "Pogoda",
    n: "Porywy wiatru",
    u: " km/h",
    d: 1,
    pole: "pogoda.poryw",
    get: (r) => pw(r).poryw,
    now: (s) => s?.pogoda?.poryw,
    lo: 0,
    span: 10,
    refs: () => [{ v: 50, t: "50 km/h", c: WARN }],
  },
  kier: {
    g: "Pogoda",
    n: "Kierunek wiatru",
    u: "°",
    d: 0,
    pole: "pogoda.kierunekWiatru",
    get: (r) => pw(r).kierunekWiatru,
    now: (s) => s?.pogoda?.kierunekWiatru,
    lo: 0,
    hi: 360,
    step: 90,
    dots: true,
  },
  opad: {
    g: "Pogoda",
    n: "Opad dzisiaj",
    u: " mm",
    d: 1,
    pole: "pogoda.opadDzienny",
    get: (r) => pw(r).opadDzienny,
    now: (s) => s?.pogoda?.opadDzienny,
    lo: 0,
    span: 1,
  },
  uv: {
    g: "Pogoda",
    n: "Indeks UV",
    u: "",
    d: 1,
    pole: "pogoda.uv",
    get: (r) => pw(r).uv,
    now: (s) => s?.pogoda?.uv,
    lo: 0,
    span: 2,
  },
  sol: {
    g: "Pogoda",
    n: "Promieniowanie słoneczne",
    u: " W/m²",
    d: 0,
    pole: "pogoda.promieniowanie",
    get: (r) => pw(r).promieniowanie,
    now: (s) => s?.pogoda?.promieniowanie,
    lo: 0,
    span: 100,
  },
};

function currentValue(P) {
  if (!S.connected || S.denied) return null;
  if (P.g === "Pogoda" && !isFresh(S.status?.pogoda?.pobrano, now(), CFG.progi.swiezoscPogodyMs)) return null;
  if (P.g === "Falownik" && (!isLive() || S.status?.polaczony !== true)) return null;
  if (
    P.g === "Zbiornik" &&
    (!isLive() ||
      (P.pole === "temperaturaWody" ? S.status?.temperaturaWodyPolaczona !== true : S.status?.sondaPolaczona !== true))
  )
    return null;
  if (
    P.g === "Zbiornik" &&
    !isFresh(
      P.pole === "temperaturaWody" ? S.status?.aktualizacjaTemperatury : S.status?.aktualizacjaPoziomu,
      now(),
      P.pole === "temperaturaWody" ? 15000 : 5000,
    )
  )
    return null;
  return P.now(S.status);
}

function axisRange(P, pts, refs) {
  const vals = pts.map((x) => x.v).concat(refs.map((r) => r.v));
  let lo = vals.length ? vals.reduce((a, b) => Math.min(a, b), Infinity) : 0,
    hi = vals.length ? vals.reduce((a, b) => Math.max(a, b), -Infinity) : 1;
  if (isNum(P.lo)) lo = Math.min(lo, P.lo);
  if (isNum(P.hi)) hi = Math.max(hi, P.hi);
  const span = Math.max(hi - lo, P.span || 1e-6);
  if (hi - lo < span) {
    const m = (hi + lo) / 2;
    lo = m - span / 2;
    hi = m + span / 2;
    if (isNum(P.lo) && lo < P.lo) {
      hi += P.lo - lo;
      lo = P.lo;
    }
  }
  const step = P.step || niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  if (hi <= lo) hi = lo + step;
  return { lo, hi, step };
}

let pc = null,
  timer = null;
const HOUR = 3600000;
const cacheFor = (P) => (P.g === "Pogoda" ? weatherHistory : workHistory);
const localInput = (t) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 19);
const when = (t) =>
  new Date(t).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const bounds = () => {
  const to = pc.end ?? now();
  return { from: to - pc.hours * HOUR, to };
};
const keys = () => (pc.mode === "both" ? pc.pair : [pc.mode]);
const gapFor = (P) => (P.g === "Zbiornik" ? 6 * 60000 : P.g === "Pogoda" ? 12 * 60000 : GAP);
function syncPeriod() {
  const { from } = bounds();
  $("pcFrom").value = localInput(from);
  $("pcHours").value = String(pc.hours);
  $("pcPreset").value = pc.end === null && [1, 6, 24, 168, 720].includes(pc.hours) ? String(pc.hours) : "custom";
}
function timestamp(P) {
  if (P.timestamp) return P.timestamp(S.status);
  if (P.g === "Pogoda") return S.status?.pogoda?.pobrano;
  if (P.g === "Zbiornik")
    return P.pole === "temperaturaWody" ? S.status?.aktualizacjaTemperatury : S.status?.aktualizacjaPoziomu;
  return S.status?.aktualizacja;
}
function points(P) {
  const { from, to } = bounds(),
    pts = [];
  const sessionKey =
    P.pole === "cisnienieBar"
      ? "sesjaCisnienia"
      : P.pole === "wydajnoscM3h"
        ? "sesjaWydajnosci"
        : P.pole === "przepompowaneM3"
          ? "licznikPrzeplywuOd"
          : null;
  let segment = 0,
    previousSession;
  for (const r of cacheFor(P).since(from)) {
    if (r.czas > to) break;
    // Inne czujniki zapisują osobne rekordy; nie są one przerwą tej serii.
    if (
      P.g === "Pogoda"
        ? !r.pogoda
        : P.pole.startsWith("nd20.")
          ? !r.nd20
          : P.pole === "moc"
            ? !("moc" in r || "prad" in r)
            : !((P.pole === "m3" ? "poziom" : P.pole) in r)
    )
      continue;
    const v = P.get(r);
    if (v === undefined) continue;
    if (sessionKey && previousSession !== r[sessionKey]) segment++;
    if (sessionKey) previousSession = r[sessionKey];
    if (isNum(v)) pts.push({ t: r.czas, v, segment });
    else segment++;
  }
  const t = Number(timestamp(P)),
    v = currentValue(P);
  if (
    pc.end === null &&
    t >= from &&
    t <= to &&
    isFresh(t, now()) &&
    isNum(v) &&
    (!pts.length || t > pts.at(-1).t + 20000)
  )
    pts.push({ t, v, segment, live: true });
  return pts;
}
function stats(pts) {
  let min = Infinity,
    max = -Infinity,
    sum = 0;
  for (const p of pts) {
    min = Math.min(min, p.v);
    max = Math.max(max, p.v);
    sum += p.v;
  }
  return pts.length ? { min, max, avg: sum / pts.length } : { min: null, max: null, avg: null };
}
function render() {
  if (!pc) return;
  pc.lastRender = now();
  const ks = keys(),
    { from, to } = bounds();
  pc.series = ks.map((key, i) => ({
    key,
    P: PARAMS[key],
    pts: points(PARAMS[key]),
    color: i ? "#a9b8ff" : COLORS[PARAMS[key].g] || "#4cc9e8",
  }));
  const first = pc.series[0],
    P = first.P,
    values = stats(first.pts);
  const title =
    pc.mode === "both"
      ? pc.pair[0] === "moc"
        ? "Moc i częstotliwość falownika"
        : pc.pair[0] === "nd20Power"
          ? "Agregat · moc i częstotliwość"
          : "Poziom wody · cm i %"
      : P.n;
  $("pcTitle").textContent = title;
  $("pcGroup").textContent = P.g + " · " + when(from) + " — " + when(to);
  $("pcCanvas").setAttribute("aria-label", title + " · " + when(from) + " — " + when(to));
  const displayedValue = (s) => (pc.end === null ? currentValue(s.P) : s.pts.at(-1)?.v);
  $("pcNow").textContent = fmt(displayedValue(first), P.u, P.d);
  $("pcNowNote").textContent =
    pc.end === null ? (isNum(displayedValue(first)) ? "teraz" : "") : "ostatnia próbka w okresie";
  const second = pc.series[1];
  $("pcSecondNow").textContent = second ? " · " + fmt(displayedValue(second), second.P.u, second.P.d) : "";
  for (const [id, value] of [
    ["pcMin", values.min],
    ["pcMax", values.max],
    ["pcAvg", values.avg],
  ])
    $(id).textContent = fmt(value, P.u, P.d);
  const sv = second && stats(second.pts);
  $("pcSecondStats").textContent = second
    ? second.P.n +
      " · Min " +
      fmt(sv.min, second.P.u, second.P.d) +
      " · Średnio " +
      fmt(sv.avg, second.P.u, second.P.d) +
      " · Maks " +
      fmt(sv.max, second.P.u, second.P.d)
    : "";
  $("pcLegend").replaceChildren(
    ...pc.series.map((s, i) => {
      const node = document.createElement("span");
      node.style.color = s.color;
      node.textContent =
        "━ " + s.P.n + (s.P.u ? " [" + s.P.u.trim() + "]" : "") + (second ? (i ? " · prawa oś" : " · lewa oś") : "");
      return node;
    }),
  );
  const empty = pc.series.filter((s) => !s.pts.length || (s.pts.length === 1 && s.pts[0].live));
  const cadence =
    P.g === "Pogoda"
      ? "pogoda: co 10 min na postoju, 5 min w pracy lub 30 s przy otwartej aplikacji."
      : P.g === "Agregat"
        ? "agregat: zapis co minutę w chmurze, pełne próbki co 10 s na Raspberry."
        : P.g === "Zbiornik"
          ? "poziom wody: także co 5 min podczas postoju."
          : "praca: podsumowanie co ok. 1 min; pełny zapis 10 s na Raspberry.";
  $("pcNote").textContent = pc.loading
    ? "Pobieranie historii…"
    : pc.error
      ? "Nie udało się pobrać historii. Sprawdź połączenie."
      : pc.series.map((s) => s.pts.length + " pomiarów: " + s.P.n).join(" · ") +
        ". " +
        cadence +
        (empty.length ? " Brak zapisu w wybranym okresie: " + empty.map((s) => s.P.n).join(", ") + "." : "") +
        " " +
        pc.series.map((s) => s.P.note || "").join(" ");
  $("pcPeriodMessage").textContent =
    pc.rangeError ||
    "Zakres: " +
      when(from) +
      " — " +
      when(to) +
      " · " +
      fmt(pc.hours, " h", 3) +
      (pc.end === null ? " · do teraz" : " · stały okres") +
      ". Czas lokalny urządzenia. Dostępne ostatnie 30 dni.";
  if (pc.hoverTime === null) $("pcHover").textContent = "Przesuń palcem po wykresie, aby odczytać zapisane wartości.";
  draw();
}
function draw() {
  if (!pc?.series) return;
  const cv = $("pcCanvas"),
    box = cv.getBoundingClientRect(),
    dpr = Math.min(devicePixelRatio || 1, 2),
    w = Math.max(240, Math.round(box.width)),
    h = Math.max(180, Math.round(box.height) || 250);
  cv.width = w * dpr;
  cv.height = h * dpr;
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  c.font = "11px system-ui";
  const { from, to } = bounds(),
    dual = pc.series.length > 1,
    pad = { l: 48, r: dual ? 48 : 14, t: 22, b: 32 },
    iw = w - pad.l - pad.r,
    ih = h - pad.t - pad.b;
  const X = (t) => pad.l + ((t - from) / (to - from)) * iw;
  const ranges = pc.series.map((s) => axisRange(s.P, s.pts, s.P.refs?.() || []));
  const Y = (v, i) => pad.t + (1 - (v - ranges[i].lo) / (ranges[i].hi - ranges[i].lo)) * ih;
  pc.geo = { pad, iw, from, to };
  for (let i = 0; i < pc.series.length; i++) {
    const s = pc.series[i],
      r = ranges[i];
    c.fillStyle = s.color;
    c.textAlign = i ? "left" : "right";
    c.fillText(s.P.u.trim() || "stan", i ? w - pad.r + 6 : pad.l - 6, 12);
    for (let v = r.lo; v <= r.hi + r.step / 100000; v += r.step) {
      const y = Y(v, i);
      c.fillText(fmt(v, "", r.step < 0.1 ? 2 : r.step < 1 ? 1 : 0), i ? w - pad.r + 6 : pad.l - 6, y + 4);
      if (!i) {
        c.strokeStyle = "#29443a";
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(pad.l, y);
        c.lineTo(w - pad.r, y);
        c.stroke();
      }
    }
  }
  const count = w < 420 ? 2 : 4;
  for (let i = 0; i <= count; i++) {
    const t = from + ((to - from) * i) / count,
      x = X(t);
    c.fillStyle = "#8fa79c";
    c.textAlign = i === 0 ? "left" : i === count ? "right" : "center";
    c.fillText(
      pc.hours > 24 ? when(t) : new Date(t).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }),
      x,
      h - 8,
    );
  }
  c.save();
  c.beginPath();
  c.rect(pad.l, pad.t, iw, ih);
  c.clip();
  pc.series.forEach((s, i) => {
    for (const ref of s.P.refs?.() || []) {
      c.save();
      c.setLineDash([5, 4]);
      c.strokeStyle = ref.c || s.color;
      c.beginPath();
      c.moveTo(pad.l, Y(ref.v, i));
      c.lineTo(w - pad.r, Y(ref.v, i));
      c.stroke();
      c.restore();
      c.fillStyle = ref.c || s.color;
      c.textAlign = "left";
      c.fillText(ref.t, pad.l + 5, Y(ref.v, i) - 4);
    }
    const segments = [];
    let seg = [];
    for (const p of s.pts) {
      if (seg.length && (p.t - seg.at(-1).t > gapFor(s.P) || p.segment !== seg.at(-1).segment)) {
        segments.push(seg);
        seg = [];
      }
      seg.push(p);
    }
    if (seg.length) segments.push(seg);
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = 2;
    c.lineJoin = "round";
    for (const seg of segments) {
      // W każdym przedziale pikselowym zachowaj minimum i maksimum, także przy długich okresach.
      const step = Math.max(1, Math.ceil(seg.length / (iw * 2))),
        reduced = [];
      for (let k = 0; k < seg.length; k += step) {
        const chunk = seg.slice(k, k + step);
        let low = chunk[0],
          high = chunk[0];
        for (const p of chunk) {
          if (p.v < low.v) low = p;
          if (p.v > high.v) high = p;
        }
        reduced.push(...[...new Set([chunk[0], low, high, chunk.at(-1)])].sort((a, b) => a.t - b.t));
      }
      c.beginPath();
      reduced.forEach((p, k) => (k ? c.lineTo(X(p.t), Y(p.v, i)) : c.moveTo(X(p.t), Y(p.v, i))));
      if (!s.P.dots) c.stroke();
      if (s.P.dots || seg.length === 1)
        for (const p of reduced) {
          c.beginPath();
          c.arc(X(p.t), Y(p.v, i), 2.5, 0, Math.PI * 2);
          c.fill();
        }
    }
  });
  if (pc.hoverTime !== null) {
    c.strokeStyle = "#ecf4ed";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(X(pc.hoverTime), pad.t);
    c.lineTo(X(pc.hoverTime), pad.t + ih);
    c.stroke();
  }
  c.restore();
}
function pointer(e) {
  if (!pc?.geo) return;
  const r = $("pcCanvas").getBoundingClientRect(),
    { pad, iw, from, to } = pc.geo,
    t = from + Math.max(0, Math.min(1, (e.clientX - r.left - pad.l) / iw)) * (to - from);
  const readings = pc.series.map((s) => {
    let best = null;
    for (const p of s.pts) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return { s, p: best && Math.abs(best.t - t) <= gapFor(s.P) / 2 ? best : null };
  });
  pc.hoverTime = t;
  $("pcHover").textContent = readings
    .map(({ s, p }) => s.P.n + ": " + (p ? when(p.t) + " — " + fmt(p.v, s.P.u, s.P.d) : "brak próbki w tym miejscu"))
    .join(" · ");
  draw();
}
async function load(maxAge = 60000) {
  if (!pc) return;
  const target = pc,
    seq = ++pc.seq,
    { from } = bounds();
  pc.loading = true;
  render();
  try {
    await Promise.all([...new Set(keys().map((k) => cacheFor(PARAMS[k])))].map((cache) => cache.ensure(from, maxAge)));
    if (pc === target && seq === pc.seq) pc.error = false;
  } catch {
    if (pc === target && seq === pc.seq) pc.error = true;
  }
  if (pc === target && seq === pc.seq) {
    pc.loading = false;
    safe(render);
  }
}
function choosePeriod(hours, end) {
  const t = now(),
    from = (end ?? t) - hours * HOUR;
  if (
    !isNum(hours) ||
    hours < 1 / 60 ||
    hours > CFG.historia.maxDni * 24 ||
    !Number.isFinite(from) ||
    from < t - CFG.historia.maxDni * 86400e3 - 1000 ||
    (end ?? t) > t + 1000
  ) {
    pc.rangeError = "Wybierz okres od 1 minuty do 720 godzin z ostatnich 30 dni, bez dat w przyszłości.";
    render();
    return;
  }
  pc.hours = hours;
  pc.end = end === null ? null : Math.min(end, t);
  pc.rangeError = "";
  pc.hoverTime = null;
  syncPeriod();
  load();
}
export async function openParamChart(key, options = [key]) {
  if (!PARAMS[key] || !user()) return;
  const choices = [...new Set([key, ...options])].filter((k) => PARAMS[k]);
  const pair =
    choices.includes("moc") && choices.includes("hz")
      ? ["moc", "hz"]
      : choices.includes("nd20Power") && choices.includes("nd20Hz")
        ? ["nd20Power", "nd20Hz"]
        : choices.includes("poziomCm") && choices.includes("poziom")
          ? ["poziomCm", "poziom"]
          : null;
  pc = {
    mode: pair ? "both" : key,
    pair,
    hours: WIN / HOUR,
    end: null,
    hoverTime: null,
    seq: 0,
    loading: true,
    error: false,
    rangeError: "",
  };
  $("pcParameterField").hidden = choices.length < 2;
  $("pcParameter").replaceChildren(
    ...(pair ? ["both", ...choices] : choices).map((k) => {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = k === "both" ? "Oba parametry na jednym wykresie" : PARAMS[k].n;
      return o;
    }),
  );
  $("pcParameter").value = pc.mode;
  syncPeriod();
  const d = $("paramDlg");
  if (typeof d.showModal === "function") {
    if (!d.open) d.showModal();
  } else d.setAttribute("open", "");
  clearInterval(timer);
  timer = setInterval(() => {
    if (pc && document.visibilityState !== "hidden") load(pc.end === null ? 0 : 60000);
  }, 60000);
  await load();
}
function stop() {
  pc = null;
  clearInterval(timer);
  timer = null;
}
export function closeParamChart() {
  stop();
  const d = $("paramDlg");
  if (d.open) typeof d.close === "function" ? d.close() : d.removeAttribute("open");
}
export const refreshParamChart = () =>
  pc &&
  !pc.loading &&
  pc.end === null &&
  (pc.hours <= 24 || !S.connected || S.status?.polaczony === false || now() - (pc.lastRender || 0) >= 10000) &&
  render();
export function initParamChart() {
  $("pcParameter").addEventListener("change", () => {
    if (pc) {
      pc.mode = $("pcParameter").value;
      pc.hoverTime = null;
      load();
    }
  });
  $("pcPreset").addEventListener("change", () => {
    if (pc && $("pcPreset").value !== "custom") choosePeriod(Number($("pcPreset").value), null);
  });
  $("pcPeriodForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (pc) {
      const from = new Date($("pcFrom").value).getTime(),
        hours = Number($("pcHours").value);
      choosePeriod(hours, from + hours * HOUR);
    }
  });
  for (const id of ["pcFrom", "pcHours"])
    $(id).addEventListener("input", () => {
      $("pcPreset").value = "custom";
    });
  $("pcLive").addEventListener("click", () => pc && choosePeriod(Number($("pcHours").value), null));
  $("pcPrevious").addEventListener("click", () => pc && choosePeriod(pc.hours, bounds().from));
  $("pcNext").addEventListener("click", () => pc && choosePeriod(pc.hours, bounds().to + pc.hours * HOUR));
  const view = $("overviewView");
  view.querySelectorAll("[data-param]").forEach((node) => {
    const P = PARAMS[node.dataset.param];
    if (!P) return;
    node.setAttribute("role", "button");
    node.tabIndex = 0;
    node.removeAttribute("aria-hidden");
    node.setAttribute("aria-label", "Wykres z 6 godzin: " + P.n);
  });
  const openNode = (e) => {
    const node = e.target.closest("[data-param]");
    if (node) {
      e.preventDefault();
      openParamChart(node.dataset.param, node.dataset.paramOptions?.split(" "));
    }
  };
  view.addEventListener("click", openNode);
  view.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") openNode(e);
  });
  $("pcClose").addEventListener("click", closeParamChart);
  $("paramDlg").addEventListener("close", stop);
  $("paramDlg").addEventListener("click", (e) => e.target === $("paramDlg") && closeParamChart());
  const cv = $("pcCanvas");
  cv.addEventListener("pointerdown", pointer);
  cv.addEventListener("pointermove", (e) => (e.pointerType === "mouse" || e.buttons) && pointer(e));
  cv.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && pc) {
      pc.hoverTime = null;
      render();
    }
  });
  window.addEventListener("resize", () => pc && draw());
}
