// The start of the page: the theme, the facts of the header, the signal map, the dashboard explorer and the port editor.
import { byId, h, setupTheme, showBuild } from "@mark1russell7/site-pages/chrome";
import { setupEditor } from "./editor-view.ts";
import { setupExplorer } from "./explorer-view.ts";
import { setupMap } from "./map-view.ts";
import { snapshot } from "./state.ts";
// The fade at the edge of a code block that is wider than its box (the class scroll-cue)
import "@mark1russell7/site-pages/scroll-cue.css";
import "./style.css";

setupTheme(byId<HTMLButtonElement>("theme"), "grafana-infra-theme");

const panels = snapshot.dashboards.flatMap((board) => board.panels).filter((panel) => panel.type !== "row").length;
const facts: readonly (readonly [string, string, string])[] = [
  ["fact-services", String(snapshot.services), "Compose services"],
  ["fact-sources", String(snapshot.datasources.length), "Grafana data sources"],
  ["fact-panels", String(panels), "dashboard panels"],
  ["fact-rules", String(snapshot.rules.length), "recording rules"],
];
byId("facts").replaceChildren(...facts.map(([id, value, label]) => h("li", {}, h("strong", { id }, value), ` ${label}`)));

setupMap();
setupExplorer();
setupEditor();

showBuild(byId("build"), __BUILD__, "mark1russell7/grafana-infra");
