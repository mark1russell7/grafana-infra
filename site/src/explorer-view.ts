/**
 * The dashboard explorer. The panels stand on their real grid positions. A click on a panel shows its real queries and the
 * recording rules that feed it. A click on a rule shows the panels that depend on it. No panel shows a value.
 */

import { byId, h } from "@mark1russell7/site-pages/chrome";
import { excerpt } from "./excerpt.ts";
import { panelMatches, panelsReading, panelsSharing, ruleMatrix, shortMetric, signalOf, type PanelFilter } from "./model.ts";
import { snapshot, update } from "./state.ts";
import type { Dashboard, Panel, Rule } from "./stack/types.ts";

type Selection = { readonly kind: "panel"; readonly id: number } | { readonly kind: "rule"; readonly record: string };

const view = {
  dashboard: 0,
  filter: "all" as PanelFilter,
  search: "",
  fit: false,
  selection: null as Selection | null,
};

const SPAN_METRICS = "traces_spanmetrics_";

function dashboard(): Dashboard {
  return snapshot.dashboards[view.dashboard]!;
}

function realPanels(board: Dashboard): Panel[] {
  return board.panels.filter((panel) => panel.type !== "row");
}

function ruleOf(record: string): Rule {
  return snapshot.rules.find((rule) => rule.record === record)!;
}

function sourceName(uid: string): string {
  return snapshot.datasources.find((source) => source.uid === uid)?.name ?? uid;
}

function selectedPanel(): Panel | undefined {
  const selection = view.selection;
  return selection?.kind === "panel" ? dashboard().panels.find((panel) => panel.id === selection.id) : undefined;
}

function firstPanel(board: Dashboard): Selection | null {
  const panel = realPanels(board).find((entry) => entry.rules.length > 0) ?? realPanels(board)[0];
  return panel === undefined ? null : { kind: "panel", id: panel.id };
}

function scrollToTile(id: number): void {
  const tile = document.querySelector<HTMLElement>(`#panel-grid [data-panel="${id}"]`);
  const scroller = byId("grid-scroller");
  if (tile !== null) scroller.scrollTop = Math.max(tile.offsetTop - 12, 0);
}

function chooseDashboard(index: number): void {
  view.dashboard = index;
  view.filter = "all";
  view.selection = firstPanel(dashboard());
  draw();
  const selection = view.selection;
  if (selection?.kind === "panel") scrollToTile(selection.id);
}

function choosePanel(board: Dashboard, id: number): void {
  view.dashboard = snapshot.dashboards.indexOf(board);
  view.selection = { kind: "panel", id };
  draw();
  scrollToTile(id);
  showDetailOnPhone();
}

function chooseRule(record: string): void {
  const reader = panelsReading(snapshot.dashboards, record)[0];
  if (reader !== undefined) view.dashboard = snapshot.dashboards.indexOf(reader.dashboard);
  view.selection = { kind: "rule", record };
  draw();
  if (reader !== undefined) scrollToTile(reader.panel.id);
  showDetailOnPhone();
}

function showDetailOnPhone(): void {
  if (matchMedia("(max-width: 959px)").matches) byId("explain").scrollIntoView({ block: "nearest" });
}

function drawTabs(): void {
  byId("board-tabs").replaceChildren(
    ...snapshot.dashboards.map((board, index) => {
      const button = h("button", { type: "button", class: "tab", "aria-pressed": String(index === view.dashboard), "data-board": board.uid }, h("strong", {}, board.title), h("span", {}, `${realPanels(board).length} panels`));
      button.addEventListener("click", () => chooseDashboard(index));
      return button;
    }),
  );
}

function drawFilters(): void {
  const board = dashboard();
  const entries: { readonly key: PanelFilter; readonly label: string; readonly dot: string | undefined }[] = [
    { key: "all", label: "All", dot: undefined },
    { key: "rule", label: "Reads a rule", dot: undefined },
    ...snapshot.datasources.filter((source) => board.panels.some((panel) => panel.datasources.includes(source.uid))).map((source) => ({ key: source.uid, label: source.name, dot: signalOf(snapshot, source.uid) })),
  ];
  byId("panel-filters").replaceChildren(
    ...entries.map((entry) => {
      const count = realPanels(board).filter((panel) => panelMatches(panel, entry.key, "")).length;
      const button = h(
        "button",
        { type: "button", class: "chip", "aria-pressed": String(view.filter === entry.key), "data-filter": entry.key },
        entry.dot === undefined ? null : h("span", { class: `dot sig-${entry.dot}`, "aria-hidden": "true" }),
        `${entry.label} `,
        h("span", { class: "count" }, String(count)),
      );
      button.addEventListener("click", () => {
        view.filter = entry.key;
        draw();
        const first = realPanels(board).find((panel) => panelMatches(panel, view.filter, view.search));
        if (first !== undefined) scrollToTile(first.id);
      });
      return button;
    }),
  );
}

function linkOf(panel: Panel): string {
  const selection = view.selection;
  if (selection === null) return "";
  if (selection.kind === "panel") return selection.id === panel.id ? "selected" : "";
  if (panel.rules.includes(selection.record)) return "reads";
  if (panel.sharedRules.includes(selection.record)) return "shares";
  return "";
}

function drawGrid(): void {
  const board = dashboard();
  const grid = byId("panel-grid");
  grid.style.setProperty("--rows", String(board.rows));
  grid.classList.toggle("is-fit", view.fit);
  grid.classList.toggle("is-tracing", view.selection?.kind === "rule");
  grid.replaceChildren(
    ...board.panels.map((panel) => {
      const place = `grid-column:${panel.x + 1} / span ${panel.w};grid-row:${panel.y + 1} / span ${panel.h}`;
      if (panel.type === "row") return h("div", { class: "row-tile", style: place, "data-row": panel.id }, panel.title);
      const signal = signalOf(snapshot, panel.datasources[0] ?? "");
      const button = h(
        "button",
        {
          type: "button",
          class: `tile sig-${signal ?? "none"}`,
          style: place,
          "data-panel": panel.id,
          "data-x": panel.x,
          "data-y": panel.y,
          "data-w": panel.w,
          "data-h": panel.h,
          "data-link": linkOf(panel),
          "data-match": String(panelMatches(panel, view.filter, view.search)),
          "aria-pressed": String(linkOf(panel) === "selected"),
          "aria-label": `${panel.title}, ${panel.type}${panel.rules.length > 0 ? ", reads a recording rule" : ""}`,
          title: panel.title,
        },
        h("span", { class: "tile-title" }, panel.title),
        h("span", { class: "tile-kind" }, panel.type, panel.rules.length > 0 ? h("span", { class: "tile-rule" }, `${panel.rules.length} rules`) : null),
      );
      button.addEventListener("click", () => choosePanel(board, panel.id));
      return button;
    }),
  );
  const shown = realPanels(board).filter((panel) => panelMatches(panel, view.filter, view.search)).length;
  byId("panel-count").textContent = `${shown} of ${realPanels(board).length} panels match. ${board.rows} grid rows, 24 columns.`;
  const fitButton = byId<HTMLButtonElement>("fit");
  fitButton.setAttribute("aria-pressed", String(view.fit));
  fitButton.textContent = view.fit ? "Readable size" : "Whole dashboard";
}

function drawMatrix(): void {
  const matrix = ruleMatrix(snapshot.rules);
  const panel = selectedPanel();
  const selection = view.selection;
  const stateOf = (rule: Rule): string => {
    if (selection?.kind === "rule") return selection.record === rule.record ? "selected" : "";
    if (panel?.rules.includes(rule.record)) return "reads";
    if (panel?.sharedRules.includes(rule.record)) return "shares";
    return "";
  };
  byId("matrix-head").replaceChildren(h("tr", {}, h("th", { scope: "col" }, "Input metric"), matrix.operations.map((operation) => h("th", { scope: "col" }, operation))));
  byId("matrix-body").replaceChildren(
    ...matrix.rows.map((row) =>
      h(
        "tr",
        {},
        h("th", { scope: "row", title: row.metric }, shortMetric(row.metric)),
        row.cells.map((rule) => {
          if (rule === undefined) return h("td", { class: "empty" }, h("span", { class: "sr" }, "no rule"), h("span", { "aria-hidden": "true" }, "·"));
          const readers = panelsReading(snapshot.dashboards, rule.record).length;
          const button = h("button", { type: "button", class: "cell", "data-rule": rule.record, "data-link": stateOf(rule), "aria-pressed": String(stateOf(rule) === "selected"), "aria-label": `${rule.record}, ${readers} panels`, title: rule.record }, String(readers));
          button.addEventListener("click", () => chooseRule(rule.record));
          return h("td", {}, button);
        }),
      ),
    ),
  );
  byId("matrix-note").textContent =
    realPanels(dashboard()).some((entry) => entry.rules.length > 0) ? `Each cell is one rule of lag.yaml. Its number is the count of panels that name it.` : `${dashboard().title} names no recording rule. A click on a cell opens the Lag Monitor panels of that rule.`;
}

function ruleChip(record: string, kind: string): HTMLElement {
  const rule = ruleOf(record);
  const button = h("button", { type: "button", class: `link-chip ${kind}`, "data-rule-link": record, title: record }, `${shortMetric(rule.metric)} ${rule.operation}`);
  button.addEventListener("click", () => chooseRule(record));
  return button;
}

function panelChip(board: Dashboard, panel: Panel, kind: string): HTMLElement {
  const button = h("button", { type: "button", class: `link-chip ${kind}`, "data-panel-link": panel.id }, panel.title);
  button.addEventListener("click", () => choosePanel(board, panel.id));
  return button;
}

function routeButton(panel: Panel): HTMLElement | null {
  const spans = panel.targets.some((target) => target.series.some((name) => name.startsWith(SPAN_METRICS)));
  const signal = spans ? "traces" : signalOf(snapshot, panel.datasources[0] ?? "");
  if (signal === undefined) return null;
  const button = h("button", { type: "button", class: "action", id: "show-route" }, `Show the route of ${signal}`);
  button.addEventListener("click", () => {
    const route = snapshot.routes.find((entry) => entry.signal === signal)!;
    update({ signal, node: route.nodes.at(-3)! });
    byId("map").scrollIntoView({ block: "start" });
  });
  return button;
}

function ruleExplanation(panel: Panel): HTMLElement {
  if (panel.rules.length > 0) {
    return h("div", { class: "feeds", id: "feeds" }, h("h4", {}, `Fed by ${panel.rules.length} recording rules`), h("div", { class: "chips" }, panel.rules.map((record) => ruleChip(record, "reads"))));
  }
  const series = [...new Set(panel.targets.flatMap((target) => target.series))];
  if (panel.sharedRules.length > 0) {
    return h(
      "div",
      { class: "feeds", id: "feeds" },
      h("h4", {}, "No recording rule feeds this panel"),
      h("p", {}, `Its query reads the raw metric, so it recalculates at each load. ${panel.sharedRules.length} rules read the same input.`),
      h("div", { class: "chips" }, panel.sharedRules.map((record) => ruleChip(record, "shares"))),
    );
  }
  if (series.some((name) => name.startsWith(SPAN_METRICS))) {
    return h(
      "div",
      { class: "feeds", id: "feeds" },
      h("h4", {}, "No recording rule feeds this panel"),
      h("p", {}, "Tempo makes these series from the traces, and it writes them to Mimir. These lines send them."),
      excerpt(snapshot.spanMetrics),
    );
  }
  const names = panel.datasources.map(sourceName).join(", ");
  return h("div", { class: "feeds", id: "feeds" }, h("h4", {}, "No recording rule feeds this panel"), h("p", {}, series.length > 0 ? "No rule reads its series." : `The rules of lag.yaml are for Mimir. This panel reads ${names}.`));
}

function drawPanelDetail(root: HTMLElement, panel: Panel): void {
  const parts = [
    h("div", { class: "explain-kicker" }, h("span", {}, panel.type), h("span", {}, `x ${panel.x}, y ${panel.y}, w ${panel.w}, h ${panel.h}`)),
    h("h3", { id: "explain-title" }, panel.title),
    panel.description === "" ? null : h("p", { class: "explain-text" }, panel.description),
    ruleExplanation(panel),
    h("h4", {}, panel.targets.length === 1 ? "Query" : `${panel.targets.length} queries`),
    h(
      "div",
      { class: "queries", id: "queries" },
      panel.targets.map((target) =>
        h(
          "div",
          { class: "query" },
          h("span", { class: "query-meta" }, `${target.refId}, ${sourceName(target.datasource)}`),
          h("pre", { tabindex: 0 }, h("code", {}, target.query)),
        ),
      ),
    ),
    routeButton(panel),
  ];
  root.replaceChildren(...parts.filter((part) => part !== null));
}

function drawRuleDetail(root: HTMLElement, rule: Rule): void {
  const readers = panelsReading(snapshot.dashboards, rule.record);
  const sharers = panelsSharing(snapshot.dashboards, rule.record);
  root.replaceChildren(
    h("div", { class: "explain-kicker" }, h("span", {}, "recording rule"), h("span", {}, `${rule.group}, each ${rule.interval}`)),
    h("h3", { id: "explain-title", class: "mono-title" }, rule.record),
    excerpt(rule.source),
    h("h4", {}, `${readers.length} ${readers.length === 1 ? "panel names" : "panels name"} this rule`),
    h("div", { class: "chips", id: "rule-readers" }, readers.map((ref) => panelChip(ref.dashboard, ref.panel, "reads"))),
    h("h4", {}, `${sharers.length} ${sharers.length === 1 ? "panel reads" : "panels read"} its input directly`),
    h("div", { class: "chips", id: "rule-sharers" }, sharers.map((ref) => panelChip(ref.dashboard, ref.panel, "shares"))),
  );
}

function drawDetail(): void {
  const root = byId("explain");
  const selection = view.selection;
  const panel = selectedPanel();
  if (panel !== undefined) drawPanelDetail(root, panel);
  else if (selection?.kind === "rule") drawRuleDetail(root, ruleOf(selection.record));
  else root.replaceChildren(h("p", { class: "hint" }, "Pick a panel or a rule."));
}

function draw(): void {
  drawTabs();
  drawFilters();
  drawGrid();
  drawMatrix();
  drawDetail();
}

/** This function opens the explorer on the panels of a data source. */
export function showDataSource(uid: string): void {
  const index = snapshot.dashboards.findIndex((board) => board.panels.some((panel) => panel.datasources.includes(uid)));
  if (index < 0) return;
  view.dashboard = index;
  view.filter = uid;
  const first = realPanels(dashboard()).find((panel) => panel.datasources.includes(uid));
  view.selection = first === undefined ? null : { kind: "panel", id: first.id };
  draw();
  if (first !== undefined) scrollToTile(first.id);
  byId("dashboards").scrollIntoView({ block: "start" });
}

/** This function starts the explorer. */
export function setupExplorer(): void {
  view.selection = firstPanel(dashboard());
  draw();
  const selection = view.selection;
  if (selection?.kind === "panel") scrollToTile(selection.id);
  byId<HTMLInputElement>("panel-search").addEventListener("input", (event) => {
    view.search = (event.target as HTMLInputElement).value;
    draw();
    const first = realPanels(dashboard()).find((panel) => panelMatches(panel, view.filter, view.search));
    if (first !== undefined) scrollToTile(first.id);
  });
  byId("fit").addEventListener("click", () => {
    view.fit = !view.fit;
    draw();
  });
  byId("node-detail").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("#show-panels");
    if (button !== null) showDataSource(button.dataset["source"]!);
  });
}
