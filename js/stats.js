// Zakładka „Statystyki”: historia poziomu i pracy, cykle zbiornika, ostatnie próbki.
import {
  CFG,
  chartSegments,
  cyclesFrom,
  duration,
  fmt,
  isNum,
  niceStep,
  waterVolumeM3,
  lowerBound,
  pumpedVolumeInPeriod,
} from "./logic.js";
import { workHistory } from "./history.js";
import { $, S, el, now, onShowView, user } from "./state.js";

let days = 1,
  rows = [],
  loadSeq = 0,
  pendingLoads = 0;
let customPeriod = null,
  displayedPeriod = null;
const period = () => customPeriod || { from: now() - days * 86400e3, to: now() };
const localDateInput = (time) => new Date(time - new Date(time).getTimezoneOffset() * 60000).toISOString().slice(0, 19);
function fillPeriod() {
  const { from, to } = period();
  $("statsFrom").value = localDateInput(from);
  $("statsTo").value = localDateInput(to);
  $("statsHours").value = String(Math.round((to - from) / 3600) / 1000);
}
const charts = {
  waterChart: ["poziom", "#4cc9e8", "%", 100, 6 * 60000],
  pressureChart: ["cisnienieBar", "#4cc9e8", "bar", 40, 20000, "sesjaCisnienia"],
  flowChart: ["wydajnoscM3h", "#4cc9e8", "m³/h", 60, 20000, "sesjaWydajnosci"],
  pumpedChart: ["przepompowaneM3", "#d6f48a", "m³", 1, 20000, "licznikPrzeplywuOd"],
  pumpChart: ["moc", "#b99cf0", "kW", 10, 2 * 60000],
  pumpHzChart: ["hz", "#d6f48a", "Hz", 50, 2 * 60000],
  pumpCurrentChart: ["prad", "#f0c995", "A", 10, 2 * 60000],
};
let activeChart = "waterChart",
  plot = null,
  selectedPoint = null;

export function resetStats() {
  rows = [];
  customPeriod = null;
  displayedPeriod = null;
  days = 1;
  fillPeriod();
  document
    .querySelectorAll("#statsView .range button")
    .forEach((button) => button.classList.toggle("active", button.dataset.days === "1"));
  selectedPoint = null;
  plot = null;
  activeChart = "waterChart";
  $("statsMetric").value = activeChart;
  $("statsPointIndex").disabled = true;
  $("statsPointIndex").removeAttribute("aria-valuetext");
  loadSeq++;
  renderStats();
}

function drawChart(id, key, color, unit, minimumMax, maxGap, sessionKey) {
  const canvas = $(id),
    box = canvas.getBoundingClientRect(),
    dpr = Math.min(devicePixelRatio || 1, 2),
    w = Math.max(240, Math.round(box.width)),
    h = 230;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const segments = chartSegments(rows, key, maxGap, sessionKey);
  const points = segments.flat();
  let maximum = minimumMax;
  for (const segment of segments) for (const p of segment) maximum = Math.max(maximum, p.value);
  const stepY = niceStep(maximum / 4),
    maxY = Math.ceil(maximum / stepY) * stepY;
  const pad = { l: 45, r: 14, t: 24, b: 28 },
    iw = w - pad.l - pad.r,
    ih = h - pad.t - pad.b;
  c.font = "11px system-ui";
  c.fillStyle = "#8fa79c";
  c.strokeStyle = "#29443a";
  c.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih * i) / 4;
    c.beginPath();
    c.moveTo(pad.l, y);
    c.lineTo(w - pad.r, y);
    c.stroke();
    c.fillText(String(Math.round(maxY * (1 - i / 4))), 4, y + 4);
  }
  c.fillText(unit, 4, 12);
  const { from: first, to: last } = displayedPeriod || period();
  plot = { canvas, points, first, last, pad, iw, ih, maxY, unit, maxGap };
  const range = $("statsPointIndex");
  range.disabled = !points.length;
  range.max = String(Math.max(0, points.length - 1));
  if (selectedPoint && !points.some((p) => p.czas === selectedPoint.czas)) selectedPoint = null;
  if (!selectedPoint) {
    range.value = "0";
    range.removeAttribute("aria-valuetext");
  }
  if (!segments.length) {
    $("statsPoint").textContent = "Brak próbek wybranego parametru w tym zakresie.";
    c.fillText("Brak pomiarów w tym zakresie", pad.l, h / 2);
    return;
  }
  const tick = (t) =>
    new Date(t).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  c.fillText(tick(first), pad.l, h - 7);
  const endLabel = tick(last);
  c.fillText(endLabel, w - pad.r - c.measureText(endLabel).width, h - 7);
  // co najwyżej ~2 punkty na piksel szerokości — przy 30 dniach to tysiące razy mniej operacji
  for (const segment of segments) {
    const step = Math.max(1, Math.ceil(segment.length / (iw * 2)));
    const points = segment.filter((_, i) => i % step === 0 || i === segment.length - 1);
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = 2;
    c.lineJoin = "round";
    c.beginPath();
    let started = false;
    for (const row of points) {
      const v = row.value;
      const x = pad.l + ((row.czas - first) / Math.max(1, last - first)) * iw,
        y = pad.t + (1 - Math.max(0, Math.min(maxY, v)) / maxY) * ih;
      if (started) c.lineTo(x, y);
      else {
        c.moveTo(x, y);
        started = true;
      }
    }
    c.stroke();
    if (points.length === 1) {
      const p = points[0];
      c.beginPath();
      c.arc(pad.l + ((p.czas - first) / (last - first)) * iw, pad.t + (1 - p.value / maxY) * ih, 2.5, 0, 2 * Math.PI);
      c.fill();
    }
  }
  if (selectedPoint) paintSelection(selectedPoint);
  else $("statsPoint").textContent = "Dotknij wykresu lub przesuń suwak, aby odczytać konkretną próbkę.";
}

function paintSelection(point) {
  if (!plot || !point) return;
  const { canvas, first, last, pad, iw, ih, maxY, unit } = plot,
    c = canvas.getContext("2d");
  const x = pad.l + ((point.czas - first) / (last - first)) * iw,
    y = pad.t + (1 - point.value / maxY) * ih;
  c.save();
  c.strokeStyle = "#ffffff";
  c.fillStyle = "#ffffff";
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(x, pad.t);
  c.lineTo(x, pad.t + ih);
  c.stroke();
  c.beginPath();
  c.arc(x, y, 4, 0, 2 * Math.PI);
  c.fill();
  c.restore();
  const description = new Date(point.czas).toLocaleString("pl-PL") + " · " + fmt(point.value, " " + unit, 2);
  c.save();
  c.fillStyle = "#ffffff";
  c.fillText(description, pad.l, 12);
  c.restore();
  $("statsPoint").textContent = description;
  const range = $("statsPointIndex");
  range.value = String(lowerBound(plot.points, point.czas));
  range.setAttribute("aria-valuetext", description);
}
function drawActiveChart() {
  document.querySelectorAll("[data-stats-chart]").forEach((node) => {
    node.hidden = node.dataset.statsChart !== activeChart;
  });
  if (!$("statsView").hidden) drawChart(activeChart, ...charts[activeChart]);
}

const td = (text, className = "") => el("td", { textContent: text, className });
const when = (t) => new Date(t).toLocaleString("pl-PL");

export function renderStats() {
  const volume = pumpedVolumeInPeriod(rows);
  $("flowSummary").textContent = volume
    ? "Szacowany przyrost licznika: ≈ " +
      fmt(volume.m3, " m³", 2) +
      " między " +
      when(volume.from) +
      " a " +
      when(volume.to) +
      ". Przerwy bez poprawnego szacunku są pominięte."
    : "Brak co najmniej dwóch zapisów licznika w wybranym okresie. Starsza historia nie zawiera szacunków przepływu.";
  const pressures = rows.filter((x) => x.typ === "cisnienie" && x.pracuje === true && isNum(x.cisnienieBar));
  let pressureMin = Infinity,
    pressureMax = -Infinity,
    pressureSum = 0;
  for (const x of pressures) {
    pressureMin = Math.min(pressureMin, x.cisnienieBar);
    pressureMax = Math.max(pressureMax, x.cisnienieBar);
    pressureSum += x.cisnienieBar;
  }
  $("pressureSummary").textContent = pressures.length
    ? `Min: ${fmt(pressureMin, " bar")} · średnia: ${fmt(pressureSum / pressures.length, " bar")} · maks: ${fmt(pressureMax, " bar")} · ${pressures.length} próbek`
    : "Brak pomiarów podczas pracy pompy w wybranym zakresie.";
  const valid = rows.filter((x) => isNum(x.poziom)),
    levels = valid.map((x) => x.poziom),
    cycles = cyclesFrom(valid),
    avg = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : null;
  let min = Infinity,
    max = -Infinity;
  for (const v of levels) ((min = Math.min(min, v)), (max = Math.max(max, v)));
  $("avgWater").textContent = avg === null ? "—" : fmt(avg, " %");
  $("waterRange").textContent = avg === null ? "—" : fmt(min, " %") + "–" + fmt(max, " %");
  const fills = cycles.filter((x) => x.dir === "up"),
    drains = cycles.filter((x) => x.dir === "down");
  $("lastFill").textContent = fills.length ? duration(fills.at(-1).end - fills.at(-1).start) : "Brak cyklu";
  $("lastDrain").textContent = drains.length ? duration(drains.at(-1).end - drains.at(-1).start) : "Brak cyklu";
  $("sampleCount").textContent = rows.length + " " + (rows.length === 1 ? "próbka" : "próbek");
  $("statsMessage").textContent = !rows.length
    ? "Brak zapisanej historii w wybranym zakresie. Poziom wody jest zapisywany także co 5 minut na postoju."
    : rows.length < 3
      ? "Zebrano pierwsze próbki. Wiarygodne czasy napełniania i opróżniania pojawią się po wykryciu pełniejszych cykli."
      : "Dane od " + when(rows[0].czas) + " do " + when(rows.at(-1).czas) + ".";

  $("cycles").replaceChildren(
    ...(cycles.length
      ? cycles
          .slice(-30)
          .reverse()
          .map((x) => {
            const up = x.dir === "up";
            return el(
              "tr",
              {},
              td(up ? "Napełnianie" : "Opróżnianie", up ? "trend-up" : "trend-down"),
              td(when(x.start)),
              td(when(x.end)),
              td(duration(x.end - x.start)),
              td(fmt(Math.abs(x.endLevel - x.startLevel), " %")),
            );
          })
      : [el("tr", {}, el("td", { colSpan: 5, textContent: "Za mało danych do wykrycia cykli." }))]),
  );
  $("historyRows").replaceChildren(
    ...(rows.length
      ? rows
          .slice(-100)
          .reverse()
          .map((x) =>
            el(
              "tr",
              {},
              td(when(x.czas)),
              td(fmt(x.poziom, " %")),
              td(fmt(x.mA, " mA")),
              td(fmt(waterVolumeM3(x.poziom), " m³", 0)),
              td(fmt(x.temperaturaWody, " °C")),
              td(
                x.typ === "cisnienie"
                  ? "Pracuje · ciśnienie"
                  : x.typ === "woda"
                    ? "Pomiar wody"
                    : x.falownikPolaczony
                      ? x.pracuje
                        ? "Pracuje"
                        : "Stop"
                      : "Offline",
              ),
              td(fmt(x.hz, " Hz")),
              td(fmt(x.prad, " A")),
              td(fmt(x.napiecie, " V")),
              td(fmt(x.moc, " kW")),
              td(fmt(x.cisnienieBar, " bar")),
              td(isNum(x.wydajnoscM3h) ? "≈ " + fmt(x.wydajnoscM3h, " m³/h") : "—"),
              td(isNum(x.przepompowaneM3) ? "≈ " + fmt(x.przepompowaneM3, " m³", 2) : "—"),
            ),
          )
      : [el("tr", {}, el("td", { colSpan: 13, textContent: "Brak danych." }))]),
  );
  requestAnimationFrame(() => {
    if ($("statsView").hidden) return;
    drawActiveChart();
  });
}

async function loadStats(maxAge = 60000) {
  if (!user()) return;
  const seq = ++loadSeq,
    cached = workHistory.rows.length > 0;
  if (!cached) {
    $("statsMessage").textContent = "Pobieranie historii…";
    $("statsRefreshState").textContent = "Pobieranie historii…";
  }
  pendingLoads++;
  try {
    const chosen = period();
    const r = await workHistory.ensure(chosen.from, maxAge);
    if (seq !== loadSeq) return; // w międzyczasie wybrano inny zakres
    displayedPeriod = chosen;
    rows = r.filter((x) => x.czas >= chosen.from && x.czas <= chosen.to && x.typ !== "agregat");
    renderStats();
    $("statsRefreshState").textContent =
      (customPeriod ? "Wybrany stały okres · sprawdzanie zapisów co minutę" : "Odświeżanie co minutę") +
      " · ostatnio " +
      new Date(now()).toLocaleTimeString("pl-PL");
    $("statsPeriodMessage").textContent =
      "Zakres: " + when(chosen.from) + " — " + when(chosen.to) + ". " + rows.length + " zapisanych próbek.";
  } catch {
    if (seq === loadSeq)
      $("statsRefreshState").textContent = "Nie udało się odświeżyć historii. Wybierz zakres, aby spróbować ponownie.";
    if (seq === loadSeq)
      $("statsMessage").textContent = "Nie udało się pobrać historii. Sprawdź połączenie i spróbuj ponownie.";
  } finally {
    pendingLoads--;
  }
}

export function initStats() {
  fillPeriod();
  $("statsHours").addEventListener("input", () => {
    const from = new Date($("statsFrom").value).getTime(),
      hours = Number($("statsHours").value);
    if (Number.isFinite(from) && hours > 0 && hours <= 720) $("statsTo").value = localDateInput(from + hours * 3600000);
  });
  for (const id of ["statsFrom", "statsTo"])
    $(id).addEventListener("change", () => {
      const ms = new Date($("statsTo").value) - new Date($("statsFrom").value);
      $("statsHours").value = ms > 0 ? String(Math.round(ms / 3600) / 1000) : "";
    });
  const setPeriod = (from, to) => {
    const t = now();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from < 60000) {
      $("statsPeriodMessage").textContent =
        "Wybierz poprawny okres trwający co najmniej minutę; początek musi być przed końcem.";
      return;
    }
    if (from < t - CFG.historia.maxDni * 86400e3 || to > t + 1000) {
      $("statsPeriodMessage").textContent = "Wybierz okres z ostatnich 30 dni, bez dat w przyszłości.";
      return;
    }
    customPeriod = { from, to: Math.min(to, t) };
    selectedPoint = null;
    document.querySelectorAll("#statsView .range button").forEach((x) => x.classList.remove("active"));
    fillPeriod();
    loadStats();
  };
  $("statsPeriodForm").addEventListener("submit", (event) => {
    event.preventDefault();
    setPeriod(new Date($("statsFrom").value).getTime(), new Date($("statsTo").value).getTime());
  });
  $("statsZoomIn").addEventListener("click", () => {
    const { from, to } = displayedPeriod || period();
    const width = Math.max(60000, (to - from) / 2);
    const center = selectedPoint?.czas ?? (from + to) / 2;
    const left = Math.max(from, Math.min(to - width, center - width / 2));
    setPeriod(left, left + width);
  });
  $("statsMetric").addEventListener("change", () => {
    activeChart = $("statsMetric").value;
    selectedPoint = null;
    drawActiveChart();
  });
  $("statsPointIndex").addEventListener("input", () => {
    selectedPoint = plot?.points[Number($("statsPointIndex").value)] ?? null;
    drawActiveChart();
  });
  for (const id of Object.keys(charts))
    $(id).addEventListener("pointerdown", (event) => {
      if (!plot?.points.length) return;
      const rect = plot.canvas.getBoundingClientRect(),
        fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - plot.pad.l) / plot.iw));
      const time = plot.first + fraction * (plot.last - plot.first),
        index = lowerBound(plot.points, time);
      const options = [plot.points[index - 1], plot.points[index]].filter(Boolean);
      const point = options.sort((a, b) => Math.abs(a.czas - time) - Math.abs(b.czas - time))[0];
      if (Math.abs(point.czas - time) > plot.maxGap / 2) {
        selectedPoint = null;
        drawActiveChart();
        $("statsPoint").textContent =
          "W tym miejscu jest przerwa w pomiarach. Użyj suwaka, aby wybrać zapisaną próbkę.";
        return;
      }
      selectedPoint = point;
      drawActiveChart();
    });
  onShowView("stats", () => {
    drawActiveChart();
    return loadStats();
  });
  document.querySelectorAll("#statsView .range button").forEach((button) =>
    button.addEventListener("click", () => {
      document.querySelectorAll("#statsView .range button").forEach((x) => x.classList.remove("active"));
      button.classList.add("active");
      days = Number(button.dataset.days) || 1;
      customPeriod = null;
      selectedPoint = null;
      fillPeriod();
      loadStats();
    }),
  );
  window.addEventListener("resize", () => {
    if (!$("statsView").hidden && rows.length) renderStats();
  });
  const refresh = () => {
    if (!$("statsView").hidden && document.visibilityState !== "hidden" && S.connected && user() && !pendingLoads)
      loadStats(0);
  };
  setInterval(refresh, 60000);
  document.addEventListener("visibilitychange", refresh);
}
