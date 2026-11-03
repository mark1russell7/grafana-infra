/**
 * The build step of the site. It reads the real files of the repository, and it gives the one JSON value of the page.
 * It runs in Node.js only. Each name, port, line number and query of the page comes from here, so the site has no copy.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isSeq, LineCounter, parseDocument, type Document, type Node, type Pair, type ParsedNode } from "yaml";
import { components, hostOf, parseAlloy, walk, type AlloyBlock, type AlloyComponent } from "./alloy.ts";
import { isSecretName, parseDotEnv, references } from "./compose-vars.ts";
import { seriesOf } from "./promql.ts";
import { redactLines, secretValues } from "./redact.ts";
import { SIGNALS, type Dashboard, type DataSource, type FileText, type MapEdge, type MapNode, type Panel, type PanelTarget, type Route, type Rule, type Signal, type Snapshot, type Source, type StackVariable } from "./types.ts";

const COMPOSE = "docker-compose.yml";
const ENV = ".env";
const ALLOY = "config/alloy/config.alloy";
const DATASOURCES = "config/grafana/provisioning/datasources/datasources.yaml";
const PROVIDERS = "config/grafana/provisioning/dashboards/dashboards.yaml";
const RULES = "config/mimir/rules/anonymous/lag.yaml";
const MIMIR = "config/mimir/mimir.yaml";
const LOKI = "config/loki/loki.yaml";
const TEMPO = "config/tempo/tempo.yaml";
const DASHBOARDS = ["config/grafana/provisioning/dashboards/lag-monitor.json", "config/grafana/provisioning/dashboards/frontend.json"];

/** The parts of the config file of each backend that the map shows. */
const BACKEND_PARTS: Readonly<Record<string, { readonly file: string; readonly paths: readonly (readonly string[])[] }>> = {
  mimir: { file: MIMIR, paths: [["server"], ["ruler"], ["ruler_storage"]] },
  loki: { file: LOKI, paths: [["server"], ["limits_config", "otlp_config"]] },
  tempo: { file: TEMPO, paths: [["server"], ["distributor"], ["metrics_generator", "storage"]] },
};

const COMPONENT_TITLES: readonly (readonly [RegExp, string])[] = [
  [/^otelcol\.receiver\.otlp\./, "OTLP receiver"],
  [/^otelcol\.processor\.transform\./, "Transform"],
  [/^otelcol\.processor\.batch\./, "Batch"],
  [/^otelcol\.exporter\.otlphttp\./, "OTLP/HTTP exporter"],
  [/^otelcol\.exporter\.otlp\./, "OTLP exporter"],
];

const ROW_OF_SIGNAL: Readonly<Record<Signal, number>> = { metrics: 0, logs: 1, traces: 2, profiles: 3 };

interface Yaml {
  readonly file: string;
  readonly doc: Document.Parsed;
  readonly counter: LineCounter;
}

function lineCount(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

function yamlOf(file: string, text: string): Yaml {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  if (doc.errors.length > 0) throw new Error(`${file}: ${doc.errors[0]!.message}`);
  return { file, doc, counter };
}

/** This function gives the lines of the value at a path of a document: from its key to the end of its value. */
function linesAt(yaml: Yaml, path: readonly (string | number)[], label: string): Source {
  let node: Node | null | undefined = yaml.doc.contents;
  let startOffset: number | undefined;
  for (const step of path) {
    if (isMap(node)) {
      const pair = node.items.find((item) => (item.key as { value?: unknown } | null)?.value === step) as Pair<ParsedNode, ParsedNode> | undefined;
      if (pair === undefined) throw new Error(`${yaml.file}: no key ${String(step)} in ${path.join(".")}.`);
      startOffset = pair.key.range?.[0];
      node = pair.value;
    } else if (isSeq(node) && typeof step === "number") {
      node = node.items[step] as Node | undefined;
      startOffset = node?.range?.[0];
    } else {
      throw new Error(`${yaml.file}: the path ${path.join(".")} does not exist.`);
    }
  }
  const range = node?.range;
  if (range === undefined || range === null || startOffset === undefined) throw new Error(`${yaml.file}: the path ${path.join(".")} has no position.`);
  const start = yaml.counter.linePos(startOffset).line;
  const end = Math.max(start, yaml.counter.linePos(Math.max(range[1] - 1, 0)).line);
  return { file: yaml.file, start, end, label };
}

function blockSource(block: AlloyBlock, label: string): Source {
  return { file: ALLOY, start: block.line, end: block.endLine, label };
}

function child(block: AlloyBlock, name: string): AlloyBlock {
  const found = block.blocks.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`${ALLOY}: ${block.name} has no block ${name}.`);
  return found;
}

function attribute(block: AlloyBlock, name: string): string {
  const found = block.attributes.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`${ALLOY}: ${block.name} has no attribute ${name}.`);
  return found.raw.replace(/^"|"$/g, "");
}

function componentTitle(component: AlloyComponent): string {
  return COMPONENT_TITLES.find(([pattern]) => pattern.test(component.id))?.[1] ?? component.block.name;
}

function componentName(component: AlloyComponent): string {
  return `${component.block.name} "${component.block.label ?? ""}"`;
}

/** This function gives the host side of a mapping of Compose: `${GRAFANA_PORT:-3000}:3000` gives `${GRAFANA_PORT:-3000}`. */
function hostSide(mapping: string): string {
  return mapping.slice(0, mapping.lastIndexOf(":"));
}

function containerSide(mapping: string): string {
  return mapping.slice(mapping.lastIndexOf(":") + 1);
}

function readVariables(envText: string, composeLines: readonly string[]): StackVariable[] {
  const uses = new Map<string, { lines: number[]; fallback: string | null }>();
  composeLines.forEach((line, index) => {
    if (line.trimStart().startsWith("#")) return;
    for (const reference of references(line)) {
      const use = uses.get(reference.name) ?? { lines: [], fallback: null };
      use.lines.push(index + 1);
      if (reference.operator === ":-" || reference.operator === "-") use.fallback = reference.operand;
      uses.set(reference.name, use);
    }
  });
  const variables: StackVariable[] = [];
  const entries = parseDotEnv(envText);
  const envLines = lineCount(envText);
  let group = "";
  envLines.forEach((line, index) => {
    if (line.startsWith("#")) group = line.replace(/^#\s*/, "").replace(/\s*\(.*\)$/, "");
    const entry = entries.find((candidate) => candidate.line === index + 1);
    if (entry === undefined) return;
    const hidden = isSecretName(entry.name);
    const use = uses.get(entry.name);
    variables.push({
      name: entry.name,
      env: hidden ? null : entry.value,
      composeDefault: hidden ? null : (use?.fallback ?? null),
      hidden,
      lines: use?.lines ?? [],
      envLine: entry.line,
      group,
    });
  });
  for (const [name, use] of uses) {
    if (entries.some((entry) => entry.name === name)) continue;
    const hidden = isSecretName(name);
    variables.push({ name, env: null, composeDefault: hidden ? null : use.fallback, hidden, lines: use.lines, envLine: null, group: "Compose only" });
  }
  return variables;
}

interface RawTarget {
  readonly refId?: string;
  readonly expr?: string;
  readonly query?: string;
  readonly queryType?: string;
  readonly datasource?: unknown;
}

interface RawPanel {
  readonly id: number;
  readonly type: string;
  readonly title?: string;
  readonly description?: string;
  readonly datasource?: unknown;
  readonly gridPos: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly targets?: readonly RawTarget[];
  readonly panels?: readonly RawPanel[];
}

/** This function gives the data source of a query with the rules of Grafana: a UID or a name, else a type, else the default. */
function resolveDatasource(reference: unknown, datasources: readonly DataSource[]): string {
  const byDefault = datasources.find((source) => source.isDefault);
  if (byDefault === undefined) throw new Error(`${DATASOURCES}: no data source has isDefault.`);
  if (typeof reference === "string" && reference !== "") {
    return (datasources.find((source) => source.uid === reference || source.name === reference) ?? byDefault).uid;
  }
  if (typeof reference === "object" && reference !== null) {
    const { uid, type } = reference as { uid?: string; type?: string };
    const byUid = datasources.find((source) => source.uid === uid);
    if (byUid !== undefined) return byUid.uid;
    if (byDefault.type === type) return byDefault.uid;
    const byType = datasources.find((source) => source.type === type);
    if (byType !== undefined) return byType.uid;
  }
  return byDefault.uid;
}

function readDashboard(file: string, text: string, datasources: readonly DataSource[], rules: readonly Rule[]): Dashboard {
  const raw = JSON.parse(text) as { uid: string; title: string; panels: readonly RawPanel[] };
  const records = new Set(rules.map((rule) => rule.record));
  const flat = raw.panels.flatMap((panel) => [panel, ...(panel.panels ?? [])]);
  const panels = flat.map((panel): Panel => {
    const targets = (panel.targets ?? []).map((target): PanelTarget => {
      const datasource = resolveDatasource(target.datasource ?? panel.datasource, datasources);
      const query = target.expr ?? target.query ?? `queryType: ${target.queryType ?? "none"}`;
      const type = datasources.find((source) => source.uid === datasource)?.type;
      return { refId: target.refId ?? "A", query, datasource, series: type === "prometheus" ? seriesOf(query) : [] };
    });
    const series = new Set(targets.flatMap((target) => target.series));
    const named = rules.filter((rule) => series.has(rule.record)).map((rule) => rule.record);
    const shared = rules.filter((rule) => !named.includes(rule.record) && rule.inputs.some((input) => series.has(input))).map((rule) => rule.record);
    return {
      id: panel.id,
      type: panel.type,
      title: panel.title ?? "",
      description: panel.description ?? "",
      ...panel.gridPos,
      targets,
      datasources: [...new Set(targets.map((target) => target.datasource))],
      rules: named,
      sharedRules: shared,
    };
  });
  // A rule name in a query is never a raw metric. This line finds a rule whose name a query spells differently.
  for (const panel of panels) for (const target of panel.targets) for (const name of target.series) if (name.includes(":") && !records.has(name)) throw new Error(`${file}: panel ${panel.id} names ${name}, which is not a rule of ${RULES}.`);
  return { uid: raw.uid, title: raw.title, file, rows: Math.max(...panels.map((panel) => panel.y + panel.h)), panels };
}

function readRules(yaml: Yaml): Rule[] {
  const js = yaml.doc.toJS() as { groups: readonly { name: string; interval: string; rules: readonly { record: string; expr: string }[] }[] };
  return js.groups.flatMap((group, groupIndex) =>
    group.rules.map((rule, ruleIndex): Rule => {
      const [, metric, operation] = rule.record.split(":");
      return {
        record: rule.record,
        expr: rule.expr,
        group: group.name,
        interval: group.interval,
        source: linesAt(yaml, ["groups", groupIndex, "rules", ruleIndex], rule.record),
        inputs: seriesOf(rule.expr),
        metric: metric ?? rule.record,
        operation: operation ?? "",
      };
    }),
  );
}

interface RawCompose {
  readonly services: Readonly<Record<string, { readonly ports?: readonly string[] }>>;
}

function mergeEdge(edges: MapEdge[], edge: MapEdge): void {
  const index = edges.findIndex((entry) => entry.from === edge.from && entry.to === edge.to);
  if (index < 0) edges.push(edge);
  else edges[index] = { ...edges[index]!, signals: [...new Set([...edges[index]!.signals, ...edge.signals])] };
}

/** This function reads the files under a root folder, and gives the data of the page. */
export function readSnapshot(root: string): Snapshot {
  const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
  const composeText = read(COMPOSE);
  const envText = read(ENV);
  const composeLines = lineCount(composeText);
  const compose = yamlOf(COMPOSE, composeText);
  const composeJs = compose.doc.toJS() as RawCompose;

  const serviceSource = (service: string): Source => linesAt(compose, ["services", service], `The Compose service ${service}`);
  const portOf = (service: string, container: string): string => {
    const mapping = (composeJs.services[service]?.ports ?? []).find((entry) => containerSide(entry) === container);
    if (mapping === undefined) throw new Error(`${COMPOSE}: the service ${service} has no port ${container}.`);
    return hostSide(mapping);
  };

  const dataSourcesYaml = yamlOf(DATASOURCES, read(DATASOURCES));
  const rawSources = (dataSourcesYaml.doc.toJS() as { datasources: readonly { name: string; type: string; url: string; uid?: string; isDefault?: boolean }[] }).datasources;
  const rulesYaml = yamlOf(RULES, read(RULES));
  const rules = readRules(rulesYaml);

  const withoutCounts = rawSources.map(
    (source, index): DataSource => ({
      uid: source.uid ?? source.name,
      name: source.name,
      type: source.type,
      url: source.url,
      isDefault: source.isDefault === true,
      queries: 0,
      source: linesAt(dataSourcesYaml, ["datasources", index], `The data source ${source.name}`),
    }),
  );
  const dashboards = DASHBOARDS.map((file) => readDashboard(file, read(file), withoutCounts, rules));
  const allTargets = dashboards.flatMap((dashboard) => dashboard.panels.flatMap((panel) => panel.targets));
  const datasources = withoutCounts.map((source) => ({ ...source, queries: allTargets.filter((target) => target.datasource === source.uid).length }));

  const alloyBlocks = parseAlloy(read(ALLOY));
  const pipeline = components(alloyBlocks);
  const receiver = pipeline.find((component) => component.id.startsWith("otelcol.receiver."));
  if (receiver === undefined) throw new Error(`${ALLOY}: no receiver.`);
  const httpBlock = child(receiver.block, "http");
  const grpcBlock = child(receiver.block, "grpc");
  const httpPort = attribute(httpBlock, "endpoint").split(":").at(-1)!;
  const grpcPort = attribute(grpcBlock, "endpoint").split(":").at(-1)!;

  const tempoYaml = yamlOf(TEMPO, read(TEMPO));
  const tempoJs = tempoYaml.doc.toJS() as { metrics_generator: { storage: { remote_write: readonly { url: string }[] } } };
  const spanTarget = tempoJs.metrics_generator.storage.remote_write[0]?.url;
  if (spanTarget === undefined) throw new Error(`${TEMPO}: no remote_write.`);
  const spanMetrics = linesAt(tempoYaml, ["metrics_generator", "storage", "remote_write"], "Tempo writes the span metrics to Mimir");

  const backendYamls: Record<string, Yaml> = { tempo: tempoYaml };
  for (const [service, part] of Object.entries(BACKEND_PARTS)) backendYamls[service] ??= yamlOf(part.file, read(part.file));

  const backendSources = (service: string): Source[] => {
    const part = BACKEND_PARTS[service];
    const compose = serviceSource(service);
    if (part === undefined) return [compose];
    return [compose, ...part.paths.map((path) => linesAt(backendYamls[service]!, path, `${path.join(".")} of ${part.file.split("/").pop()!}`))];
  };

  const dataSourceOfHost = (host: string): DataSource => {
    const found = datasources.find((source) => hostOf(source.url) === host);
    if (found === undefined) throw new Error(`${DATASOURCES}: no data source has the host ${host}.`);
    return found;
  };

  const nodes = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  const addNode = (node: MapNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };

  addNode({
    id: "browser",
    title: "Browser",
    name: "OpenTelemetry JS SDK",
    detail: `localhost:${portOf("alloy", httpPort)}`,
    column: 0,
    row: 1,
    sources: [blockSource(child(httpBlock, "cors"), "The pages that can post"), linesAt(compose, ["services", "alloy", "ports"], "The ports of Alloy on the host")],
  });
  addNode({
    id: "alloy",
    title: "Alloy",
    name: "alloy",
    detail: `UI localhost:${portOf("alloy", "12345")}`,
    column: 1,
    row: -1,
    sources: [serviceSource("alloy")],
  });
  addNode({
    id: "grafana",
    title: "Grafana",
    name: "grafana",
    detail: `localhost:${portOf("grafana", "3000")}`,
    column: 6,
    row: -1,
    sources: [serviceSource("grafana"), linesAt(yamlOf(PROVIDERS, read(PROVIDERS)), ["providers"], "The dashboard provider")],
  });

  const addBackend = (host: string, signal: Signal, container: string) => {
    const source = dataSourceOfHost(host);
    addNode({
      id: `service:${host}`,
      title: host[0]!.toUpperCase() + host.slice(1),
      name: host,
      detail: `localhost:${portOf(host, container)}`,
      column: 5,
      row: ROW_OF_SIGNAL[signal],
      sources: backendSources(host),
    });
    addNode({
      id: `source:${host}`,
      title: `${source.name} data source`,
      name: source.type,
      detail: `${rawSources.some((raw) => raw.uid === source.uid) ? `uid ${source.uid}` : "no uid"}, ${source.queries} ${source.queries === 1 ? "query" : "queries"}`,
      column: 6,
      row: ROW_OF_SIGNAL[signal],
      sources: [source.source],
    });
    mergeEdge(edges, { from: `service:${host}`, to: `source:${host}`, signals: [signal], label: source.url, branch: false });
    mergeEdge(edges, { from: `source:${host}`, to: "grafana", signals: [signal], label: `The data source ${source.name}`, branch: false });
  };

  const routes: Route[] = [];
  for (const signal of SIGNALS) {
    const route = walk(pipeline, receiver.id, signal);
    if (route.length === 0) {
      const source = datasources.find((candidate) => candidate.type.includes("pyroscope"));
      if (source === undefined) throw new Error(`${DATASOURCES}: no data source for ${signal}.`);
      const host = hostOf(source.url);
      const port = new URL(source.url).port;
      addBackend(host, signal, port);
      routes.push({
        signal,
        nodes: [`service:${host}`, `source:${host}`, "grafana"],
        branch: null,
        datasource: source.uid,
        gap: {
          text: `The output block of ${componentName(receiver)} has lines for ${Object.keys(receiver.outputs).join(", ")}. It has no line for ${signal}, so ${signal} never go through Alloy.`,
          source: blockSource(child(receiver.block, "output"), "The outputs of the receiver"),
        },
      });
      continue;
    }
    route.forEach((id, index) => {
      const component = pipeline.find((entry) => entry.id === id)!;
      const isExporter = component.endpoint !== undefined;
      const column = index === 0 ? 1 : isExporter ? 4 : id.includes(".transform.") ? 2 : 3;
      const isTransform = column === 2;
      const detail = isExporter
        ? component.endpoint!
        : index === 0
          ? `:${httpPort} HTTP, :${grpcPort} gRPC`
          : isTransform
            ? `${(child(component.block, "log_statements").attributes.find((entry) => entry.name === "statements")?.raw.match(/`/g)?.length ?? 0) / 2} log statements`
            : `timeout ${attribute(component.block, "timeout")}, batch ${attribute(component.block, "send_batch_size")}`;
      addNode({
        id,
        title: componentTitle(component),
        name: componentName(component),
        detail,
        column,
        row: isExporter ? ROW_OF_SIGNAL[signal] : isTransform ? 2 : 1,
        sources: [blockSource(component.block, componentName(component))],
      });
      if (index > 0) mergeEdge(edges, { from: route[index - 1]!, to: id, signals: [signal], label: signal, branch: false });
    });
    mergeEdge(edges, { from: "browser", to: receiver.id, signals: [signal], label: `OTLP to localhost:${portOf("alloy", httpPort)}`, branch: false });
    const exporter = pipeline.find((entry) => entry.id === route.at(-1))!;
    const host = hostOf(exporter.endpoint ?? "");
    const container = new URL(dataSourceOfHost(host).url).port;
    addBackend(host, signal, container);
    mergeEdge(edges, { from: exporter.id, to: `service:${host}`, signals: [signal], label: exporter.endpoint ?? "", branch: false });
    const source = dataSourceOfHost(host);
    const spanHost = hostOf(spanTarget);
    const branch = BACKEND_PARTS[host]?.file === TEMPO ? { from: `service:${host}`, nodes: [`service:${spanHost}`, `source:${spanHost}`, "grafana"], label: spanTarget } : null;
    if (branch !== null) {
      mergeEdge(edges, { from: branch.from, to: `service:${spanHost}`, signals: [signal], label: spanTarget, branch: true });
      mergeEdge(edges, { from: `service:${spanHost}`, to: `source:${spanHost}`, signals: [signal], label: "", branch: false });
      mergeEdge(edges, { from: `source:${spanHost}`, to: "grafana", signals: [signal], label: "", branch: false });
    }
    routes.push({ signal, nodes: ["browser", ...route, `service:${host}`, `source:${host}`, "grafana"], branch, datasource: source.uid, gap: null });
  }

  const secrets = secretValues([envText, composeText]);
  const shown = [COMPOSE, ENV, ALLOY, DATASOURCES, PROVIDERS, RULES, MIMIR, LOKI, TEMPO];
  const files: FileText[] = shown.map((path) => ({ path, lines: redactLines(lineCount(read(path)), secrets) }));

  return {
    files,
    nodes: [...nodes.values()],
    edges,
    routes,
    variables: readVariables(envText, composeLines),
    datasources,
    rules,
    dashboards,
    spanMetrics,
    services: Object.keys(composeJs.services).length,
  };
}
