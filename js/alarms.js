// Zakładka „Alarmy”: lista awarii i ostrzeżeń, potwierdzanie, baner aktywnej awarii i powiadomienie w aplikacji.
import { ALARM_LEVELS, canAck, duration, filterAlarms, isNum, needsReview } from "./logic.js";
import { $, S, dbRef, el, fb, now, onShowView, showView, user } from "./state.js";

let filter = "open",
  toastTimer = null;

const tShort = (t) =>
  isNum(t)
    ? new Date(t).toLocaleString("pl-PL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

/** Wpisy z bazy mogą być niekompletne — zostaw tylko obiekty. */
export function setAlarms(snapshot) {
  const list = [];
  snapshot.forEach((c) => {
    const v = c.val();
    if (v && typeof v === "object") list.push({ ...v, id: c.key });
  });
  S.alarms = list.reverse();
  renderAlarms();
}

function alarmItem(a) {
  const live = a.aktywny === true,
    top = el(
      "div",
      { className: "alarm-top" },
      el("span", { className: "lvl", textContent: ALARM_LEVELS[a.poziom] || "Informacja" }),
    );
  if (live) top.append(el("span", { className: "live-tag", textContent: "trwa" }));
  top.append(
    a.zdarzenie
      ? "Zdarzenie " + tShort(a.czas)
      : live
        ? "Od " + tShort(a.czas) + " · " + duration(now() - a.czas)
        : tShort(a.czas) +
          (isNum(a.zakonczono) ? " – " + tShort(a.zakonczono) + " (" + duration(a.zakonczono - a.czas) + ")" : ""),
  );
  const li = el(
    "li",
    { className: "alarm " + (ALARM_LEVELS[a.poziom] ? a.poziom : "info") + (live ? " live" : "") },
    top,
    el("h3", { textContent: String(a.tytul || a.typ || "Alarm") }),
    el("p", { textContent: String(a.opis || "") }),
  );
  const foot = el("div", { className: "alarm-foot" });
  if (a.potwierdzono) foot.append("Potwierdził " + (a.potwierdzil || "użytkownik") + ", " + tShort(a.potwierdzono));
  else if (a.poziom !== "info") {
    foot.append(live ? "Warunek nadal występuje" : "Niepotwierdzone");
    const b = el("button", {
      type: "button",
      className: "secondary",
      textContent: "Potwierdź",
      disabled: !S.connected,
    });
    b.addEventListener("click", () => ackAlarms([a.id]));
    foot.append(b);
  }
  if (foot.childNodes.length) li.append(foot);
  return li;
}

export function renderAlarms() {
  const alarms = S.alarms,
    open = alarms.filter(needsReview),
    crit = alarms.filter((a) => a.aktywny === true && a.poziom === "awaria");
  $("alarmBadge").hidden = !open.length;
  $("alarmBadge").textContent = open.length > 99 ? "99+" : String(open.length);
  $("alarmBadge").classList.toggle(
    "crit",
    open.some((a) => a.poziom === "awaria"),
  );
  $("alarmBanner").hidden = !crit.length;
  $("alarmBannerText").textContent = crit.length
    ? `Aktywna awaria: ${crit[0].tytul || crit[0].typ || "Alarm"}${crit.length > 1 ? ` (+${crit.length - 1})` : ""} — otwórz Alarmy`
    : "";
  if ($("alarmsView").hidden) return;

  const list = filterAlarms(alarms, filter);
  $("alarmMessage").textContent = !alarms.length
    ? "Brak zapisanych alarmów. Wpisy pojawią się, gdy serwis alarmów na Raspberry wykryje awarię lub nagłą zmianę parametrów."
    : !list.length
      ? filter === "open"
        ? "Nic do przejrzenia — wszystkie alarmy są zakończone i potwierdzone."
        : "Brak wpisów w tym filtrze."
      : "";
  $("alarmList").replaceChildren(...list.slice(0, 150).map(alarmItem));
  const ended = alarms.filter(canAck);
  $("ackAll").hidden = ended.length < 2;
  $("ackAll").textContent = `Potwierdź wszystkie zakończone (${ended.length})`;
}

async function ackAlarms(ids) {
  const u = user();
  if (!ids.length || !u) return;
  const t = now(),
    upd = {};
  for (const id of ids) {
    upd[id + "/potwierdzono"] = t;
    upd[id + "/potwierdzil"] = u.email || "";
  }
  try {
    await fb.update(dbRef("pompa/alarmy"), upd);
  } catch {
    $("alarmMessage").textContent = "Nie udało się potwierdzić. Sprawdź połączenie i reguły bazy (pompa/alarmy).";
  }
}

export function alarmsDenied() {
  $("alarmMessage").textContent = "Brak dostępu do alarmów — sprawdź reguły bazy (pompa/alarmy).";
}

/** Powiadomienie wyświetlane, gdy aplikacja jest otwarta (push na pierwszym planie). */
export function showToast(d) {
  if (!d?.tytul) return;
  $("toastTitle").textContent = d.tytul;
  $("toastBody").textContent = d.tresc || "";
  $("toast").className = "toast " + (["awaria", "ostrzezenie", "info"].includes(d.poziom) ? d.poziom : "");
  $("toast").hidden = false;
  if (d.poziom === "awaria") navigator.vibrate?.([300, 150, 300]);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), d.poziom === "awaria" ? 20000 : 9000);
}

export function initAlarms() {
  onShowView("alarms", renderAlarms);
  $("alarmBanner").addEventListener("click", () => showView("alarms"));
  $("toast").addEventListener("click", () => {
    $("toast").hidden = true;
    showView("alarms");
  });
  $("ackAll").addEventListener("click", () => ackAlarms(S.alarms.filter(canAck).map((a) => a.id)));
  document.querySelectorAll("#alarmFilter button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#alarmFilter button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      filter = b.dataset.f;
      renderAlarms();
    }),
  );
  // czas trwania aktywnych alarmów
  setInterval(() => !$("alarmsView").hidden && renderAlarms(), 60000);
}
