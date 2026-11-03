/**
 * The signal map. A wide screen shows the whole stack with the route of the signal lit. A phone shows the route as a list.
 * Each node is a button, and the card below it shows the exact lines of the real file.
 */

import { byId, h } from "@mark1russell7/site-pages/chrome";
import { excerpt } from "./excerpt.ts";
import { snapshot, state, subscribe, update } from "./state.ts";
import { substitute } from "./stack/compose-vars.ts";
import { SIGNALS, type MapNode, type Route, type Signal, type Source } from "./stack/types.ts";

/** The node that stands for the missing hop of a signal with no route through Alloy. */
const GAP = "gap";

const COLUMNS = 7;
const HEADER = 54;
const ROW = 88;
const NODE_HEIGHT = 74;
const NODE_WIDTH = 11.4;
const VIEW_WIDTH = 1000;

const SIGNAL_TEXT: Readonly<Record<Signal, string>> = { metrics: "Metrics", logs: "Logs", traces: "Traces", profiles: "Profiles" };

const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));

function routeOf(signal: Signal): Route {
  return snapshot.routes.find((route) => route.signal === signal)!;
}

function live(text: string): string {
  return substitute(text, state.values).text;
}

function onRoute(route: Route): Set<string> {
  return new Set([...route.nodes, ...(route.branch?.nodes ?? [])]);
}

function nodeTop(node: MapNode): number {
  return HEADER + node.row * ROW + (ROW - NODE_HEIGHT) / 2;
}

function nodeLeft(column: number): number {
  return ((column + 0.5) * 100) / COLUMNS - NODE_WIDTH / 2;
}

/** This function gives the first node of a route that no other route has. That node shows what is special about the signal. */
function typicalNode(signal: Signal): string {
  const route = routeOf(signal);
  if (route.gap !== null) return GAP;
  const others = SIGNALS.filter((entry) => entry !== signal).flatMap((entry) => routeOf(entry).nodes);
  return route.nodes.find((id) => !others.includes(id)) ?? route.nodes[0]!;
}

function select(id: string): void {
  update({ node: id });
}

function nodeButton(node: MapNode, extra: string): HTMLButtonElement {
  const button = h(
    "button",
    { type: "button", class: `node ${extra}`, "data-node": node.id, "aria-label": `${node.title}, ${node.name}` },
    h("span", { class: "node-title" }, node.title),
    h("span", { class: "node-detail", "data-live": node.detail }, ""),
  );
  button.addEventListener("click", () => select(node.id));
  return button;
}

function gapButton(extra: string): HTMLButtonElement {
  const button = h("button", { type: "button", class: `node node-gap ${extra}`, "data-node": GAP }, h("span", { class: "node-title" }, "No route"), h("span", { class: "node-detail" }, "Alloy has no output"));
  button.addEventListener("click", () => select(GAP));
  return button;
}

function edgePath(from: MapNode, to: MapNode, branch: boolean): string {
  const y = (node: MapNode) => nodeTop(node) + NODE_HEIGHT / 2;
  const x = (node: MapNode) => nodeLeft(node.column) * (VIEW_WIDTH / 100);
  const width = NODE_WIDTH * (VIEW_WIDTH / 100);
  if (branch) return `M ${x(from)} ${y(from)} C ${x(from) - 22} ${y(from)}, ${x(to) - 22} ${y(to)}, ${x(to)} ${y(to)}`;
  const startX = x(from) + width;
  const middle = (startX + x(to)) / 2;
  return `M ${startX} ${y(from)} C ${middle} ${y(from)}, ${middle} ${y(to)}, ${x(to)} ${y(to)}`;
}

function drawWide(root: HTMLElement): void {
  const rows = Math.max(...snapshot.nodes.map((node) => node.row)) + 1;
  const height = HEADER + rows * ROW;
  root.style.height = `${height}px`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${VIEW_WIDTH} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("map-lines");
  for (const edge of snapshot.edges) {
    if (edge.to === "grafana") continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", edgePath(nodes.get(edge.from)!, nodes.get(edge.to)!, edge.branch));
    path.setAttribute("data-signals", edge.signals.join(" "));
    path.classList.add("edge");
    if (edge.branch) path.classList.add("edge-branch");
    svg.append(path);
  }
  const lanes = [h("div", { class: "lane lane-alloy", style: `left:${nodeLeft(1) - 1.2}%;width:${nodeLeft(4) + NODE_WIDTH - nodeLeft(1) + 2.4}%` }), h("div", { class: "lane lane-grafana", style: `left:${nodeLeft(6) - 1.2}%;width:${NODE_WIDTH + 2.4}%` })];
  const wide = snapshot.nodes.map((node) => {
    const button = nodeButton(node, node.row < 0 ? "node-host" : "");
    if (node.row < 0) {
      const left = node.id === "alloy" ? nodeLeft(1) : nodeLeft(6);
      button.style.cssText = `left:${left}%;top:7px;width:${node.id === "alloy" ? nodeLeft(4) + NODE_WIDTH - nodeLeft(1) : NODE_WIDTH}%`;
    } else {
      button.style.cssText = `left:${nodeLeft(node.column)}%;top:${nodeTop(node)}px;width:${NODE_WIDTH}%;height:${NODE_HEIGHT}px`;
    }
    return button;
  });
  const pyroscope = snapshot.nodes.find((node) => node.id === routeOf("profiles").nodes[0]);
  const gap = gapButton("only-gap");
  if (pyroscope !== undefined) gap.style.cssText = `left:${nodeLeft(4)}%;top:${nodeTop(pyroscope)}px;width:${NODE_WIDTH}%;height:${NODE_HEIGHT}px`;
  root.replaceChildren(...lanes, svg, ...wide, gap);
}

function drawList(root: HTMLElement): void {
  const route = routeOf(state.signal);
  const items: HTMLElement[] = [];
  const hop = (from: string | undefined, to: string): string => snapshot.edges.find((edge) => edge.from === from && edge.to === to)?.label ?? "";
  if (route.gap !== null) items.push(h("li", {}, gapButton("")));
  route.nodes.forEach((id, index) => {
    const label = index === 0 ? "" : hop(route.nodes[index - 1], id);
    items.push(h("li", {}, label === "" ? null : h("span", { class: "hop", "data-live": label }, ""), nodeButton(nodes.get(id)!, "")));
  });
  if (route.branch !== null) {
    const branch = route.branch;
    items.push(h("li", { class: "branch-head" }, `Second route, from ${nodes.get(branch.from)!.title}`));
    branch.nodes.forEach((id, index) => {
      const label = index === 0 ? branch.label : hop(branch.nodes[index - 1], id);
      items.push(h("li", {}, label === "" ? null : h("span", { class: "hop", "data-live": label }, ""), nodeButton(nodes.get(id)!, "")));
    });
  }
  root.replaceChildren(...items);
}

function sourcesOf(id: string, route: Route): readonly Source[] {
  if (id === GAP) return route.gap === null ? [] : [route.gap.source];
  return nodes.get(id)?.sources ?? [];
}

function hopLine(direction: string, node: MapNode | undefined, label: string): HTMLElement {
  return h("li", {}, h("span", { class: "hop-dir" }, direction), " ", h("strong", {}, node?.title ?? ""), " ", h("code", {}, live(label)));
}

function drawDetail(root: HTMLElement): void {
  const route = routeOf(state.signal);
  const id = state.node;
  const node = nodes.get(id);
  const incoming = snapshot.edges.filter((edge) => edge.to === id && edge.signals.includes(state.signal));
  const outgoing = snapshot.edges.filter((edge) => edge.from === id && edge.signals.includes(state.signal));
  const queries = snapshot.datasources.find((source) => id === `source:${source.url.replace(/^https?:\/\//, "").split(":")[0]}`);
  const showPanels = queries !== undefined && queries.queries > 0 ? h("button", { type: "button", class: "action", id: "show-panels", "data-source": queries.uid }, `Show the panels that read ${queries.name}`) : null;
  root.replaceChildren(
    h(
      "div",
      { class: "detail-head" },
      h("h3", { id: "detail-title" }, id === GAP ? "No route through Alloy" : (node?.title ?? "")),
      id === GAP ? null : h("code", { id: "detail-name" }, node?.name ?? ""),
      id === GAP ? null : h("p", { class: "detail-value", id: "detail-value" }, live(node?.detail ?? "")),
      id === GAP ? h("p", { class: "detail-gap", id: "detail-gap" }, route.gap?.text ?? "") : null,
      incoming.length + outgoing.length > 0
        ? h(
            "ul",
            { class: "hops", id: "detail-hops" },
            incoming.map((edge) => hopLine("From", nodes.get(edge.from), edge.label)),
            outgoing.map((edge) => hopLine("To", nodes.get(edge.to), edge.label)),
          )
        : null,
      showPanels,
    ),
    h("div", { class: "detail-sources", id: "detail-sources" }, sourcesOf(id, route).map(excerpt)),
  );
}

function paintWide(root: HTMLElement): void {
  const route = routeOf(state.signal);
  const lit = onRoute(route);
  root.dataset["signal"] = state.signal;
  for (const button of root.querySelectorAll<HTMLButtonElement>(".node")) {
    const id = button.dataset["node"]!;
    button.classList.toggle("is-on", lit.has(id) || (id === GAP && route.gap !== null) || (id === "alloy" && route.gap === null));
    button.setAttribute("aria-pressed", String(id === state.node));
    if (id === GAP) button.hidden = route.gap === null;
  }
  for (const path of root.querySelectorAll<SVGPathElement>(".edge")) {
    path.classList.toggle("is-on", (path.dataset["signals"] ?? "").split(" ").includes(state.signal));
  }
}

function paintLive(): void {
  for (const element of document.querySelectorAll<HTMLElement>("#map [data-live]")) element.textContent = live(element.dataset["live"]!);
}

function drawPicker(root: HTMLElement): void {
  root.replaceChildren(
    ...SIGNALS.map((signal) => {
      const route = routeOf(signal);
      const backend = nodes.get(route.nodes.at(-3)!)!;
      const button = h(
        "button",
        { type: "button", class: "signal", id: `signal-${signal}`, "data-signal": signal, "aria-pressed": "false" },
        h("span", { class: "signal-dot", "aria-hidden": "true" }),
        h("span", { class: "signal-name" }, SIGNAL_TEXT[signal]),
        h("span", { class: "signal-to" }, route.gap === null ? `to ${backend.title}` : `${backend.title}, no route`),
      );
      button.addEventListener("click", () => update({ signal, node: typicalNode(signal) }));
      return button;
    }),
  );
}

function summary(route: Route): string {
  const stations = route.nodes.map((id) => nodes.get(id)!.title);
  const main = `${SIGNAL_TEXT[route.signal]}: ${stations.join(", then ")}.`;
  if (route.branch === null) return main;
  return `${main} A second route leaves ${nodes.get(route.branch.from)!.title}: the span metrics go to ${route.branch.label}.`;
}

/** This function starts the map. */
export function setupMap(): void {
  const wide = byId("map-wide");
  const list = byId("map-list");
  const detail = byId("node-detail");
  const picker = byId("signals");
  drawPicker(picker);
  drawWide(wide);
  state.node = typicalNode(state.signal);
  const paint = () => {
    drawList(list);
    paintWide(wide);
    drawDetail(detail);
    paintLive();
    for (const button of list.querySelectorAll<HTMLButtonElement>(".node")) button.setAttribute("aria-pressed", String(button.dataset["node"] === state.node));
    for (const button of picker.querySelectorAll<HTMLButtonElement>(".signal")) button.setAttribute("aria-pressed", String(button.dataset["signal"] === state.signal));
    list.dataset["signal"] = state.signal;
    picker.dataset["signal"] = state.signal;
    byId("route-summary").textContent = summary(routeOf(state.signal));
  };
  subscribe(paint);
  paint();
}
