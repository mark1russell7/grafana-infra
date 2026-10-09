#!/usr/bin/env node
/**
 * Verifies the stack end to end after `scripts/send-sample-data.mjs`:
 *
 * 1. Alloy, Mimir, Loki and Grafana are ready.
 * 2. The OTLP receiver answers CORS preflights for localhost pages only.
 * 3. Mimir stores every catalog metric under its catalog name (no unit or
 *    _total suffix), histograms as native histograms, with
 *    instance = service.instance.id, the promoted resource labels, and no
 *    session_id label.
 * 4. The recording rules are healthy and have data.
 * 5. Loki has only the index labels service_name and event_name, every
 *    catalog event, the event attributes as structured metadata, and the
 *    worker's own JSON hang report.
 * 6. Grafana loads the Lag Monitor dashboard, and every query of every
 *    panel and every annotation layer returns data through the Grafana
 *    datasource API.
 *
 * Usage:
 *   node scripts/verify-pipeline.mjs [--summary sample-summary.json]
 *     [--grafana http://localhost:3000] [--user admin --password admin]
 *     [--catalog ../lag/packages/lag/src/metric-catalog.ts]
 *
 * The exit code is 1 if a check fails.
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { EVENTS, METRICS } from "./lib/lag-catalog.mjs";

const { values : args } = parseArgs({
    options : {
        summary : { type : "string" },
        grafana : { type : "string", default : process.env.GRAFANA_URL ?? `http://localhost:${process.env.GRAFANA_PORT ?? 3000}` },
        user : { type : "string", default : process.env.GF_SECURITY_ADMIN_USER ?? "admin" },
        password : { type : "string", default : process.env.GF_SECURITY_ADMIN_PASSWORD ?? "admin" },
        mimir : { type : "string", default : "http://localhost:9009" },
        loki : { type : "string", default : "http://localhost:3100" },
        otlp : { type : "string", default : "http://localhost:4318" },
        alloy : { type : "string", default : "http://localhost:12345" },
        catalog : { type : "string" },
        dashboard : { type : "string", default : "lag-monitor" },
        verbose : { type : "boolean", default : false },
    },
});

const summary = args.summary ? JSON.parse(readFileSync(args.summary, "utf8")) : undefined;
const services = summary ? [...new Set(summary.pages.map(p => p.service))] : undefined;
const serviceRegex = services ? services.join("|") : ".+";
const fromMs = summary ? Date.parse(summary.startedAt) - 60_000 : Date.now() - 30 * 60_000;
// Instant queries (such as "active page loads in the last minute") run at the end of the sample run.
const toMs = summary ? Math.min(Date.now(), Date.parse(summary.endedAt) + 30_000) : Date.now();
const auth = `Basic ${Buffer.from(`${args.user}:${args.password}`).toString("base64")}`;

let failures = 0;
const results = [];
function check(ok, message, detail) {
    results.push({ ok, message });
    if (!ok) failures++;
    console.log(`${ok ? "  ok  " : "  FAIL"} ${message}${detail ? `\n         ${detail}` : ""}`);
}
function info(message) {
    console.log(`  info ${message}`);
}
function section(title) {
    console.log(`\n== ${title}`);
}

async function getJson(url, init = {}) {
    const response = await fetch(url, init);
    const text = await response.text();
    try {
        return { status : response.status, body : JSON.parse(text), headers : response.headers };
    } catch {
        return { status : response.status, body : text, headers : response.headers };
    }
}

async function promQuery(query, time = Date.now() / 1000) {
    const url = new URL(`${args.mimir}/prometheus/api/v1/query`);
    url.searchParams.set("query", query);
    url.searchParams.set("time", String(time));
    const { body } = await getJson(url);
    if (body.status !== "success") throw new Error(`${query}: ${JSON.stringify(body)}`);
    return body.data.result;
}

async function lokiGet(path, params) {
    const url = new URL(`${args.loki}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const { body } = await getJson(url, { headers : { "X-Loki-Response-Encoding-Flags" : "categorize-labels" } });
    return body;
}

const nanos = (ms) => `${BigInt(Math.floor(ms)) * 1_000_000n}`;

// ---------------------------------------------------------------------------

async function readiness() {
    section("Readiness");
    for (const [name, url, expect] of [
        ["Alloy", `${args.alloy}/-/ready`, "ready"],
        ["Mimir", `${args.mimir}/ready`, "ready"],
        ["Loki", `${args.loki}/ready`, "ready"],
        ["Grafana", `${args.grafana}/api/health`, "ok"],
    ]) {
        try {
            const response = await fetch(url);
            const text = await response.text();
            check(response.ok && text.toLowerCase().includes(expect), `${name} is ready (${url})`);
        } catch (error) {
            check(false, `${name} is ready (${url})`, String(error));
        }
    }
}

async function cors() {
    section("CORS of the OTLP/HTTP receiver");
    const preflight = (origin, path) => fetch(`${args.otlp}${path}`, {
        method : "OPTIONS",
        headers : { Origin : origin, "Access-Control-Request-Method" : "POST", "Access-Control-Request-Headers" : "content-type" },
    });
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:8080", "https://localhost:3443"]) {
        for (const path of ["/v1/logs", "/v1/metrics"]) {
            const response = await preflight(origin, path);
            const allowOrigin = response.headers.get("access-control-allow-origin");
            const allowHeaders = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
            const allowMethods = response.headers.get("access-control-allow-methods") ?? "";
            const credentials = response.headers.get("access-control-allow-credentials");
            check(response.status < 300 && allowOrigin === origin && allowMethods.includes("POST") && allowHeaders.includes("content-type"),
                `preflight ${path} from ${origin}: HTTP ${response.status}, allow-origin ${allowOrigin}, allow-methods ${allowMethods}, allow-headers ${allowHeaders}, allow-credentials ${credentials}`);
        }
    }
    const foreign = await preflight("https://example.com", "/v1/logs");
    check(!foreign.headers.get("access-control-allow-origin"), `preflight from https://example.com gets no Access-Control-Allow-Origin (HTTP ${foreign.status})`);
}

async function mimirMetrics() {
    section("Mimir: metric names, types and labels");
    const sampleServices = `service_name=~"${serviceRegex}"`;
    const window = `${Math.ceil((Date.now() - fromMs) / 60_000) + 1}m`;
    const seriesUrl = new URL(`${args.mimir}/prometheus/api/v1/series`);
    seriesUrl.searchParams.set("match[]", `{__name__=~"lag_.+", ${sampleServices}}`);
    seriesUrl.searchParams.set("start", String(fromMs / 1000));
    seriesUrl.searchParams.set("end", String(Date.now() / 1000));
    const names = new Set(((await getJson(seriesUrl)).body.data ?? []).map(s => s.__name__));
    for (const metric of METRICS) {
        const series = await promQuery(`last_over_time(${metric.name}{${sampleServices}}[${window}])`);
        const native = series.filter(s => s.histogram).length;
        const suffixed = [...names].filter(n => n !== metric.name && n.startsWith(`${metric.name}_`));
        if (metric.kind === "histogram") {
            check(series.length > 0 && native === series.length && suffixed.length === 0,
                `${metric.name}: ${series.length} series, ${native} native histograms${suffixed.length ? `, also ${suffixed.join(", ")}` : ""}`);
        } else {
            check(series.length > 0 && native === 0 && suffixed.length === 0,
                `${metric.name}: ${series.length} counter series${suffixed.length ? `, also ${suffixed.join(", ")}` : ""}`);
        }
    }
    const extra = [...names].filter(n => !METRICS.some(m => m.name === n));
    check(extra.length === 0, `no other lag_* names from the sample services${extra.length ? `: ${extra.join(", ")}` : ""}`);

    // instance = service.instance.id; promoted resource attributes; no session_id
    const drift = await promQuery(`last_over_time(lag_drift_histogram{${sampleServices}}[${window}])`);
    const instances = new Set(drift.map(s => s.metric.instance));
    if (summary) {
        const expected = summary.pages.map(p => p.instanceId);
        check(expected.every(id => instances.has(id)),
            `instance label = service.instance.id for all ${expected.length} page loads of the summary`,
            expected.filter(id => !instances.has(id)).join(", "));
    } else {
        check(instances.size > 0 && [...instances].every(i => /^[0-9a-f-]{36}$/.test(i)), `instance labels are UUIDs (${instances.size})`);
    }
    const labels = drift[0] ? Object.keys(drift[0].metric).sort() : [];
    info(`labels of lag_drift_histogram: ${labels.join(", ")}`);
    for (const label of ["job", "instance", "service_name", "service_version", "deployment_environment_name", "browser_platform", "browser_mobile"]) {
        check(labels.includes(label), `label ${label} is present`);
    }
    const sessionSeries = await promQuery(`count(last_over_time({__name__=~"lag_.+", session_id!=""}[${window}]))`);
    check(sessionSeries.length === 0, "no lag_* series has a session_id label");
    const sessionInfo = await promQuery(`count(last_over_time(target_info{job=~"${serviceRegex}", session_id!=""}[${window}]))`);
    check(sessionInfo.length === 0, "target_info of the sample services has no session_id label");
    const otherClients = await promQuery(`count by (job) (target_info{session_id!=""})`);
    if (otherClients.length) {
        info(`other clients put session.id on the resource (target_info{session_id}): ${otherClients.map(r => `${r.metric.job} (${r.value[1]} series)`).join(", ")}`);
    }
    const withoutInstance = await promQuery(`count by (job) (group by (job, __name__) ({__name__=~"lag_.+", instance=""}))`);
    if (withoutInstance.length) {
        info(`other clients send lag_* series without service.instance.id (no instance label): ${withoutInstance.map(r => r.metric.job).join(", ")}`);
    }
    const targetInfo = await promQuery(`target_info{job=~"${serviceRegex}"}`);
    info(`target_info series of the sample services: ${targetInfo.length}; labels: ${targetInfo[0] ? Object.keys(targetInfo[0].metric).sort().join(", ") : "none"}`);
    const metadata = await getJson(`${args.mimir}/prometheus/api/v1/metadata?metric=lag_drift_histogram`);
    info(`metadata of lag_drift_histogram: ${JSON.stringify(metadata.body.data?.lag_drift_histogram?.map(m => ({ type : m.type, unit : m.unit })))}`);

    // Rejected samples
    const metricsText = await (await fetch(`${args.mimir}/metrics`)).text();
    const discarded = metricsText.split("\n").filter(l => l.startsWith("cortex_discarded_samples_total{") && !l.endsWith(" 0"));
    info(discarded.length ? `cortex_discarded_samples_total (all tenants and sources):\n         ${discarded.join("\n         ")}` : "cortex_discarded_samples_total: no discarded samples");
}

async function recordingRules() {
    section("Mimir ruler: recording rules");
    const { body } = await getJson(`${args.mimir}/prometheus/api/v1/rules`);
    const rules = (body.data?.groups ?? []).flatMap(g => g.rules.map(r => ({ ...r, group : g.name })));
    check(rules.length > 0, `${rules.length} recording rules are loaded`);
    for (const rule of rules) {
        const series = await promQuery(`last_over_time(${rule.name}{service_name=~"${serviceRegex}"}[${Math.ceil((Date.now() - fromMs) / 60_000) + 1}m])`);
        check(rule.health === "ok" && !rule.lastError && series.length > 0,
            `${rule.name}: health ${rule.health}, ${series.length} series${rule.lastError ? `, error ${rule.lastError}` : ""}`);
    }
}

async function lokiEvents() {
    section("Loki: labels, events and the worker path");
    const start = nanos(fromMs);
    const end = nanos(Date.now());
    const series = await lokiGet("/loki/api/v1/series", { "match[]" : `{service_name=~"${serviceRegex}"}`, start, end });
    const indexLabels = new Set((series.data ?? []).flatMap(s => Object.keys(s)));
    check([...indexLabels].every(l => l === "service_name" || l === "event_name"),
        `index labels of the sample streams: ${[...indexLabels].sort().join(", ")}`);
    const eventNames = await lokiGet("/loki/api/v1/label/event_name/values", { start, end, query : `{service_name=~"${serviceRegex}"}` });
    for (const event of EVENTS) {
        check((eventNames.data ?? []).includes(event.name), `event ${event.name} is in Loki`);
    }

    // No event is lost: Loki drops an entry with the same timestamp and line as the previous one.
    // The last records of the sample (the final vitals and transitions of each page at its close) can
    // still be in the batch of Alloy when this check starts. Thus it waits up to 30 s for them.
    if (summary) {
        const rangeS = Math.ceil((toMs - fromMs) / 1000);
        const storedCount = async (name) => {
            const result = await lokiGet("/loki/api/v1/query", {
                query : `sum(count_over_time({service_name=~"${serviceRegex}", event_name="${name}"}[${rangeS}s]))`,
                time : String(toMs / 1000),
            });
            return Number(result.data?.result?.[0]?.value?.[1] ?? 0);
        };
        const deadline = Date.now() + 30_000;
        for (const event of EVENTS) {
            const sent = summary.counts.events[event.name] ?? 0;
            let stored = await storedCount(event.name);
            while (stored < sent && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 2_000));
                stored = await storedCount(event.name);
            }
            check(stored === sent, `${event.name}: Loki has ${stored} of the ${sent} events that the sample sent`);
        }
    }

    // Structured metadata of one event of each name
    for (const event of EVENTS) {
        const result = await lokiGet("/loki/api/v1/query_range", {
            query : `{service_name=~"${serviceRegex}", event_name="${event.name}"}`, start, end, limit : "1",
        });
        const entry = result.data?.result?.[0]?.values?.[0];
        const metadata = entry?.[2]?.structuredMetadata ?? {};
        const expected = event.attributes
            .filter(a => !a.endsWith("*") && !(event.optional ?? []).includes(a))
            .map(a => a.replaceAll(".", "_"));
        const missing = ["service_instance_id", "lag_page_view_id", ...expected].filter(k => !(k in metadata));
        check(entry && missing.length === 0, `${event.name}: structured metadata has the event attributes and service_instance_id`,
            missing.length ? `missing: ${missing.join(", ")}` : undefined);
        if (args.verbose && entry) info(`${event.name}: ${JSON.stringify(metadata)}`);
    }

    // The worker path: a JSON body from encodeOtlpLogs, posted with fetch keepalive
    const worker = await lokiGet("/loki/api/v1/query_range", {
        query : `{service_name=~"${serviceRegex}", event_name="lag.main_thread.hang"} | scope_name="@lag/worker"`, start, end, limit : "20",
    });
    const workerEntries = (worker.data?.result ?? []).flatMap(s => s.values);
    const phases = workerEntries.map(v => v[2]?.structuredMetadata?.phase).sort();
    check(workerEntries.length > 0, `worker hang reports (scope @lag/worker) in Loki: ${workerEntries.length}, phases ${phases.join(", ")}, line "${workerEntries[0]?.[1]}"`);
    if (summary) {
        for (const report of summary.workerReports) {
            check(report.status === 200 && report.allowOrigin === "http://localhost:5173",
                `worker POST (${report.phase}): HTTP ${report.status}, Access-Control-Allow-Origin ${report.allowOrigin}, response ${report.response}`);
            const found = workerEntries.some(v => v[2]?.structuredMetadata?.lag_page_view_id === report.pageViewId && v[2]?.structuredMetadata?.phase === report.phase);
            check(found, `worker report (${report.phase}) for page view ${report.pageViewId} is in Loki`);
        }
    }
    // Plain app logs have no event_name label
    const plain = await lokiGet("/loki/api/v1/query_range", { query : `{service_name=~"${serviceRegex}", event_name=""}`, start, end, limit : "5" });
    const plainEntries = (plain.data?.result ?? []).flatMap(s => s.values);
    check(plainEntries.length > 0, `app logs without an event name stay in streams without event_name: ${plainEntries.length} lines, for example "${plainEntries[0]?.[1]}"`);
}

// ---------------------------------------------------------------------------
// Grafana: the dashboard and every panel query
// ---------------------------------------------------------------------------

function substitute(expr) {
    return expr
        .replaceAll("$service_name", serviceRegex)
        .replaceAll("$navigation_type", ".+")
        .replaceAll("$instance", ".+")
        .replaceAll("${session_id:regex}", "");
}

function frameHasData(frame) {
    const values = frame.data?.values ?? [];
    const fields = frame.schema?.fields ?? [];
    if (values.length === 0) return false;
    // A log frame: any row. A numeric frame: any non-null number in a value field.
    if (fields.some(f => f.name === "Line" || f.name === "labels")) return (values[0]?.length ?? 0) > 0;
    return fields.some((f, i) => f.type === "number" && (values[i] ?? []).some(v => v !== null && Number.isFinite(v)));
}

async function grafanaDashboard() {
    section(`Grafana: dashboard ${args.dashboard}`);
    const headers = { Authorization : auth, "Content-Type" : "application/json" };
    const { status, body } = await getJson(`${args.grafana}/api/dashboards/uid/${args.dashboard}`, { headers });
    check(status === 200, `GET /api/dashboards/uid/${args.dashboard}: HTTP ${status}`);
    if (status !== 200) return;
    const dashboard = body.dashboard;
    const panels = dashboard.panels.filter(p => p.type !== "row");
    check(true, `"${dashboard.title}" loaded: ${panels.length} panels, ${dashboard.panels.length - panels.length} rows, provisioned ${body.meta.provisioned}, schemaVersion ${dashboard.schemaVersion}`);

    // The variables resolve through the datasource
    for (const variable of dashboard.templating.list) {
        const query = substitute(typeof variable.query === "string" ? variable.query : variable.query.query);
        const match = /label_values\((.+),\s*(\w+)\)$/.exec(query);
        if (!match) continue;
        const url = new URL(`${args.grafana}/api/datasources/proxy/uid/${variable.datasource.uid}/api/v1/label/${match[2]}/values`);
        url.searchParams.set("match[]", match[1]);
        url.searchParams.set("start", String(Math.floor(fromMs / 1000)));
        const values = await getJson(url, { headers });
        check(values.status === 200 && values.body.data?.length > 0, `variable $${variable.name}: ${JSON.stringify(values.body.data)}`);
    }

    let current = "";
    const rows = [];
    for (const panel of dashboard.panels) {
        if (panel.type === "row") {
            current = panel.title;
            continue;
        }
        const queries = panel.targets.map(t => ({
            refId : t.refId,
            datasource : t.datasource ?? panel.datasource,
            expr : substitute(t.expr),
            legendFormat : t.legendFormat,
            ...(t.datasource?.type === "loki" || panel.datasource?.type === "loki"
                ? { queryType : t.queryType ?? "range", maxLines : t.maxLines ?? 100 }
                : { range : t.range !== false, instant : t.instant === true }),
            intervalMs : 15_000,
            maxDataPoints : 300,
        }));
        const response = await getJson(`${args.grafana}/api/ds/query`, {
            method : "POST",
            headers,
            body : JSON.stringify({ queries, from : String(fromMs), to : String(toMs) }),
        });
        for (const query of queries) {
            const result = response.body?.results?.[query.refId];
            const frames = result?.frames ?? [];
            const withData = frames.filter(frameHasData).length;
            const ok = !result?.error && withData > 0;
            rows.push({ row : current, panel : panel.title, refId : query.refId, ok, frames : frames.length, withData, error : result?.error });
            check(ok, `[${current}] ${panel.title} / ${query.refId}: ${result?.error ? `ERROR ${result.error}` : `${withData} of ${frames.length} frames with data`}`,
                ok && !args.verbose ? undefined : query.expr);
        }
    }
    const good = rows.filter(r => r.ok).length;
    info(`${good} of ${rows.length} panel queries returned data`);

    // Each annotation layer finds events, and each event line has the fields of its templates
    for (const layer of dashboard.annotations.list.filter(a => !a.builtIn)) {
        const query = { refId : "Anno", datasource : layer.datasource, expr : substitute(layer.target.expr), queryType : "range", maxLines : 100 };
        const response = await getJson(`${args.grafana}/api/ds/query`, {
            method : "POST",
            headers,
            body : JSON.stringify({ queries : [query], from : String(fromMs), to : String(toMs) }),
        });
        const result = response.body?.results?.Anno;
        const frames = result?.frames ?? [];
        const withData = frames.filter(frameHasData).length;
        check(!result?.error && withData > 0, `annotation "${layer.name}": ${result?.error ? `ERROR ${result.error}` : `${withData} of ${frames.length} frames with data`}`,
            args.verbose ? query.expr : undefined);
    }
}

// ---------------------------------------------------------------------------
// Optional: compare the catalog copy with the TypeScript catalog
// ---------------------------------------------------------------------------

function compareCatalog(path) {
    section(`Catalog copy against ${path}`);
    const source = readFileSync(path, "utf8");
    const found = [];
    const re = /metric\(\s*"(\w+)",\s*"(\w+)",\s*"([^"]*)",/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        // The attribute object is the last {...} before the closing parenthesis of this call.
        let depth = 1;
        let i = re.lastIndex;
        let inString = false;
        for (; i < source.length && depth > 0; i++) {
            const c = source[i];
            if (c === '"' && source[i - 1] !== "\\") inString = !inString;
            if (inString) continue;
            if (c === "(") depth++;
            if (c === ")") depth--;
        }
        // Without string literals, the attribute object is the last {...} of the call.
        const call = source.slice(re.lastIndex, i).replace(/"(?:[^"\\]|\\.)*"/g, '""');
        const objectStart = call.lastIndexOf("{");
        const keys = objectStart >= 0 ? [...call.slice(objectStart).matchAll(/(\w+)\s*:/g)].map(k => k[1]) : [];
        found.push({ name : m[1], kind : m[2], unit : m[3], keys : keys.sort() });
    }
    for (const metric of METRICS) {
        const ts = found.find(f => f.name === metric.name);
        const keys = Object.keys(metric.attributes).sort();
        check(ts && ts.kind === metric.kind && ts.unit === metric.unit && JSON.stringify(ts.keys) === JSON.stringify(keys),
            `${metric.name}: ${ts ? `${ts.kind} ${ts.unit} [${ts.keys.join(", ")}]` : "missing in the TypeScript catalog"}`);
    }
    for (const ts of found.filter(f => !METRICS.some(m => m.name === f.name))) {
        check(false, `${ts.name} is in the TypeScript catalog but not in scripts/lib/lag-catalog.mjs`);
    }
    for (const event of EVENTS) {
        const block = new RegExp(`name\\s*:\\s*"${event.name.replaceAll(".", "\\.")}"[\\s\\S]*?attributes\\s*:\\s*\\[([\\s\\S]*?)\\]`).exec(source);
        const attributes = block ? [...block[1].matchAll(/"([^"]+)"/g)].map(a => a[1]) : [];
        check(block && JSON.stringify(attributes) === JSON.stringify(event.attributes), `event ${event.name}: [${attributes.join(", ")}]`);
    }
}

// ---------------------------------------------------------------------------

if (args.catalog) compareCatalog(args.catalog);
await readiness();
await cors();
await mimirMetrics();
await recordingRules();
await lokiEvents();
await grafanaDashboard();

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} checks failed`} (${results.length} checks).`);
process.exitCode = failures === 0 ? 0 : 1;
