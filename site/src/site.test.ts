import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baseValues, hostPorts, impactOf, panelMatches, panelsReading, panelsSharing, portProblems, ruleMatrix } from "./model.ts";
import { components, parseAlloy } from "./stack/alloy.ts";
import { changedLines, HIDDEN, isSecretName, parseDotEnv, references, resolveLines, substitute } from "./stack/compose-vars.ts";
import { seriesOf } from "./stack/promql.ts";
import { redactLines, secretValues } from "./stack/redact.ts";
import { readSnapshot } from "./stack/snapshot.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const snapshot = readSnapshot(root);
const compose = snapshot.files.find((file) => file.path === "docker-compose.yml")!.lines;
const panelsOf = (index: number) => snapshot.dashboards[index]!.panels.filter((panel) => panel.type !== "row");

describe("Compose substitution", () => {
  it("follows each form of Compose", () => {
    const vars = { SET: "value", EMPTY: "" };
    expect(substitute("${SET}", vars).text).toBe("value");
    expect(substitute("$SET", vars).text).toBe("value");
    expect(substitute("${NONE:-d}", vars).text).toBe("d");
    expect(substitute("${EMPTY:-d}", vars).text).toBe("d");
    expect(substitute("${EMPTY-d}", vars).text).toBe("");
    expect(substitute("${SET:+alt}", vars).text).toBe("alt");
    expect(substitute("${EMPTY:+alt}", vars).text).toBe("");
    expect(substitute("${EMPTY+alt}", vars).text).toBe("alt");
    expect(substitute("$$SET", vars).text).toBe("$SET");
    expect(substitute("${NONE:?needed}", vars).errors).toHaveLength(1);
  });

  it("does not resolve a comment line", () => {
    expect(resolveLines(["# ${A:-1}", "a: ${A:-1}"], {})).toEqual(["# ${A:-1}", "a: 1"]);
  });

  it("gives the lines that a change changes", () => {
    expect(changedLines(["a: ${A:-1}", "b: 2"], {}, { A: "5" })).toEqual([{ line: 1, before: "a: 1", after: "a: 5" }]);
  });

  it("reads a .env file", () => {
    expect(parseDotEnv("# note\nA=1\nB=2\n")).toMatchObject([
      { name: "A", value: "1", line: 2 },
      { name: "B", value: "2", line: 3 },
    ]);
  });

  it("names the variables of a line", () => {
    expect(references('      - "${GRAFANA_PORT:-3000}:3000"').map((use) => use.name)).toEqual(["GRAFANA_PORT"]);
  });
});

describe("the redaction", () => {
  it("knows the names of a secret", () => {
    expect(["DB_PASSWORD", "api_token", "MY_SECRET_KEY"].every(isSecretName)).toBe(true);
    expect(isSecretName("GRAFANA_PORT")).toBe(false);
  });

  it("keeps the form of a Compose line and removes the default", () => {
    const lines = redactLines(["      - GF_SECURITY_ADMIN_PASSWORD=${GF_SECURITY_ADMIN_PASSWORD:-letmein}"], secretValues(["GF_SECURITY_ADMIN_PASSWORD=letmein"]));
    expect(lines[0]).toBe("      - GF_SECURITY_ADMIN_PASSWORD=${GF_SECURITY_ADMIN_PASSWORD:-hidden}");
    expect(substitute(lines[0]!, { GF_SECURITY_ADMIN_PASSWORD: HIDDEN }).text).toContain("PASSWORD=hidden");
  });

  it("removes a plain assignment and a quoted value", () => {
    expect(redactLines(["API_TOKEN=abc"], [])[0]).toBe(`API_TOKEN=${HIDDEN}`);
    expect(redactLines(['secret: "abc"'], [])[0]).not.toContain("abc");
  });

  it("removes a secret value from a comment", () => {
    expect(redactLines(["# log in as (letmein/letmein)"], ["letmein"])[0]).not.toContain("letmein");
  });

  it("keeps the real secret out of each file of the page", () => {
    const env = parseDotEnv(readFileSync(new URL("../../.env", import.meta.url), "utf8"));
    const all = JSON.stringify(snapshot);
    for (const { name, value } of env) {
      if (isSecretName(name)) expect(all).not.toContain(`${name}=${value}`);
    }
    expect(all).toContain("GF_SECURITY_ADMIN_PASSWORD");
    expect(all).not.toContain("PASSWORD:-admin");
    expect(all).not.toContain("admin/admin");
    const hidden = snapshot.variables.filter((variable) => variable.hidden);
    expect(hidden.map((variable) => variable.name)).toContain("GF_SECURITY_ADMIN_PASSWORD");
    expect(hidden.every((variable) => variable.env === HIDDEN || variable.env === null)).toBe(true);
    expect(hidden.every((variable) => variable.composeDefault === null)).toBe(true);
  });
});

describe("the Alloy parser", () => {
  it("reads a block and its output", () => {
    const blocks = components(parseAlloy('otelcol.processor.batch "default" {\n  output {\n    metrics = [otelcol.exporter.prometheus.default.input]\n  }\n}\n'));
    expect(blocks[0]).toMatchObject({ id: "otelcol.processor.batch.default", outputs: { metrics: ["otelcol.exporter.prometheus.default"] } });
  });
});

describe("the query parser", () => {
  it("finds the series of a query, without its functions and labels", () => {
    expect(seriesOf('histogram_quantile(0.95, sum(rate(lag_a_bucket{job="x"}[5m])) by (le))')).toEqual(["lag_a_bucket"]);
  });
});

describe("the snapshot of the real files", () => {
  it("has the route of each signal through its real parts", () => {
    const route = (signal: string) => snapshot.routes.find((entry) => entry.signal === signal)!;
    expect(route("metrics").nodes).toEqual(expect.arrayContaining(["service:mimir", "grafana"]));
    expect(route("logs").nodes).toContain("service:loki");
    expect(route("traces").nodes).toContain("service:tempo");
    expect(route("traces").branch?.nodes).toContain("service:mimir");
    expect(route("profiles").gap).not.toBeNull();
    for (const entry of snapshot.routes) expect(entry.nodes.at(-1)).toBe("grafana");
  });

  it("gives real lines for each node", () => {
    for (const node of snapshot.nodes) {
      for (const source of node.sources) {
        const file = snapshot.files.find((entry) => entry.path === source.file);
        expect(file, source.file).toBeDefined();
        expect(source.start).toBeGreaterThan(0);
        expect(source.end).toBeLessThanOrEqual(file!.lines.length);
      }
    }
    const batch = snapshot.nodes.find((node) => node.id === "otelcol.processor.batch.default")!.sources[0]!;
    expect(snapshot.files.find((file) => file.path === batch.file)!.lines[batch.start - 1]).toContain('otelcol.processor.batch "default"');
  });

  it("gives each edge two real nodes", () => {
    const ids = new Set(snapshot.nodes.map((node) => node.id));
    for (const edge of snapshot.edges) {
      expect(ids.has(edge.from), edge.from).toBe(true);
      expect(ids.has(edge.to), edge.to).toBe(true);
    }
  });

  it("keeps the real grid of the dashboards", () => {
    const raw = JSON.parse(readFileSync(new URL("../../config/grafana/provisioning/dashboards/lag-monitor.json", import.meta.url), "utf8")) as { panels: { id: number; gridPos: { x: number; y: number } }[] };
    const board = snapshot.dashboards.find((entry) => entry.file.endsWith("lag-monitor.json"))!;
    for (const panel of raw.panels) {
      expect(board.panels.find((entry) => entry.id === panel.id)).toMatchObject({ x: panel.gridPos.x, y: panel.gridPos.y });
    }
  });
});

describe("the links between panels and rules", () => {
  it("follows a rule to its panels, and back", () => {
    const reading = panelsOf(0).filter((panel) => panel.rules.length > 0);
    expect(reading.map((panel) => panel.id)).toEqual([97, 98, 99, 100]);
    for (const panel of reading) {
      for (const record of panel.rules) expect(panelsReading(snapshot.dashboards, record).map((ref) => ref.panel.id)).toContain(panel.id);
    }
  });

  it("does not count a panel of the raw metric as fed by the rule", () => {
    const shared = panelsOf(0).find((panel) => panel.sharedRules.length > 0 && panel.rules.length === 0)!;
    const record = shared.sharedRules[0]!;
    expect(panelsSharing(snapshot.dashboards, record).map((ref) => ref.panel.id)).toContain(shared.id);
    expect(panelsReading(snapshot.dashboards, record).map((ref) => ref.panel.id)).not.toContain(shared.id);
  });

  it("gives the frontend dashboard no rule", () => {
    expect(panelsOf(1).every((panel) => panel.rules.length === 0)).toBe(true);
    expect(panelsOf(1)).toHaveLength(11);
  });

  it("filters panels", () => {
    expect(panelsOf(0).filter((panel) => panelMatches(panel, "rule", ""))).toHaveLength(4);
    expect(panelsOf(1).filter((panel) => panelMatches(panel, "all", "traces_spanmetrics")).length).toBeGreaterThan(0);
  });

  it("gives each rule one cell of the matrix", () => {
    const matrix = ruleMatrix(snapshot.rules);
    expect(matrix.rows.flatMap((row) => row.cells).filter((cell) => cell !== undefined)).toHaveLength(snapshot.rules.length);
  });
});

describe("the port editor", () => {
  const base = baseValues(snapshot.variables);

  it("starts with no change", () => {
    const impact = impactOf(compose, snapshot.variables, base);
    expect(impact.compose).toEqual([]);
    expect(impact.env).toEqual([]);
    expect(impact.problems).toEqual([]);
    expect(impact.command).toBe("docker compose up -d");
  });

  it("changes the real line of a port", () => {
    const impact = impactOf(compose, snapshot.variables, { ...base, GRAFANA_PORT: "3300" });
    expect(impact.compose).toHaveLength(1);
    expect(impact.compose[0]).toMatchObject({ line: 106 });
    expect(impact.compose[0]!.after).toContain('"3300:3000"');
    expect(impact.command).toBe("GRAFANA_PORT=3300 docker compose up -d");
  });

  it("uses the default of Compose for an empty value", () => {
    const line = hostPorts(compose, { ...base, GRAFANA_PORT: "" }).find((port) => port.line === 106);
    expect(line?.host).toBe("3000");
  });

  it("finds a bad port and a port on two lines", () => {
    expect(portProblems(hostPorts(compose, { ...base, GRAFANA_PORT: "99999" }))).toHaveLength(1);
    expect(portProblems(hostPorts(compose, { ...base, GRAFANA_PORT: base["LOKI_PORT"] }))[0]).toContain("two lines");
  });

  it("keeps the password variable hidden", () => {
    expect(base["GF_SECURITY_ADMIN_PASSWORD"]).toBe(HIDDEN);
  });
});
