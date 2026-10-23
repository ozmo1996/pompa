import { $, el } from "./state.js";

const KEY = "pompa.overview.layout.v1";
const definitions = [
  [
    "summary",
    "Skróty najważniejszych danych",
    ".overview-summary",
    [
      ["summaryPump", "Pompa"],
      ["summaryPressure", "Ciśnienie tłoczenia"],
      ["summaryWater", "Poziom wody"],
      ["summaryPower", "Moc falownika"],
      ["summaryWaterTemp", "Temperatura wody"],
      ["summaryPressureMode", "Regulacja ciśnienia"],
    ],
  ],
  [
    "details",
    "Szczegółowe pomiary",
    ".sensor-grid",
    [
      ["sensorDriveState", "Parametry falownika"],
      ["dischargePressure", "Ciśnienie na tłoczeniu"],
      ["water", "Zbiornik"],
      ["nd20State", "Agregat — ND20"],
      ["weatherStation", "Pogoda"],
      ["valveResult", "Konfiguracja zaworów"],
    ],
  ],
];

export function initOverviewLayout() {
  const view = $("overviewView");
  const groups = definitions.map(([id, name, selector, tiles]) => ({
    id,
    name,
    parent: view.querySelector(selector),
    tiles: tiles.map(([id, label]) => ({ id, label, node: $(id).closest("article") })),
  }));
  const apply = (saved = {}) => {
    for (const group of groups) {
      const byId = new Map(group.tiles.map((tile) => [tile.id, tile]));
      const order = Array.isArray(saved?.[group.id]) ? saved[group.id] : [];
      const valid = [...new Set(order)].filter((id) => byId.has(id));
      group.order = [...valid, ...group.tiles.map((tile) => tile.id).filter((id) => !valid.includes(id))];
      for (const id of group.order) {
        const node = byId.get(id).node;
        node.dataset.overviewTile = id;
        group.parent.append(node); // przeniesienie, nie klon: pomiary i wykresy zachowują obsługę
      }
    }
    view.querySelector(".overview-secondary").hidden = true;
  };
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(KEY));
  } catch {}
  apply(saved);

  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(groups.map((g) => [g.id, g.order]))));
      $("overviewLayoutMessage").textContent = "Układ zapisany na tym urządzeniu.";
    } catch {
      $("overviewLayoutMessage").textContent =
        "Układ zmieniony, ale przeglądarka nie pozwoliła go zapamiętać. Po odświeżeniu może wrócić poprzedni.";
    }
  };
  const render = () => {
    $("overviewLayoutLists").replaceChildren(
      ...groups.map((group) => {
        const list = el("ol", { className: "layout-list", ariaLabel: group.name });
        for (const [index, id] of group.order.entries()) {
          const tile = group.tiles.find((t) => t.id === id);
          const row = el("li", {}, el("span", { textContent: tile.label }));
          for (const [delta, symbol, label] of [
            [-1, "↑", "Przesuń wcześniej"],
            [1, "↓", "Przesuń później"],
          ]) {
            const button = el("button", {
              type: "button",
              textContent: symbol,
              disabled: index + delta < 0 || index + delta >= group.order.length,
            });
            button.setAttribute("aria-label", label + ": " + tile.label);
            button.dataset.layoutMove = id + ":" + delta;
            button.addEventListener("click", () => {
              const next = [...group.order];
              [next[index], next[index + delta]] = [next[index + delta], next[index]];
              apply(Object.fromEntries(groups.map((g) => [g.id, g === group ? next : g.order])));
              persist();
              render();
              const candidates = [...$("overviewLayoutLists").querySelectorAll("button")];
              (
                candidates.find((b) => b.dataset.layoutMove === id + ":" + delta && !b.disabled) ||
                candidates.find((b) => b.dataset.layoutMove.startsWith(id + ":") && !b.disabled)
              )?.focus();
            });
            row.append(button);
          }
          list.append(row);
        }
        return el("section", {}, el("h3", { textContent: group.name }), list);
      }),
    );
  };
  $("editOverviewLayout").addEventListener("click", () => {
    const panel = $("overviewLayoutPanel");
    panel.hidden = !panel.hidden;
    $("editOverviewLayout").setAttribute("aria-expanded", String(!panel.hidden));
    $("editOverviewLayout").textContent = panel.hidden ? "Ułóż kafelki" : "Gotowe";
    if (!panel.hidden) render();
  });
  $("resetOverviewLayout").addEventListener("click", () => {
    apply();
    persist();
    render();
  });
}
