import "../raspberry/alarm-schema.js";
import { $, S, dbRef, el, fb, now, onShowView, user } from "./state.js";
import { isFresh, parseDecimal } from "./logic.js";

const A = globalThis.POMPA_ALARM_SCHEMA;
const levels = { info: "Informacja", ostrzezenie: "Ostrzeżenie", awaria: "Awaria", auto: "Automatyczna" };
let saved = A.defaults(),
  draft = A.defaults(),
  loaded = false,
  dirty = false,
  denied = false,
  busy = false,
  backend = null;
let errorMessage = "";
const clone = (value) => structuredClone(value);

function changed() {
  dirty = true;
  errorMessage = "";
  renderAlarmSettingsStatus();
}
function field(label, control) {
  control.setAttribute("aria-label", label);
  return el("label", { className: "alarm-setting-field" }, el("span", { textContent: label }), control);
}
function numberInput(value, min, max, step, onChange, key) {
  const input = el("input", { type: "number", min, max, step, value });
  if (key) input.dataset.setting = key;
  input.addEventListener("input", () => {
    onChange(parseDecimal(input.value));
    changed();
  });
  return input;
}
function select(options, value, onChange) {
  const input = el("select");
  input.append(...Object.entries(options).map(([key, label]) => el("option", { value: key, textContent: label })));
  input.value = value;
  input.addEventListener("change", () => {
    onChange(input.value);
    changed();
  });
  return input;
}
function toggle(label, value, onChange) {
  const input = el("input", { type: "checkbox", checked: value });
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => {
    onChange(input.checked);
    changed();
  });
  return field(label, input);
}
function ruleControls(r, definition) {
  const common = el(
    "div",
    { className: "alarm-setting-grid" },
    field(
      "Ważność",
      select(levels, r.poziom, (value) => {
        r.poziom = value;
      }),
    ),
    toggle("Powiadomienia push", r.push, (value) => {
      r.push = value;
    }),
  );
  if (!definition.event)
    common.append(
      field(
        "Warunek trwa przez (s)",
        numberInput(r.opoznienieS, 0, 7200, 1, (value) => {
          r.opoznienieS = value;
        }),
      ),
      field(
        "Zakończ po ustąpieniu (s)",
        numberInput(r.zakonczenieS, 0, 7200, 1, (value) => {
          r.zakonczenieS = value;
        }),
      ),
    );
  return common;
}
function renderRules() {
  const container = $("alarmRuleGroups");
  const expanded = new Set([...container.querySelectorAll("details[open]")].map((node) => node.dataset.group));
  container.replaceChildren();
  for (const group of [...new Set(Object.values(A.RULES).map((r) => r.group))]) {
    const entries = Object.entries(A.RULES).filter(([, r]) => r.group === group);
    const details = el(
      "details",
      { className: "alarm-setting-group" },
      el("summary", { textContent: `${group} · ${entries.length} reguł` }),
    );
    details.dataset.group = group;
    details.open = expanded.has(group);
    for (const [id, definition] of entries) {
      const r = draft.reguly[id];
      const card = el(
        "article",
        { className: "alarm-rule", id: "rule-" + id },
        el(
          "div",
          { className: "alarm-rule-heading" },
          el("h3", { textContent: definition.title }),
          toggle("Włącz: " + definition.title, r.wlaczony, (value) => {
            r.wlaczony = value;
          }),
        ),
        ruleControls(r, definition),
      );
      card.dataset.search = [definition.title, group, ...definition.fields.map((key) => A.PROGI[key].label)].join(" ");
      const enable = card.querySelector('input[type="checkbox"]');
      enable.parentElement.querySelector("span").textContent = "Włączona";
      card.classList.toggle("is-disabled", !r.wlaczony);
      enable.addEventListener("change", () => card.classList.toggle("is-disabled", !r.wlaczony));
      for (const key of definition.fields) {
        const p = A.PROGI[key];
        card.append(
          field(
            `${p.label}${p.unit ? " (" + p.unit + ")" : ""}`,
            numberInput(
              draft.progi[key],
              p.min,
              p.max,
              p.step,
              (value) => {
                draft.progi[key] = value;
              },
              key,
            ),
          ),
        );
      }
      if (id === "skokMocySpadek" || id === "skokNapiecia")
        card.append(
          el("p", {
            className: "small",
            textContent: "Okno porównania i tolerancja częstotliwości są wspólne z regułą nagłego wzrostu mocy.",
          }),
        );
      details.append(card);
    }
    container.append(details);
  }
  const shared = el(
    "details",
    { className: "alarm-setting-group" },
    el("summary", { textContent: "Odstęp powiadomień o powtarzających się zdarzeniach" }),
  );
  const p = A.PROGI.cooldownZdarzenMin;
  shared.append(
    field(
      p.label + " (min)",
      numberInput(
        draft.progi.cooldownZdarzenMin,
        p.min,
        p.max,
        p.step,
        (v) => {
          draft.progi.cooldownZdarzenMin = v;
        },
        "cooldownZdarzenMin",
      ),
    ),
  );
  container.append(shared);
  shared.dataset.group = "shared";
  shared.open = expanded.has("shared");
}
function filterRules() {
  const normalize = (value) =>
    String(value)
      .toLocaleLowerCase("pl-PL")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
  const query = normalize($("alarmRuleSearch").value.trim());
  let matches = 0;
  for (const group of $("alarmRuleGroups").querySelectorAll("details")) {
    const cards = [...group.querySelectorAll(".alarm-rule")];
    let visible = 0;
    for (const card of cards) {
      card.hidden = !!query && !normalize(card.dataset.search).includes(query);
      if (!card.hidden) visible++;
    }
    if (!cards.length) visible = !query || normalize(group.textContent).includes(query) ? 1 : 0;
    group.hidden = !visible;
    if (query && visible) group.open = true;
    matches += visible;
  }
  for (const card of $("customAlarmList").querySelectorAll(".alarm-rule")) {
    const r = draft.wlasne[card.dataset.customId];
    card.hidden = !!query && !normalize(r.tytul + " " + A.METRICS[r.pomiar].title).includes(query);
    if (!card.hidden) matches++;
  }
  $("alarmSearchEmpty").hidden = !query || matches > 0;
}
function renderCustom() {
  const list = $("customAlarmList");
  list.replaceChildren();
  for (const [id, r] of Object.entries(draft.wlasne || {})) {
    const title = el("input", { type: "text", maxLength: 100, value: r.tytul });
    title.addEventListener("input", () => {
      r.tytul = title.value;
      changed();
    });
    const thresholds = numberInput(r.prog, A.METRICS[r.pomiar].min, A.METRICS[r.pomiar].max, "any", (v) => {
      r.prog = v;
    });
    const unit = el("span", { textContent: `Próg (${A.METRICS[r.pomiar].unit || "bez jednostki"})` });
    const measurement = select(
      Object.fromEntries(Object.entries(A.METRICS).map(([k, m]) => [k, m.title + (m.unit ? " · " + m.unit : "")])),
      r.pomiar,
      (value) => {
        r.pomiar = value;
        const m = A.METRICS[value];
        thresholds.min = m.min;
        thresholds.max = m.max;
        unit.textContent = `Próg (${m.unit || "bez jednostki"})`;
      },
    );
    const remove = el("button", { type: "button", className: "secondary", textContent: "Usuń z projektu ustawień" });
    remove.addEventListener("click", () => {
      delete draft.wlasne[id];
      changed();
      renderCustom();
    });
    const card = el(
      "article",
      { className: "alarm-rule" },
      toggle("Włącz własny alert", r.wlaczony, (value) => {
        r.wlaczony = value;
      }),
      field("Nazwa alertu", title),
      el(
        "div",
        { className: "alarm-setting-grid" },
        field("Pomiar", measurement),
        field(
          "Warunek",
          select({ lt: "Poniżej progu", gt: "Powyżej progu" }, r.operator, (v) => {
            r.operator = v;
          }),
        ),
        el("label", { className: "alarm-setting-field" }, unit, thresholds),
        toggle("Tylko podczas pracy pompy", r.tylkoPraca, (v) => {
          r.tylkoPraca = v;
        }),
      ),
      ruleControls(r, {}),
      remove,
    );
    card.dataset.customId = id;
    list.append(card);
  }
  $("addCustomAlarm").disabled = Object.keys(draft.wlasne || {}).length >= 30 || !loaded || denied || busy;
  filterRules();
}
function renderEditor() {
  renderRules();
  renderCustom();
  renderAlarmSettingsStatus();
}
export function resetAlarmSettings() {
  S.alarmCfg = null;
  saved = A.defaults();
  draft = clone(saved);
  loaded = dirty = denied = busy = false;
  backend = null;
  errorMessage = "";
  $("alarmRuleSearch").value = "";
  renderEditor();
}
export function setAlarmSettings(snapshot) {
  const value = snapshot.val() || A.defaults();
  const error = A.validate(value);
  if (error) {
    errorMessage = "Zapisane ustawienia są nieprawidłowe: " + error;
    denied = true;
    renderAlarmSettingsStatus();
    return;
  }
  saved = { ...value, wlasne: value.wlasne || {} };
  S.alarmCfg = saved;
  loaded = true;
  denied = false;
  if (!dirty) {
    draft = clone(saved);
    renderEditor();
  } else renderAlarmSettingsStatus();
}
export function alarmSettingsDenied() {
  denied = true;
  errorMessage = "Brak dostępu do ustawień alarmów. Sprawdź uprawnienia konta.";
  renderAlarmSettingsStatus();
}
export function setAlarmBackend(snapshot) {
  backend = snapshot.val();
  renderAlarmSettingsStatus();
}
export function renderAlarmSettingsStatus() {
  $("alarmSettingsFields").disabled = !loaded || denied || busy;
  $("saveAlarmSettings").disabled = !loaded || denied || busy || !dirty || !S.connected;
  $("discardAlarmSettings").disabled = !loaded || busy;
  $("alarmSettingsMessage").textContent =
    errorMessage ||
    (busy
      ? "Zapisywanie…"
      : dirty
        ? "Masz niezapisane zmiany."
        : loaded
          ? "Ustawienia zapisane."
          : "Pobieranie ustawień…");
  const fresh = /^2\./.test(backend?.wersja || "") && isFresh(backend.aktualizacja, now(), 90000);
  $("alarmBackendState").textContent = !fresh
    ? "Oczekiwanie na potwierdzenie serwisu alarmów Raspberry."
    : backend.ustawieniaId === (saved.id || "domyslne")
      ? "Raspberry stosuje zapisane ustawienia."
      : "Raspberry jeszcze nie potwierdziło nowych ustawień.";
  $("alarmSettingsSummary").textContent =
    Object.values(draft.reguly).filter((r) => r.wlaczony).length +
    " włączonych reguł · " +
    Object.keys(draft.wlasne || {}).length +
    " własnych alertów";
}
async function saveSettings(event) {
  event.preventDefault();
  if (!loaded || denied || busy || !user() || !S.connected) return;
  const error = A.validate(draft);
  if (error) {
    errorMessage = error;
    renderAlarmSettingsStatus();
    return;
  }
  const target = { ...clone(draft), id: crypto.randomUUID(), zmieniono: now(), zmienil: user().email || "" };
  const baseId = draft.id || "domyslne";
  busy = true;
  renderAlarmSettingsStatus();
  try {
    const result = await fb.runTransaction(
      dbRef("pompa/ustawienia/alarmy"),
      (current) => ((current?.id || "domyslne") === baseId ? target : undefined),
      { applyLocally: false },
    );
    if (!result.committed) throw new Error("conflict");
    saved = target;
    draft = clone(target);
    dirty = false;
    errorMessage = "";
  } catch (error) {
    errorMessage =
      error.message === "conflict"
        ? "Ustawienia zmieniono na innym urządzeniu. Wybierz „Wczytaj zapisane”, a następnie ponów swoje zmiany."
        : "Nie udało się zapisać ustawień. Sprawdź internet i uprawnienia konta.";
  } finally {
    busy = false;
    if (!dirty) renderEditor();
    else renderAlarmSettingsStatus();
  }
}
export function initAlarmSettings() {
  $("alarmRuleSearch").addEventListener("input", filterRules);
  $("alarmSettingsForm").addEventListener("submit", saveSettings);
  $("discardAlarmSettings").addEventListener("click", () => {
    draft = clone(saved);
    dirty = false;
    errorMessage = "";
    renderEditor();
  });
  $("addCustomAlarm").addEventListener("click", () => {
    if (!loaded || denied || Object.keys(draft.wlasne).length >= 30) return;
    const id = Array.from({ length: 30 }, (_, i) => "rule_" + (i + 1)).find((key) => !draft.wlasne[key]);
    draft.wlasne[id] = {
      tytul: "Nowy alert",
      pomiar: "poziomWodyProc",
      operator: "lt",
      prog: 20,
      tylkoPraca: false,
      wlaczony: true,
      poziom: "ostrzezenie",
      push: true,
      opoznienieS: 30,
      zakonczenieS: 60,
    };
    changed();
    renderCustom();
  });
  onShowView("alarms", renderAlarmSettingsStatus);
  resetAlarmSettings();
  setInterval(renderAlarmSettingsStatus, 15000);
}
