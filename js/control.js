// Zakładka „Sterowanie”: polecenia dla falownika, limit mocy i licznik mocy.
import {
  CFG,
  activeLimit,
  analyzeChange,
  changePreview,
  clamp,
  currentSetpoint,
  driveStateText,
  energyDigits,
  f1,
  fmt,
  isNum,
  parseDecimal,
  powerReading,
  validHz,
  validateLimit,
} from "./logic.js";
import { $, S, dbRef, el, fb, isLive, now, safe, user } from "./state.js";

const { silnik: M, progi: P } = CFG;

// ---------- stan sterowania ----------
const cmd = { busy: false, id: null, timer: null };
let controlDirty = false, // użytkownik zmienia częstotliwość — nie nadpisuj jej statusem
  limitDirty = false; // niezapisane zmiany limitu

/** Start i zmiana częstotliwości: tylko przy świeżych danych, połączonym falowniku i bez awarii. */
const canDrive = () => !!user() && isLive() && S.status?.polaczony === true && S.status?.awaria !== true;
/**
 * Stop: zawsze, gdy aplikacja ma połączenie z bazą — także przy nieaktualnych danych z Raspberry
 * albo przy awarii. Zatrzymanie nie może zależeć od tego, czy działa odczyt pomiarów.
 */
const canStop = () => !!user() && !S.denied && S.connected;

export function resetControl() {
  clearTimeout(cmd.timer);
  Object.assign(cmd, { busy: false, id: null, timer: null });
  controlDirty = false;
  limitDirty = false;
}

// ---------- licznik mocy (SVG) ----------
const G = { cx: 130, cy: 130, r: 100, a0: 210, sweep: 240 };
const gAng = (kw) => G.a0 - (G.sweep * clamp(kw, 0, M.mocSkaliKw)) / M.mocSkaliKw;
const gPt = (deg, r) => [G.cx + r * Math.cos((deg * Math.PI) / 180), G.cy - r * Math.sin((deg * Math.PI) / 180)];
function gArc(k1, k2) {
  const [x1, y1] = gPt(gAng(k1), G.r),
    [x2, y2] = gPt(gAng(k2), G.r),
    large = Math.abs(gAng(k1) - gAng(k2)) > 180 ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${G.r} ${G.r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
function buildGauge() {
  const max = M.mocSkaliKw,
    rated = M.mocZnamionowaKw;
  let h =
    `<path class="g-track" d="${gArc(0, max)}"/><path class="g-zone" d="${gArc(rated, max)}"/>` +
    `<path id="gFill" class="g-fill" d=""/>`;
  for (let k = 0; k <= max; k += 5) {
    const major = k % 10 === 0,
      [x1, y1] = gPt(gAng(k), G.r - 11),
      [x2, y2] = gPt(gAng(k), G.r - (major ? 22 : 17));
    h += `<line class="g-tick${major ? " major" : ""}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    // podpisy co 20 kW, na końcu skali i przy mocy znamionowej (bez tych, które nachodzą na podpis końca skali)
    if ((k % 20 === 0 && max - k > 10) || k === max || k === rated) {
      const [tx, ty] = gPt(gAng(k), G.r - 33);
      h += `<text class="g-num${k === rated ? " rated" : ""}" x="${tx.toFixed(1)}" y="${(ty + 3.5).toFixed(1)}" text-anchor="middle">${k}</text>`;
    }
  }
  const [nx, ny] = gPt(90, G.r - 8);
  h +=
    `<g id="gNeedle" class="g-needle" style="transform:rotate(-120deg)"><line x1="130" y1="130" x2="${nx}" y2="${ny}"/></g>` +
    `<circle class="g-hub" cx="130" cy="130" r="7"/>` +
    `<path id="gLimit" class="g-limit" d="M130 21 L123 8 L137 8 Z" style="display:none;transform:rotate(0deg)"/>`;
  $("gaugeSvg").innerHTML = h; // wyłącznie stałe i liczby z konfiguracji
  $("ratedNote").textContent = `${M.mocZnamionowaKw} kW = 100%`;
}

let lastEnergy = null;
function renderEnergy() {
  const e = S.status?.energia,
    key = isNum(e) ? Math.floor(e) : null;
  if (key === lastEnergy && $("energy").childElementCount) return; // bez przebudowy co 5 s
  lastEnergy = key;
  $("energy").replaceChildren(
    ...energyDigits(e).map(({ d, lead }) => el("span", { textContent: d, className: lead ? "lead" : "" })),
    el("em", { textContent: "kWh" }),
  );
}

function renderPower(live) {
  const s = S.status,
    p = s ? powerReading(s) : null,
    kw = p ? Math.max(0, p.kw) : null,
    over = kw !== null && kw > M.mocZnamionowaKw,
    load = kw === null ? null : (kw / M.mocZnamionowaKw) * 100;
  $("power").textContent = kw === null ? "—" : fmt(kw);
  $("power").classList.toggle("est", !!p?.est);
  $("gFill").setAttribute("d", kw > 0.05 ? gArc(0, kw) : "");
  $("gFill").classList.toggle("over", over);
  $("gNeedle").style.transform = `rotate(${(90 - gAng(kw ?? 0)).toFixed(1)}deg)`;
  $("powerLoad").textContent = load === null ? "— %" : fmt(load, " %", 0);
  // pasek obejmuje całą skalę licznika (do mocSkaliKw), więc 100% obciążenia jest przed jego końcem
  $("loadFill").style.width =
    (load === null ? 0 : Math.min(100, (load * M.mocZnamionowaKw) / M.mocSkaliKw)).toFixed(1) + "%";
  $("loadFill").classList.toggle("over", over);
  renderEnergy();

  const lim = activeLimit(S.limitCfg),
    la = live && s?.limitAktywny === true;
  $("gLimit").style.display = lim === null ? "none" : "";
  if (lim !== null) $("gLimit").style.transform = `rotate(${(90 - gAng(lim)).toFixed(1)}deg)`;
  $("limitState").hidden = lim === null;
  $("limitState").classList.toggle("on", la);
  $("limitStateText").textContent =
    lim === null
      ? ""
      : la
        ? `Limit ${fmt(lim, " kW", 0)} aktywny · obniżono do ${fmt(s?.czestotliwoscZadana, " Hz")}` +
          (isNum(s?.czestotliwoscCel) ? ` (zadane ${fmt(s.czestotliwoscCel, " Hz")})` : "")
        : `Limit ${fmt(lim, " kW", 0)} · czuwa`;
  $("powerNote").classList.toggle("warn", over || !!p?.est);
  $("powerNote").textContent =
    kw === null
      ? "Brak odczytu"
      : !live
        ? "Ostatni zapis · dane nieaktualne"
        : p.est
          ? "Szacunkowo z prądu i napięcia"
          : over
            ? "Powyżej mocy znamionowej"
            : "Odczyt z falownika";
}

// ---------- częstotliwość ----------
function syncFrequency(value, source) {
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  const hz = clamp(Math.round(n * 10) / 10, 0, M.maxHz);
  if (source !== "number") $("controlHz").value = hz.toFixed(1);
  if (source !== "slider") $("controlHzSlider").value = String(hz);
  $("controlHzValue").textContent = f1(hz) + " Hz";
  const pct = (hz / M.maxHz) * 100;
  $("controlHzSlider").style.background =
    `linear-gradient(90deg,var(--accent) 0%,var(--accent) ${pct}%,#294238 ${pct}%,#294238 100%)`;
  renderPreview();
}

/** Ustaw suwak na bieżącą częstotliwość zadaną, jeśli użytkownik jej właśnie nie zmienia. */
export function syncFromStatus() {
  if (controlDirty) return;
  const sp = currentSetpoint(S.status),
    a = document.activeElement;
  if (sp !== null && a !== $("controlHz") && a !== $("controlHzSlider")) syncFrequency(sp);
}

function renderPreview() {
  const { text, warn } = changePreview({
    status: S.status,
    live: isLive(),
    hz: parseDecimal($("controlHz").value),
    limitCfg: S.limitCfg,
  });
  $("controlPreview").textContent = text;
  $("controlPreview").classList.toggle("warn", warn);
}

// ---------- limit mocy ----------
export function fillLimit() {
  const c = S.limitCfg;
  if (limitDirty || !c) return;
  $("limitOn").checked = !!c.wlaczony;
  if (isNum(c.kw)) $("limitKw").value = c.kw;
  if (isNum(c.minHz)) $("limitMinHz").value = c.minHz;
}

async function saveLimit() {
  const r = validateLimit({
    on: $("limitOn").checked,
    kw: parseDecimal($("limitKw").value),
    minHz: parseDecimal($("limitMinHz").value),
  });
  if (r.error) {
    $("limitMsg").textContent = r.error;
    $(r.field).focus();
    return;
  }
  const cfg = { ...r.cfg, zmieniono: now(), zmienil: user()?.email || "" };
  $("saveLimit").disabled = true;
  $("limitMsg").textContent = "Zapisywanie…";
  try {
    await fb.set(dbRef("pompa/ustawienia/limitMocy"), cfg);
    limitDirty = false;
    $("limitMsg").textContent = cfg.wlaczony
      ? `Zapisano: limit ${cfg.kw} kW, nie niżej niż ${cfg.minHz.toLocaleString("pl-PL")} Hz.`
      : "Zapisano: automatyczny limit wyłączony.";
  } catch {
    $("limitMsg").textContent =
      "Nie udało się zapisać. Sprawdź połączenie i uprawnienia konta (zapis do pompa/ustawienia).";
  } finally {
    renderControl();
  }
}

// ---------- polecenia ----------
function askConfirm({ title, lead, items, ok, hot }) {
  const d = $("confirmDlg");
  if (typeof d.showModal !== "function")
    return Promise.resolve(confirm([title, lead, ...items.map((i) => "• " + i.t)].join("\n")));
  $("dlgTitle").textContent = title;
  $("dlgLead").textContent = lead || "";
  $("dlgList").replaceChildren(
    ...items.map((i) => el("li", { className: i.hot ? "hot" : "" }, el("b", { textContent: i.t }), i.d)),
  );
  $("dlgList").hidden = !items.length;
  $("dlgOk").textContent = ok;
  $("dlgOk").classList.toggle("warn-btn", !!hot);
  return new Promise((res) => {
    d.returnValue = "";
    d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true });
    d.showModal();
    $("dlgCancel").focus();
  });
}

const message = (t) => ($("commandMessage").textContent = t);

async function sendCommand(action) {
  const stop = action === "stop";
  if (stop ? !canStop() : cmd.busy || !canDrive()) return;
  let hz = null;
  if (!stop) {
    hz = validHz($("controlHz").value);
    if (hz === null) {
      message(`Podaj częstotliwość od 0 do ${M.maxHz} Hz.`);
      $("controlHz").focus();
      return;
    }
    if (action === "start" && hz <= 0) {
      message("Podaj częstotliwość większą od 0 Hz, aby uruchomić pompę.");
      $("controlHz").focus();
      return;
    }
    const starting = action === "start" && S.status?.pracuje !== true,
      a = analyzeChange({ status: S.status, live: isLive(), hz, limitCfg: S.limitCfg });
    if (starting || a.items.length) {
      const ok = await askConfirm({
        title: starting ? "Uruchomić pompę?" : "Potwierdź zmianę częstotliwości",
        lead: starting ? `Pompa ruszy i rozpędzi się do ${f1(hz)} Hz.` : `Nowa częstotliwość zadana: ${f1(hz)} Hz.`,
        items: a.items,
        ok: starting ? "Uruchom" : a.hot ? "Tak, zmień" : "Zmień",
        hot: a.hot,
      });
      if (!ok) return message("Anulowano — polecenie nie zostało wysłane.");
      // Okno mogło być otwarte długo — sprawdź stan ponownie przed wysłaniem.
      if (cmd.busy || !canDrive()) {
        message("Stan pompy lub połączenia zmienił się — polecenie nie zostało wysłane.");
        return renderControl();
      }
    }
  }

  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    t = now(),
    // wazneDo: Raspberry może odrzucić polecenie, które dotarło z opóźnieniem (np. po odzyskaniu zasięgu).
    command = { id, akcja: action, czas: t, wazneDo: t + P.potwierdzeniePoleceniaMs };
  if (hz !== null) command.czestotliwosc = hz;
  Object.assign(cmd, { busy: true, id });
  message(stop ? "Wysyłanie polecenia zatrzymania…" : "Wysyłanie polecenia do falownika…");
  renderControl();
  clearTimeout(cmd.timer);
  cmd.timer = setTimeout(() => {
    if (cmd.id !== id || !cmd.busy) return;
    cmd.busy = false;
    message(
      `Brak potwierdzenia z Raspberry w ciągu ${P.potwierdzeniePoleceniaMs / 1000} s. Sprawdź stan pompy, zanim ponowisz polecenie.`,
    );
    renderControl();
  }, P.potwierdzeniePoleceniaMs);
  try {
    await fb.set(dbRef("pompa/polecenie"), command);
  } catch {
    if (cmd.id !== id) return;
    clearTimeout(cmd.timer);
    cmd.busy = false;
    message("Nie udało się wysłać polecenia. Sprawdź połączenie i uprawnienia konta.");
    renderControl();
  }
}

/** Odpowiedź Raspberry na polecenie (pompa/polecenie z polem `wykonane`). */
export function onCommandUpdate(command) {
  if (!command || command.id !== cmd.id || typeof command.wykonane !== "boolean") return;
  clearTimeout(cmd.timer);
  cmd.busy = false;
  if (command.wykonane) controlDirty = false;
  message(
    command.wykonane
      ? "Polecenie zostało wykonane przez falownik."
      : "Polecenie odrzucone: " + String(command.blad || "brak potwierdzenia"),
  );
  renderControl();
}

// ---------- renderowanie ----------
export function renderControl(live = isLive()) {
  const s = S.status,
    u = !!user(),
    drive = canDrive() && !cmd.busy,
    stop = canStop();
  $("pumpState").textContent = driveStateText(s, live);
  $("hz").textContent = fmt(s?.czestotliwoscWyjsciowa);
  $("current").textContent = fmt(s?.prad, " A");
  $("voltage").textContent = fmt(s?.napiecie, " V");
  $("target").textContent = fmt(s?.czestotliwoscZadana, " Hz");
  $("fault").textContent = !s
    ? "Brak danych o stanie urządzenia"
    : s.awaria
      ? String(s.kodAwarii || "Awaria")
      : live && s.polaczony
        ? "Brak zgłoszonej awarii"
        : "Oczekiwanie na potwierdzenie stanu";
  const inputs = u && live && s?.polaczony === true && !cmd.busy;
  $("controlHz").disabled = !inputs;
  $("controlHzSlider").disabled = !inputs;
  $("startPump").disabled = !drive;
  $("setFrequency").disabled = !drive;
  $("stopPump").disabled = !stop;
  $("stopNote").hidden = !stop || live;
  $("stopNote").textContent =
    "Brak świeżych danych z Raspberry — Stop i tak zostanie wysłany. Sprawdź potem stan pompy.";
  for (const id of ["limitOn", "limitKw", "limitMinHz", "saveLimit"]) $(id).disabled = !u || S.denied;
  safe(renderPower, live);
  safe(renderPreview);
}

export function initControl() {
  buildGauge();
  syncFrequency(0);
  $("controlHzSlider").addEventListener("input", (e) => {
    controlDirty = true;
    syncFrequency(e.target.value, "slider");
  });
  $("controlHz").addEventListener("input", (e) => {
    controlDirty = true;
    syncFrequency(parseDecimal(e.target.value), "number");
  });
  $("controlHz").addEventListener("change", (e) => syncFrequency(parseDecimal(e.target.value)));
  $("startPump").addEventListener("click", () => sendCommand("start"));
  $("setFrequency").addEventListener("click", () => sendCommand("czestotliwosc"));
  $("stopPump").addEventListener("click", () => sendCommand("stop"));
  for (const id of ["limitOn", "limitKw", "limitMinHz"])
    $(id).addEventListener("input", () => {
      limitDirty = true;
      $("limitMsg").textContent = "Niezapisane zmiany — naciśnij „Zapisz limit”.";
    });
  $("limitOn").addEventListener("change", () => (limitDirty = true));
  $("saveLimit").addEventListener("click", saveLimit);
}
