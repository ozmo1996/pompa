// Notatki instalacji: wspólna lista w Firebase, terminy i oznaczanie wykonania.
import { $, S, dbRef, el, fb, now, user } from "./state.js";

let notes = [],
  editing = null,
  busy = false,
  denied = false;
const dateText = (time) => new Date(time).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" });
const message = (text) => ($("noteMessage").textContent = text);

function resetForm() {
  editing = null;
  $("noteForm").reset();
  $("noteFormTitle").textContent = "Nowa notatka";
  $("noteSave").textContent = "Zapisz notatkę";
  $("noteCancel").hidden = true;
}

function dueTime() {
  const hours = $("noteHours").value.trim(),
    date = $("noteDue").value;
  if (hours && date) throw new Error("Wybierz jeden sposób określenia terminu.");
  if (hours) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h < 0.1 || h > 8760) throw new Error("Podaj liczbę godzin od 0,1 do 8760.");
    return Math.round(now() + h * 3600000);
  }
  if (!date) return null;
  const t = new Date(date).getTime();
  if (!Number.isFinite(t)) throw new Error("Podaj prawidłową datę terminu.");
  return t;
}

function noteItem(note) {
  const li = el("li", { className: "note-item" });
  if (note.wykonane) li.classList.add("done");
  if (!note.wykonane && note.termin && note.termin <= now()) li.classList.add("overdue");
  const head = el("div", { className: "note-item-head" }, el("h4", { textContent: note.tytul }));
  if (note.termin) {
    const due = note.termin <= now() && !note.wykonane;
    head.append(
      el("span", {
        className: "note-due" + (due ? " late" : ""),
        textContent: (due ? "Po terminie · " : "Termin · ") + dateText(note.termin),
      }),
    );
  }
  li.append(head);
  if (note.opis) li.append(el("p", { textContent: note.opis }));
  li.append(el("small", { textContent: "Dodano " + dateText(note.utworzono) }));
  const actions = el("div", { className: "note-actions" });
  const toggle = el("button", {
    type: "button",
    className: "secondary",
    textContent: note.wykonane ? "Przywróć" : "Wykonane",
    disabled: busy,
  });
  toggle.addEventListener("click", () => changeNote(note, { wykonane: !note.wykonane, zmieniono: now() }));
  const edit = el("button", { type: "button", className: "secondary", textContent: "Edytuj", disabled: busy });
  edit.addEventListener("click", () => {
    editing = note.id;
    $("noteTitle").value = note.tytul;
    $("noteBody").value = note.opis || "";
    $("noteHours").value = "";
    const d = note.termin ? new Date(note.termin) : null;
    $("noteDue").value = d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
    $("noteFormTitle").textContent = "Edytuj notatkę";
    $("noteSave").textContent = "Zapisz zmiany";
    $("noteCancel").hidden = false;
    message("");
    $("noteTitle").focus();
  });
  const remove = el("button", { type: "button", className: "secondary", textContent: "Usuń", disabled: busy });
  remove.addEventListener("click", async () => {
    if (!confirm(`Usunąć notatkę „${note.tytul}”?`)) return;
    await write(() => fb.remove(dbRef("pompa/notatki/" + note.id)), "Notatka została usunięta.");
    if (editing === note.id) resetForm();
  });
  actions.append(toggle, edit, remove);
  li.append(actions);
  return li;
}

function renderList() {
  const open = notes.filter((n) => !n.wykonane),
    done = notes.filter((n) => n.wykonane);
  open.sort((a, b) => (a.termin || Infinity) - (b.termin || Infinity) || b.utworzono - a.utworzono);
  done.sort((a, b) => (b.zmieniono || b.utworzono) - (a.zmieniono || a.utworzono));
  $("noteOpenList").replaceChildren(
    ...(open.length
      ? open.map(noteItem)
      : [
          el("li", {
            className: "note-empty",
            textContent: denied ? "Brak dostępu do notatek." : "Brak otwartych notatek.",
          }),
        ]),
  );
  $("noteDoneList").replaceChildren(
    ...(done.length
      ? done.map(noteItem)
      : [el("li", { className: "note-empty", textContent: "Brak wykonanych notatek." })]),
  );
  $("noteOpenCount").textContent = open.length + " do zrobienia";
  $("noteDoneCount").textContent = String(done.length);
  const late = open.filter((n) => n.termin && n.termin <= now()).length;
  $("notesBadge").hidden = !late;
  $("notesBadge").textContent = String(late);
  $("notesBadge").classList.toggle("crit", !!late);
  $("noteSave").disabled = busy || denied || !user() || !S.connected;
}

async function write(action, success) {
  if (busy || denied || !user() || !S.connected) return message("Brak połączenia lub uprawnień do zapisu.");
  busy = true;
  renderList();
  try {
    await action();
    message(success);
  } catch (e) {
    message("Nie udało się zapisać notatki. Sprawdź połączenie i uprawnienia.");
    console.error(e);
  } finally {
    busy = false;
    renderList();
  }
}

async function changeNote(note, fields) {
  await write(() => fb.update(dbRef("pompa/notatki/" + note.id), fields), "Zmieniono status notatki.");
}

export function setNotes(snapshot) {
  denied = false;
  notes = [];
  snapshot?.forEach((child) => {
    const n = child.val();
    if (n && typeof n.tytul === "string" && Number.isFinite(n.utworzono)) notes.push({ ...n, id: child.key });
  });
  renderList();
}

export function notesDenied() {
  denied = true;
  notes = [];
  message("Brak dostępu do notatek. Sprawdź reguły Firebase.");
  renderList();
}

export function resetNotes() {
  notes = [];
  denied = false;
  busy = false;
  resetForm();
  message("");
  renderList();
}

export function initNotes() {
  $("noteHours").addEventListener("input", () => {
    if ($("noteHours").value) $("noteDue").value = "";
  });
  $("noteDue").addEventListener("input", () => {
    if ($("noteDue").value) $("noteHours").value = "";
  });
  $("noteCancel").addEventListener("click", () => {
    resetForm();
    message("");
  });
  $("noteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = $("noteTitle").value.trim(),
      body = $("noteBody").value.trim();
    if (!title) return message("Wpisz temat notatki.");
    let due;
    try {
      due = dueTime();
    } catch (e) {
      return message(e.message);
    }
    const original = notes.find((n) => n.id === editing);
    if (editing && !original) return message("Notatka została zmieniona na innym urządzeniu. Odśwież listę.");
    const id =
      editing || globalThis.crypto?.randomUUID?.() || String(now()) + "-" + Math.random().toString(16).slice(2);
    const data = {
      tytul: title,
      opis: body,
      termin: due,
      utworzono: original?.utworzono || now(),
      autorUid: original?.autorUid || user().uid,
      wykonane: original?.wykonane === true,
      zmieniono: now(),
    };
    await write(
      async () => {
        await fb.set(dbRef("pompa/notatki/" + id), data);
        resetForm();
      },
      editing ? "Notatka została zmieniona." : "Notatka została zapisana.",
    );
  });
  setInterval(renderList, 30000);
  renderList();
}
