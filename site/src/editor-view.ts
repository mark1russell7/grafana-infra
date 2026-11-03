/**
 * The port editor. A change of a field runs the variable substitution of Compose on the real `docker-compose.yml`, and the
 * page shows the lines that change. The signal map reads the same values.
 */

import { byId, copyText, h } from "@mark1russell7/site-pages/chrome";
import { baseValues, impactOf, type HostPort, type Impact } from "./model.ts";
import { snapshot, state, subscribe, update } from "./state.ts";
import { HIDDEN, substitute, type Values } from "./stack/compose-vars.ts";
import type { StackVariable } from "./stack/types.ts";

const COMPOSE = "docker-compose.yml";

const lines = snapshot.files.find((file) => file.path === COMPOSE)!.lines;

function setValue(variable: StackVariable, text: string): void {
  const next: Record<string, string | undefined> = { ...state.values };
  if (text === "" && variable.envLine === null) delete next[variable.name];
  else next[variable.name] = text;
  update({ values: next });
}

function field(variable: StackVariable): HTMLElement {
  const id = `var-${variable.name}`;
  if (variable.hidden) {
    return h("div", { class: "field is-hidden", id, "data-hidden": variable.name }, h("span", { class: "field-name" }, variable.name), h("span", { class: "hidden-value" }, HIDDEN), h("span", { class: "field-note" }, "The page does not hold this value."));
  }
  const input = h("input", { id: `input-${variable.name}`, class: "mono", type: "text", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "data-var": variable.name, placeholder: variable.composeDefault ?? "" });
  input.addEventListener("input", () => setValue(variable, input.value));
  const where = variable.lines.length === 0 ? "Compose does not use it" : `Compose line ${variable.lines.join(", ")}`;
  return h("div", { class: "field", id }, h("label", { class: "field-name", for: `input-${variable.name}` }, variable.name), input, h("span", { class: "field-note", id: `note-${variable.name}` }, where));
}

function drawFields(root: HTMLElement): void {
  const groups = [...new Set(snapshot.variables.map((variable) => variable.group))];
  root.replaceChildren(
    ...groups.map((group) =>
      h(
        "fieldset",
        { class: "group" },
        h("legend", {}, group),
        snapshot.variables.filter((variable) => variable.group === group).map(field),
      ),
    ),
  );
}

function shiftPorts(values: Values, by: number): Values {
  const next: Record<string, string | undefined> = { ...values };
  for (const port of impactOf(lines, snapshot.variables, values).ports) {
    if (port.variable !== undefined) next[port.variable] = String(Number(port.host) + by);
  }
  return next;
}

function drawPresets(root: HTMLElement): void {
  const presets: readonly { readonly id: string; readonly label: string; readonly run: () => void }[] = [
    { id: "grafana-3300", label: "Grafana on 3300", run: () => update({ values: { ...baseValues(snapshot.variables), GRAFANA_PORT: "3300" } }) },
    { id: "shift-1000", label: "A second stack: each port + 1000", run: () => update({ values: shiftPorts(baseValues(snapshot.variables), 1000) }) },
    { id: "clash", label: "A clash: Grafana on the Loki port", run: () => update({ values: { ...baseValues(snapshot.variables), GRAFANA_PORT: baseValues(snapshot.variables)["LOKI_PORT"] } }) },
    { id: "reset", label: "Reset to .env", run: () => update({ values: baseValues(snapshot.variables) }) },
  ];
  root.replaceChildren(
    ...presets.map((preset) => {
      const button = h("button", { type: "button", class: "chip", "data-preset": preset.id }, preset.label);
      button.addEventListener("click", preset.run);
      return button;
    }),
  );
}

function drawDiff(root: HTMLElement, impact: Impact): void {
  const rows = [
    ...impact.compose.map((change) => h("li", { class: "diff-line", "data-line": change.line }, h("span", { class: "diff-at" }, `${COMPOSE}, line ${change.line}`), h("code", { class: "del" }, change.before.trim()), h("code", { class: "add" }, change.after.trim()))),
    ...impact.env.map((change) =>
      h(
        "li",
        { class: "diff-line", "data-env": change.name },
        h("span", { class: "diff-at" }, change.line === null ? ".env, new line" : `.env, line ${change.line}`),
        change.before === undefined ? null : h("code", { class: "del" }, `${change.name}=${change.before}`),
        h("code", { class: "add" }, `${change.name}=${change.after ?? ""}`),
      ),
    ),
  ];
  root.replaceChildren(...(rows.length === 0 ? [h("li", { class: "diff-none hint" }, "No line changes. Each value is the value of .env.")] : rows));
}

function portRow(port: HostPort): HTMLElement {
  const url = `http://localhost:${port.host}`;
  return h("tr", { "data-port-line": port.line }, h("td", {}, port.service), h("td", {}, h("code", {}, url)), h("td", {}, h("code", {}, `${port.service}:${port.container}`)));
}

function fieldNotes(): void {
  for (const variable of snapshot.variables) {
    if (variable.hidden) continue;
    const input = document.getElementById(`input-${variable.name}`) as HTMLInputElement | null;
    const value = state.values[variable.name] ?? "";
    if (input !== null && input !== document.activeElement) input.value = value;
    const note = document.getElementById(`note-${variable.name}`);
    if (note === null) continue;
    const where = variable.lines.length === 0 ? "Compose does not use it" : `Compose line ${variable.lines.join(", ")}`;
    const fallback = variable.lines.length > 0 && value === "" && variable.composeDefault !== null ? `. Empty, so Compose uses its default ${variable.composeDefault}` : "";
    note.textContent = `${where}${fallback}`;
  }
}

function drawCommands(impact: Impact): void {
  const port = (name: string, fallback: string) => substitute(`\${${name}:-${fallback}}`, state.values).text;
  const otlp = snapshot.variables.find((variable) => variable.name === "OTLP_HTTP_PORT")?.composeDefault ?? "";
  const grafana = snapshot.variables.find((variable) => variable.name === "GRAFANA_PORT")?.composeDefault ?? "";
  byId("up-command").textContent = impact.command;
  byId("run-up").textContent = impact.command;
  byId("run-sample").textContent = `node scripts/send-sample-data.mjs --endpoint http://localhost:${port("OTLP_HTTP_PORT", otlp)}`;
  byId("run-open").textContent = `http://localhost:${port("GRAFANA_PORT", grafana)}`;
}

function paint(): void {
  const impact = impactOf(lines, snapshot.variables, state.values);
  fieldNotes();
  drawDiff(byId("diff"), impact);
  byId("changed-count").textContent = impact.compose.length === 1 ? "1 Compose line changes" : `${impact.compose.length} Compose lines change`;
  const problems = byId("port-problems");
  problems.replaceChildren(...impact.problems.map((problem) => h("li", {}, problem)));
  problems.hidden = impact.problems.length === 0;
  byId("port-rows").replaceChildren(...impact.ports.map(portRow));
  drawCommands(impact);
  const changed = new Set(impact.compose.map((change) => change.line));
  byId("resolved-file").replaceChildren(
    ...impact.resolved.map((line, index) => h("span", { class: changed.has(index + 1) ? "ln is-changed" : "ln" }, h("span", { class: "no", "aria-hidden": "true" }, String(index + 1)), h("span", { class: "tx" }, line === "" ? " " : line))),
  );
}

/** This function starts the editor. */
export function setupEditor(): void {
  drawFields(byId("fields"));
  drawPresets(byId("presets"));
  subscribe(paint);
  paint();
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
    button.addEventListener("click", () => void copyText(button, byId(button.dataset["copy"]!).textContent ?? ""));
  }
}
