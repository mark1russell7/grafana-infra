/** The pure logic of the page: the links between panels and rules, and the result of a change of the values. */

import { changedLines, HIDDEN, references, resolveLines, substitute, type ChangedLine, type Values } from "./stack/compose-vars.ts";
import type { Dashboard, Panel, Rule, Signal, Snapshot, StackVariable } from "./stack/types.ts";

/** A panel with its dashboard. */
export interface PanelRef {
  readonly dashboard: Dashboard;
  readonly panel: Panel;
}

/** This function gives the panels whose queries name a rule. */
export function panelsReading(dashboards: readonly Dashboard[], record: string): PanelRef[] {
  return dashboards.flatMap((dashboard) => dashboard.panels.filter((panel) => panel.rules.includes(record)).map((panel) => ({ dashboard, panel })));
}

/** This function gives the panels that read the input metric of a rule, and do not name the rule. */
export function panelsSharing(dashboards: readonly Dashboard[], record: string): PanelRef[] {
  return dashboards.flatMap((dashboard) => dashboard.panels.filter((panel) => panel.sharedRules.includes(record)).map((panel) => ({ dashboard, panel })));
}

/** The filter of the explorer: all panels, the panels that name a rule, or the UID of a data source. */
export type PanelFilter = "all" | "rule" | string;

/** This function tells if a panel passes a filter and a search text. */
export function panelMatches(panel: Panel, filter: PanelFilter, search: string): boolean {
  if (panel.type === "row") return false;
  if (filter === "rule" && panel.rules.length === 0) return false;
  if (filter !== "all" && filter !== "rule" && !panel.datasources.includes(filter)) return false;
  const words = search.trim().toLowerCase();
  if (words === "") return true;
  return `${panel.title} ${panel.description} ${panel.targets.map((target) => target.query).join(" ")}`.toLowerCase().includes(words);
}

/** This function gives the signal of a data source, from the routes. */
export function signalOf(snapshot: Snapshot, datasource: string): Signal | undefined {
  return datasource === "" ? undefined : snapshot.routes.find((route) => route.datasource === datasource)?.signal;
}

/** This function gives the short name of a metric for a table. */
export function shortMetric(metric: string): string {
  return metric.replace(/^lag_/, "").replace(/_histogram$/, "");
}

/** The rows of the matrix of rules: one input metric, and its rule for each operation. */
export interface MatrixRow {
  readonly metric: string;
  readonly group: string;
  readonly cells: readonly (Rule | undefined)[];
}

/** The matrix of rules. */
export interface Matrix {
  readonly operations: readonly string[];
  readonly rows: readonly MatrixRow[];
}

/** This function makes the matrix from the names of the rules. */
export function ruleMatrix(rules: readonly Rule[]): Matrix {
  const operations = [...new Set(rules.map((rule) => rule.operation))].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const metrics = [...new Set(rules.map((rule) => rule.metric))];
  return {
    operations,
    rows: metrics.map((metric) => {
      const own = rules.filter((rule) => rule.metric === metric);
      return { metric, group: own[0]!.group, cells: operations.map((operation) => own.find((rule) => rule.operation === operation)) };
    }),
  };
}

/** This function gives the values of the `.env` file. A hidden variable has the text `hidden`, so the page holds no secret. */
export function baseValues(variables: readonly StackVariable[]): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (const variable of variables) {
    if (variable.hidden) values[variable.name] = HIDDEN;
    else if (variable.env !== null) values[variable.name] = variable.env;
  }
  return values;
}

/** A port of the host in the resolved Compose file. */
export interface HostPort {
  readonly line: number;
  readonly host: string;
  readonly container: string;
  /** The Compose service of the line. */
  readonly service: string;
  /** The name of the variable of the line. */
  readonly variable: string | undefined;
}

function serviceAt(lines: readonly string[], index: number): string {
  for (let at = index; at >= 0; at -= 1) {
    const match = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(lines[at]!);
    if (match !== null) return match[1]!;
  }
  return "";
}

/** This function gives the host ports of the Compose file for the values. */
export function hostPorts(lines: readonly string[], values: Values): HostPort[] {
  const ports: HostPort[] = [];
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("#")) return;
    const match = /^\s*-\s*"(.+):(\d+)"\s*$/.exec(line);
    if (match === null) return;
    ports.push({ line: index + 1, host: substitute(match[1]!, values).text, container: match[2]!, service: serviceAt(lines, index), variable: references(line)[0]?.name });
  });
  return ports;
}

/** This function gives the problems of the host ports: a value that is not a port, or a port that two services use. */
export function portProblems(ports: readonly HostPort[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, HostPort>();
  for (const port of ports) {
    const number = Number(port.host);
    if (!/^\d+$/.test(port.host) || number < 1 || number > 65535) {
      problems.push(`${port.variable ?? port.service} gives "${port.host}" on line ${port.line}. A host port is a number from 1 to 65535.`);
      continue;
    }
    const other = seen.get(port.host);
    if (other !== undefined) problems.push(`Port ${port.host} is on two lines: ${other.line} (${other.service}) and ${port.line} (${port.service}). Compose cannot bind both.`);
    seen.set(port.host, port);
  }
  return problems;
}

/** A line of a `.env` file that a change of the values changes. */
export interface EnvChange {
  readonly name: string;
  readonly line: number | null;
  readonly before: string | undefined;
  readonly after: string | undefined;
}

/** The result of a change of the values. */
export interface Impact {
  readonly compose: readonly ChangedLine[];
  readonly env: readonly EnvChange[];
  readonly ports: readonly HostPort[];
  readonly problems: readonly string[];
  /** The command that starts the stack with the values. */
  readonly command: string;
  /** The resolved Compose file. */
  readonly resolved: readonly string[];
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** This function gives each line of the stack that a change of the values changes. */
export function impactOf(lines: readonly string[], variables: readonly StackVariable[], values: Values): Impact {
  const base = baseValues(variables);
  const env = variables.filter((variable) => !variable.hidden && (base[variable.name] ?? "") !== (values[variable.name] ?? "")).map((variable) => ({ name: variable.name, line: variable.envLine, before: base[variable.name], after: values[variable.name] }));
  const ports = hostPorts(lines, values);
  const prefix = env.map((change) => `${change.name}=${shellWord(change.after ?? "")}`).join(" ");
  return {
    compose: changedLines(lines, base, values),
    env,
    ports,
    problems: portProblems(ports),
    command: `${prefix === "" ? "" : `${prefix} `}docker compose up -d`,
    resolved: resolveLines(lines, values),
  };
}
