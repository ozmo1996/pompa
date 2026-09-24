// Zakładka „Statystyki”: historia poziomu i pracy, cykle zbiornika, ostatnie próbki.
import { cyclesFrom, duration, fmt, isNum, waterVolumeM3 } from "./logic.js";
import { workHistory } from "./history.js";
import { $, el, now, onShowView, user } from "./state.js";

let days = 1,
  rows = [],
  loadSeq = 0;

export function resetStats() {
  rows = [];
  loadSeq++;
  renderStats();
}

function drawChart(id, series, maxY) {
  const canvas = $(id),
    box = canvas.getBoundingClientRect(),
    dpr = Math.min(devicePixelRatio || 1, 2),
    w = Math.max(320, Math.round(box.width)),
    h = 230;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const pad = { l: 42, r: 14, t: 14, b: 28 },
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
  if (!rows.length) return;
  const first = rows[0].czas,
    last = rows.at(-1).czas || first + 1;
  c.fillText(new Date(first).toLocaleDateString("pl-PL"), pad.l, h - 7);
  const endLabel = new Date(last).toLocaleDateString("pl-PL");
  c.fillText(endLabel, w - pad.r - c.measureText(endLabel).width, h - 7);
  // co najwyżej ~2 punkty na piksel szerokości — przy 30 dniach to tysiące razy mniej operacji
  const step = Math.max(1, Math.ceil(rows.length / (iw * 2)));
  for (const s of series) {
    c.strokeStyle = s.color;
    c.lineWidth = 2;
    c.lineJoin = "round";
    c.beginPath();
    let started = false;
    for (let i = 0; i < rows.length; i += step) {
      const row = rows[i],
        v = Number(s.get ? s.get(row) : row[s.key]);
      if (!Number.isFinite(v)) continue;
      const x = pad.l + ((row.czas - first) / Math.max(1, last - first)) * iw,
        y = pad.t + (1 - Math.max(0, Math.min(maxY, v)) / maxY) * ih;
      if (started) c.lineTo(x, y);
      else {
        c.moveTo(x, y);
        started = true;
      }
    }
    c.stroke();
  }
}

const td = (text, className = "") => el("td", { textContent: text, className });
const when = (t) => new Date(t).toLocaleString("pl-PL");

export function renderStats() {
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
    ? "Brak zapisanej historii w wybranym zakresie. Nowe próbki są zapisywane co minutę."
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
              td(x.falownikPolaczony ? (x.pracuje ? "Pracuje" : "Stop") : "Offline"),
              td(fmt(x.hz, " Hz")),
              td(fmt(x.prad, " A")),
              td(fmt(x.napiecie, " V")),
              td(fmt(x.moc, " kW")),
            ),
          )
      : [el("tr", {}, el("td", { colSpan: 10, textContent: "Brak danych." }))]),
  );
  requestAnimationFrame(() => {
    if ($("statsView").hidden) return;
    drawChart("waterChart", [{ key: "poziom", color: "#4cc9e8" }], 100);
    let maxPump = 50;
    for (const x of rows) maxPump = Math.max(maxPump, Number(x.hz) || 0, Number(x.prad) || 0, Number(x.moc) || 0);
    drawChart(
      "pumpChart",
      [
        { key: "hz", color: "#d6f48a" },
        { key: "prad", color: "#f0c995" },
        { key: "moc", color: "#b99cf0" },
      ],
      Math.ceil(maxPump / 10) * 10,
    );
  });
}

async function loadStats() {
  if (!user()) return;
  const seq = ++loadSeq,
    cached = workHistory.rows.length > 0;
  if (!cached) $("statsMessage").textContent = "Pobieranie historii…";
  try {
    const r = await workHistory.ensure(now() - days * 86400e3);
    if (seq !== loadSeq) return; // w międzyczasie wybrano inny zakres
    rows = r;
    renderStats();
  } catch {
    if (seq === loadSeq)
      $("statsMessage").textContent = "Nie udało się pobrać historii. Sprawdź połączenie i spróbuj ponownie.";
  }
}

export function initStats() {
  onShowView("stats", loadStats);
  document.querySelectorAll("#statsView .range button").forEach((button) =>
    button.addEventListener("click", () => {
      document.querySelectorAll("#statsView .range button").forEach((x) => x.classList.remove("active"));
      button.classList.add("active");
      days = Number(button.dataset.days) || 1;
      loadStats();
    }),
  );
  window.addEventListener("resize", () => {
    if (!$("statsView").hidden && rows.length) renderStats();
  });
}
