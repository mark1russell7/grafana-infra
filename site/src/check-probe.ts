/**
 * The probe of the signal map, the dashboard explorer and the port editor. The site check of the Pages workflow starts it in
 * a browser at each width, before the deploy. A failed check stops the deploy.
 *
 * The site check reads this TypeScript file directly. It removes the types and the `export` line, and it starts the result
 * as the body of an async function.
 */

// The site check gives these helpers to the probe. Each element of this page is an HTML element.
declare const check: (name: string, ok: unknown, detail?: unknown) => boolean;
declare const until: <T>(fn: () => T | Promise<T>, ms?: number) => Promise<T>;
declare const $: (selector: string) => HTMLElement | null;
declare const $$: (selector: string) => HTMLElement[];
declare const type: (target: string | Element, text: string) => void;
declare const click: (target: string | Element) => void;

const text = (selector: string) => $(selector)?.textContent ?? "";
const visible = (element: HTMLElement) => element.offsetParent !== null;

/** The button of a node that the screen shows: the stage on a wide screen, the list on a phone. */
const node = (id: string) => $$(`[data-node="${id}"]`).find(visible);
const nodesOnRoute = () => $$("#map-wide .node.is-on, #map-list .node").filter(visible).map((button) => button.dataset["node"] ?? "");
const excerptLines = () => $$("#detail-sources .ln .tx").map((line) => line.textContent ?? "");
const lineNumbers = () => $$("#detail-sources .ln .no").map((line) => Number(line.textContent));
const tile = (id: number) => $(`#panel-grid [data-panel="${id}"]`);
const tiles = () => $$("#panel-grid .tile");
const linked = (kind: string) => tiles().filter((element) => element.dataset["link"] === kind);
const diffLine = (line: number) => $(`#diff [data-line="${line}"]`);
const problems = () => $$("#port-problems li").map((item) => item.textContent ?? "");

// The signal map.
check("the page opens on metrics", await until(() => $("#signal-metrics")?.getAttribute("aria-pressed") === "true"), text("#route-summary"));
check("the route of metrics ends in Mimir and Grafana", await until(() => nodesOnRoute().includes("service:mimir") && nodesOnRoute().includes("grafana")), nodesOnRoute().join());
check("a node is open at the start, so the real lines show at once", excerptLines().length > 0, excerptLines().length);

click("#signal-logs");
check("logs go through the Loki exporter", await until(() => nodesOnRoute().includes("service:loki") && !nodesOnRoute().includes("service:mimir")), nodesOnRoute().join());
check("logs name the real Alloy exporter", await until(() => text("#route-summary").includes("Loki")), text("#route-summary"));

click("#signal-traces");
check("traces reach Tempo", await until(() => nodesOnRoute().includes("service:tempo")), nodesOnRoute().join());
check("traces show the second route to Mimir", await until(() => text("#route-summary").includes("second route")), text("#route-summary"));

click("#signal-profiles");
check("profiles have no route through Alloy", await until(() => text("#detail-title") === "No route through Alloy"), text("#detail-title"));
check("the page says what the receiver has", /metrics.*logs.*traces/s.test(excerptLines().join("\n")), excerptLines().join(" | ").slice(0, 200));
check("Pyroscope stays on the map as a backend", nodesOnRoute().includes("service:pyroscope"), nodesOnRoute().join());

// A node shows its exact lines.
click("#signal-metrics");
const batch = await until(() => node("otelcol.processor.batch.default"));
click(batch!);
check("the batch node shows its real block", await until(() => excerptLines().some((line) => line.includes('otelcol.processor.batch "default"'))), excerptLines().slice(0, 3).join(" | "));
check("the lines have their real numbers", lineNumbers()[0] === 84, lineNumbers().slice(0, 3).join());
check("the excerpt links to the file on GitHub", $("#detail-sources a")?.getAttribute("href")?.includes("config/alloy/config.alloy#L84-L"), $("#detail-sources a")?.getAttribute("href"));

// The dashboard explorer.
check("the Lag Monitor has its panels on the grid", tiles().length === Number(text('[data-board] span').split(" ")[0]), `${tiles().length} tiles, tab ${text("[data-board] span")}`);
const rulePanel = await until(() => tile(97));
check("a panel stands on its real grid position", rulePanel!.style.gridColumnStart === String(Number(rulePanel!.dataset["x"]) + 1) && rulePanel!.style.gridRowStart === String(Number(rulePanel!.dataset["y"]) + 1), `${rulePanel!.style.gridColumnStart} ${rulePanel!.style.gridRowStart}`);
click(rulePanel!);
check("a panel that reads rules names them", await until(() => text("#feeds").includes("Fed by 6 recording rules")), text("#feeds").slice(0, 120));
const records = $$("[data-rule-link]").map((element) => element.dataset["ruleLink"]!);
const record = records[0]!;
check("its query is the real expression", text("#queries").includes(record), text("#queries").slice(0, 160));

click(`[data-rule-link="${record}"]`);
check("a rule shows its lines of lag.yaml", await until(() => text("#explain-title") === record && $('#explain .excerpt[data-file$="lag.yaml"]') !== null), text("#explain-title"));
check("the rule lights the panel that reads it", await until(() => linked("reads").some((element) => element.dataset["panel"] === "97")), linked("reads").length);
check("the matrix marks the rule", $(`[data-rule="${record}"]`)?.dataset["link"] === "selected", $(`[data-rule="${record}"]`)?.dataset["link"]);

for (const entry of records) {
  click(`[data-rule="${entry}"]`);
  await until(() => text("#explain-title") === entry);
  if ($("#rule-sharers [data-panel-link]") !== null) break;
}
check("a rule marks the panels of the same input", linked("shares").length > 0, linked("shares").length);
click($("#rule-sharers [data-panel-link]")!);
check("a panel of the raw metric says that no rule feeds it", await until(() => text("#feeds").includes("No recording rule feeds this panel")), text("#feeds").slice(0, 120));
check("the same panel names the rules of its input", $$("#feeds [data-rule-link]").length > 0, $$("#feeds [data-rule-link]").length);

click('[data-filter="rule"]');
check("the filter leaves only the panels that name a rule", await until(() => tiles().filter((element) => element.dataset["match"] === "true").length === 4), tiles().filter((element) => element.dataset["match"] === "true").length);
click('[data-filter="all"]');

type("#panel-search", "traces_spanmetrics");
check("a search in the Lag Monitor finds no span metrics", await until(() => tiles().every((element) => element.dataset["match"] === "false")), text("#panel-count"));
type("#panel-search", "");

click(".tab:nth-child(2)");
const secondCount = Number(text(".tab:nth-child(2) span").split(" ")[0]);
check("the second dashboard shows its own panels", await until(() => tiles().length === secondCount && secondCount === 11), tiles().length);
check("that dashboard says that it names no rule", await until(() => text("#matrix-note").includes("names no recording rule")), text("#matrix-note"));
click(".tab:nth-child(1)");
await until(() => tiles().length > secondCount);

click("#fit");
const scroller = $("#grid-scroller")!;
check("the whole dashboard fits its scroller", await until(() => scroller.scrollHeight <= scroller.clientHeight + 1 && scroller.scrollWidth <= scroller.clientWidth + 1), `${scroller.scrollHeight} ${scroller.clientHeight}`);
click("#fit");

// The port editor.
const compose = () => $$("#resolved-file .ln .tx").map((line) => line.textContent ?? "");
type("#input-GRAFANA_PORT", "3300");
check("3300 changes the line of the Grafana port", await until(() => diffLine(106)?.textContent?.includes('"3300:3000"')), diffLine(106)?.textContent);
check("the old value is on the same line", diffLine(106)?.textContent?.includes('"3000:3000"'), diffLine(106)?.textContent);
check("the .env line changes too", $('#diff [data-env="GRAFANA_PORT"]')?.textContent?.includes("GRAFANA_PORT=3300"), $('#diff [data-env="GRAFANA_PORT"]')?.textContent);
check("the command carries the value", text("#up-command") === "GRAFANA_PORT=3300 docker compose up -d", text("#up-command"));
check("the map uses the same value", await until(() => (node("grafana")?.textContent ?? "").includes("3300")), node("grafana")?.textContent);
check("the resolved file marks one line", $$("#resolved-file .ln.is-changed").length === 1 && compose()[105]?.includes('"3300:3000"'), compose()[105]);

type("#input-GRAFANA_PORT", "");
check("an empty value falls back to the default of Compose", await until(() => text("#note-GRAFANA_PORT").includes("default 3000")), text("#note-GRAFANA_PORT"));
check("the line of the fallback is the line of .env", diffLine(106) === null, diffLine(106)?.textContent);

type("#input-GRAFANA_PORT", "99999");
check("a port out of range shows a problem", await until(() => problems().some((problem) => problem.includes("99999"))), problems().join());
click('[data-preset="clash"]');
check("two services on one port show a problem", await until(() => problems().some((problem) => problem.includes("two lines"))), problems().join());
click('[data-preset="shift-1000"]');
check("the second stack moves each port", await until(() => text("#port-rows").includes("localhost:4000") && problems().length === 0), problems().join());
click('[data-preset="reset"]');
check("reset gives the .env values", await until(() => $$("#diff .diff-line").length === 0 && text("#up-command") === "docker compose up -d"), text("#up-command"));

// No secret value reaches the page.
const hidden = $('[data-hidden="GF_SECURITY_ADMIN_PASSWORD"]');
check("the password variable shows its name and the word hidden", hidden !== null && hidden.textContent?.includes("hidden"), hidden?.textContent);
check("the password variable has no field", hidden?.querySelector("input") === null, hidden?.innerHTML);
check("the page text has no password value", !/(PASSWORD|SECRET|TOKEN)[A-Z_]*\s*[=:]\s*(?!-?hidden|\$\{)\S/.test(document.documentElement.textContent ?? ""), "");
const script = $$("script[src]").map((element) => element.getAttribute("src")).find((src) => src?.includes("assets/")) ?? "";
const bundle = script === "" ? "" : await (await fetch(script)).text();
check("the bundle has no value of a secret default", bundle.includes("GF_SECURITY_ADMIN_PASSWORD") && !bundle.includes("PASSWORD:-admin") && !bundle.includes("admin/admin"), bundle.length);

// Each wide view keeps to its card, unless it is a scroller.
const wide = ["#matrix", "#ports-table", "#map-wide", "#map-list", "#diff", ".command", ".signals", ".steps", "#fields"];
for (const selector of wide) {
  const element = $(selector);
  if (element === null || !visible(element)) continue;
  check(`${selector} keeps to its width`, element.scrollWidth <= element.clientWidth + 1, `${element.scrollWidth} > ${element.clientWidth}`);
  const card = element.parentElement!;
  check(`${selector} keeps to its card`, element.getBoundingClientRect().right <= card.getBoundingClientRect().right + 1, `${element.getBoundingClientRect().right} ${card.getBoundingClientRect().right}`);
}

const before = document.documentElement.dataset["theme"];
click("#theme");
check("the theme button changes the theme", await until(() => document.documentElement.dataset["theme"] !== before), document.documentElement.dataset["theme"]);

export {};
