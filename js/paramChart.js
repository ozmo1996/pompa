// Okno z wykresem pojedynczego parametru z zakładki „Czujniki” (ostatnie 6 godzin).
import { CFG, fmt, isFresh, isNum, niceStep, powerReading, rowPower, waterVolumeM3, wetBulb } from "./logic.js";
import { weatherHistory, workHistory } from "./history.js";
import { $, S, isLive, now, safe, user } from "./state.js";

const { silnik: M } = CFG,
  WIN = CFG.historia.oknoWykresuParametruMs,
  GAP = 5 * 60e3, // przerwa w danych dłuższa niż to przerywa linię
  COLORS = { Falownik: "#d6f48a", Zbiornik: "#4cc9e8", Pogoda: "#a9b8ff" },
  WARN = "#f0c995";
const pw = (r) => r?.pogoda || {};
const wb = (w) => wetBulb(w?.temperatura, w?.wilgotnosc);

/**
 * g — grupa, n — nazwa, u — jednostka, d — miejsca po przecinku, pole — nazwa pola w historii (do komunikatu),
 * get — wartość z rekordu historii, now — wartość z bieżącego statusu, lo/hi — zakres osi, span — minimalna rozpiętość,
 * refs — linie odniesienia.
 */
const PARAMS = {
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
      { v: CFG.progi.temperaturaZamarzaniaC, t: `${CFG.progi.temperaturaZamarzaniaC} °C — ryzyko zamarzania`, c: WARN },
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
        v: CFG.progi.termometrMokryMaxC,
        t: `${fmt(CFG.progi.termometrMokryMaxC).replace("-", "−")} °C — granica śniegu`,
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

let pc = null, // { key, hover, loading, error, points, geo }
  timer = null;
const cacheFor = (P) => (P.g === "Pogoda" ? weatherHistory : workHistory);
const hhmm = (t) => new Date(t).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });

function points(P) {
  const t0 = now() - WIN,
    pts = [];
  for (const r of cacheFor(P).since(t0)) {
    const v = P.get(r);
    if (isNum(v)) pts.push({ t: r.czas, v });
  }
  // dołóż bieżący odczyt, jeśli jest świeższy niż ostatni zapis w historii
  const t = Number(S.status?.aktualizacja),
    v = P.now(S.status);
  if (isFresh(t, now()) && isNum(v) && (!pts.length || t > pts.at(-1).t + 20000)) pts.push({ t, v, live: true });
  return pts;
}

function render() {
  if (!pc) return;
  const P = PARAMS[pc.key],
    pts = (pc.points = points(P)),
    f = (v) => fmt(v, P.u, P.d),
    live = pts.at(-1)?.live,
    nowV = P.now(S.status),
    vs = pts.map((x) => x.v);
  $("pcGroup").textContent = P.g + " · ostatnie 6 godzin";
  $("pcTitle").textContent = P.n;
  $("pcNow").textContent = f(isNum(nowV) ? nowV : null);
  $("pcNowNote").textContent = isNum(nowV) ? (isLive() ? "teraz" : "ostatni zapis") : "";
  $("pcMin").textContent = vs.length ? f(Math.min(...vs)) : "—";
  $("pcMax").textContent = vs.length ? f(Math.max(...vs)) : "—";
  $("pcAvg").textContent = vs.length ? f(vs.reduce((a, b) => a + b, 0) / vs.length) : "—";
  $("pcNote").textContent = pc.loading
    ? "Pobieranie historii…"
    : pc.error
      ? "Nie udało się pobrać historii. Sprawdź połączenie."
      : !vs.length || (vs.length === 1 && live)
        ? `Brak zapisu tego parametru z ostatnich 6 godzin (pole „${P.pole}”).`
        : `${vs.length} ${vs.length === 1 ? "pomiar" : "pomiarów"} · ` +
          (P.g === "Pogoda"
            ? "pogoda: co 10 min na postoju, 5 min w pracy lub 30 s przy otwartej aplikacji."
            : "praca: podsumowanie co ok. 1 min; pełny zapis 10 s na Raspberry.");
  if (pc.hover == null)
    $("pcHover").textContent = vs.length > 1 ? "Przesuń palcem po wykresie, aby odczytać wartość." : "";
  draw();
}

function axisRange(P, pts, refs) {
  const vals = pts.map((x) => x.v).concat(refs.map((r) => r.v));
  let lo = vals.length ? Math.min(...vals) : 0,
    hi = vals.length ? Math.max(...vals) : 1;
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

function draw() {
  if (!pc) return;
  const P = PARAMS[pc.key],
    pts = pc.points || [],
    cv = $("pcCanvas"),
    box = cv.getBoundingClientRect(),
    dpr = Math.min(devicePixelRatio || 1, 2),
    w = Math.max(280, Math.round(box.width)),
    h = Math.max(180, Math.round(box.height) || 240);
  cv.width = w * dpr;
  cv.height = h * dpr;
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const t1 = now(),
    t0 = t1 - WIN,
    refs = P.refs ? P.refs() : [],
    { lo, hi, step } = axisRange(P, pts, refs);

  c.font = "11px system-ui";
  const labs = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) labs.push(v);
  const sd = step < 1 ? (step < 0.1 ? 2 : 1) : 0,
    label = (v) => v.toLocaleString("pl-PL", { maximumFractionDigits: sd }),
    lw = Math.max(...labs.map((v) => c.measureText(label(v)).width)),
    pad = { l: Math.ceil(lw) + 12, r: 10, t: 12, b: 24 },
    iw = w - pad.l - pad.r,
    ih = h - pad.t - pad.b,
    X = (t) => pad.l + ((t - t0) / WIN) * iw,
    Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;

  // siatka i opisy osi
  c.strokeStyle = "#29443a";
  c.fillStyle = "#8fa79c";
  c.lineWidth = 1;
  c.textAlign = "right";
  for (const v of labs) {
    const y = Math.round(Y(v)) + 0.5;
    c.beginPath();
    c.moveTo(pad.l, y);
    c.lineTo(w - pad.r, y);
    c.stroke();
    c.fillText(label(v), pad.l - 6, y + 4);
  }
  c.textAlign = "center";
  for (let t = Math.ceil(t0 / 3600e3) * 3600e3; t <= t1; t += 3600e3) {
    const x = Math.round(X(t)) + 0.5;
    c.strokeStyle = "#1f3830";
    c.beginPath();
    c.moveTo(x, pad.t);
    c.lineTo(x, pad.t + ih);
    c.stroke();
    c.fillText(hhmm(t), x, h - 7);
  }

  // linie odniesienia
  let lastLab = -99;
  for (const r of [...refs].sort((a, b) => b.v - a.v)) {
    if (r.v < lo || r.v > hi) continue;
    const y = Math.round(Y(r.v)) + 0.5,
      ly = y - 5 - lastLab < 13 ? y + 14 : y - 5;
    lastLab = ly;
    c.save();
    c.setLineDash([5, 4]);
    c.strokeStyle = r.c || "#a3b7ad";
    c.globalAlpha = 0.8;
    c.beginPath();
    c.moveTo(pad.l, y);
    c.lineTo(w - pad.r, y);
    c.stroke();
    c.restore();
    c.fillStyle = r.c || "#a3b7ad";
    c.textAlign = "right";
    c.fillText(r.t, w - pad.r - 2, ly);
  }

  // dane: segmenty rozdzielone przerwami w zapisie
  const col = COLORS[P.g] || COLORS.Falownik,
    segs = [];
  let cur = [];
  pts.forEach((p, i) => {
    if (i && p.t - pts[i - 1].t > GAP) {
      segs.push(cur);
      cur = [];
    }
    cur.push(p);
  });
  if (cur.length) segs.push(cur);
  const dot = (p, r) => {
    c.beginPath();
    c.arc(X(p.t), Y(p.v), r, 0, 7);
    c.fill();
  };
  const path = (sg) => sg.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.v)) : c.moveTo(X(p.t), Y(p.v))));
  c.fillStyle = col;
  if (P.dots) pts.forEach((p) => dot(p, 2));
  else
    for (const sg of segs) {
      if (sg.length === 1) {
        c.fillStyle = col;
        dot(sg[0], 2.5);
        continue;
      }
      const gr = c.createLinearGradient(0, pad.t, 0, pad.t + ih);
      gr.addColorStop(0, col + "40");
      gr.addColorStop(1, col + "00");
      c.beginPath();
      path(sg);
      c.lineTo(X(sg.at(-1).t), pad.t + ih);
      c.lineTo(X(sg[0].t), pad.t + ih);
      c.closePath();
      c.fillStyle = gr;
      c.fill();
      c.beginPath();
      path(sg);
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.lineJoin = "round";
      c.stroke();
    }

  // wskazany punkt
  if (pc.hover != null && pts[pc.hover]) {
    const p = pts[pc.hover],
      x = X(p.t),
      y = Y(p.v);
    c.strokeStyle = "#ecf4ed";
    c.globalAlpha = 0.5;
    c.beginPath();
    c.moveTo(x, pad.t);
    c.lineTo(x, pad.t + ih);
    c.stroke();
    c.globalAlpha = 1;
    c.fillStyle = "#122720";
    c.strokeStyle = col;
    c.lineWidth = 2.5;
    c.beginPath();
    c.arc(x, y, 5, 0, 7);
    c.fill();
    c.stroke();
  }
  pc.geo = { pad, iw, t0 };
}

function pointer(e) {
  if (!pc?.points?.length || !pc.geo) return;
  const r = $("pcCanvas").getBoundingClientRect(),
    { pad, iw, t0 } = pc.geo,
    t = t0 + Math.max(0, Math.min(1, (e.clientX - r.left - pad.l) / iw)) * WIN;
  let best = 0;
  pc.points.forEach((p, i) => {
    if (Math.abs(p.t - t) < Math.abs(pc.points[best].t - t)) best = i;
  });
  pc.hover = best;
  const p = pc.points[best],
    P = PARAMS[pc.key];
  $("pcHover").textContent = `${hhmm(p.t)} — ${fmt(p.v, P.u, P.d)}${p.live ? " (teraz)" : ""}`;
  draw();
}

async function load(key, maxAge) {
  try {
    await cacheFor(PARAMS[key]).ensure(now() - WIN, maxAge);
    if (pc?.key === key) pc.error = false;
  } catch {
    if (pc?.key === key) pc.error = true;
  }
  if (pc?.key === key) {
    pc.loading = false;
    safe(render);
  }
}

export async function openParamChart(key) {
  if (!PARAMS[key] || !user()) return;
  const cache = cacheFor(PARAMS[key]);
  pc = { key, hover: null, loading: cache.from > now() - WIN, error: false };
  const d = $("paramDlg");
  if (typeof d.showModal === "function") {
    if (!d.open) d.showModal();
  } else d.setAttribute("open", "");
  render();
  clearInterval(timer);
  timer = setInterval(() => pc && load(pc.key, 0), 60000);
  await load(key, 60000);
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
/** Odświeżenie przy nowym statusie (dopisuje bieżący punkt). */
export const refreshParamChart = () => pc && !pc.loading && render();

export function initParamChart() {
  const view = $("overviewView");
  view.querySelectorAll("[data-param]").forEach((node) => {
    const P = PARAMS[node.dataset.param];
    if (!P) return;
    node.setAttribute("role", "button");
    node.tabIndex = 0;
    node.removeAttribute("aria-hidden");
    node.setAttribute("aria-label", "Wykres z 6 godzin: " + P.n);
  });
  view.addEventListener("click", (e) => {
    const node = e.target.closest("[data-param]");
    if (node) {
      e.preventDefault();
      openParamChart(node.dataset.param);
    }
  });
  view.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const node = e.target.closest("[data-param]");
    if (node) {
      e.preventDefault();
      openParamChart(node.dataset.param);
    }
  });
  $("pcClose").addEventListener("click", closeParamChart);
  $("paramDlg").addEventListener("close", stop);
  $("paramDlg").addEventListener("click", (e) => e.target === $("paramDlg") && closeParamChart());
  const cv = $("pcCanvas");
  cv.addEventListener("pointerdown", pointer);
  cv.addEventListener("pointermove", (e) => (e.pointerType === "mouse" || e.buttons) && pointer(e));
  cv.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && pc) {
      pc.hover = null;
      render();
    }
  });
  window.addEventListener("resize", () => pc && draw());
}
