#!/usr/bin/env node
/**
 * Takes screenshots of the Lag Monitor dashboard after
 * `scripts/send-sample-data.mjs`, so that a reviewer can see the panels and
 * the annotation layers:
 *
 * - fleet.png: the dashboard as provisioned (all page loads).
 * - table-<title>.png: each table of events, and the table of the page view
 *   traces, in view after its query.
 * - table-page-views-page-<index>.png: the page views table of one page
 *   load, with the Trace column.
 * - trace-page-<index>.png: the trace of the first view of that page load.
 *   The script opens it with a click on the Trace link of the table, thus
 *   the screenshot also shows that the link works.
 * - trace-abandoned-hang.png: the trace of the page that hung, with the span
 *   of the abandoned hang open, and its link to the view that reported it.
 * - explore-loki-trace-link.png: a lag.page_view.start event in Explore, with
 *   the link of the Loki derived field to the trace.
 * - page-<index>.png: one page load of the sample, with every annotation
 *   layer turned on. The script saves a copy of the dashboard with all
 *   layers on (uid lag-monitor-review), because a URL cannot turn a layer on.
 *
 * Usage:
 *   node scripts/screenshot-dashboard.mjs --summary sample-summary.json
 *     [--grafana http://localhost:3000] [--out screenshots] [--pages 0,1]
 *     [--trace-page 1]
 */

import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const { values : args } = parseArgs({
    options : {
        summary : { type : "string", default : "sample-summary.json" },
        grafana : { type : "string", default : "http://localhost:3000" },
        out : { type : "string", default : "screenshots" },
        pages : { type : "string", default : "0,1" },
        // Page 1 of the sample has a hang, a stall and long animation frames in its first view
        "trace-page" : { type : "string", default : "1" },
    },
});

const summary = JSON.parse(readFileSync(args.summary, "utf8"));
mkdirSync(args.out, { recursive : true });
const from = Date.parse(summary.startedAt) - 60_000;
const to = Date.parse(summary.endedAt) + 60_000;

// A copy of the dashboard with every annotation layer on
const { dashboard } = await (await fetch(`${args.grafana}/api/dashboards/uid/lag-monitor`)).json();
const review = {
    ...dashboard,
    id : null,
    uid : "lag-monitor-review",
    title : "Lag Monitor (all annotations)",
    annotations : { list : dashboard.annotations.list.map(layer => (layer.builtIn ? layer : { ...layer, enable : true })) },
};
const saved = await fetch(`${args.grafana}/api/dashboards/db`, {
    method : "POST",
    headers : { "Content-Type" : "application/json" },
    body : JSON.stringify({ dashboard : review, overwrite : true }),
});
if (!saved.ok) throw new Error(`Could not save the review dashboard: HTTP ${saved.status} ${await saved.text()}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport : { width : 1600, height : 1200 }, deviceScaleFactor : 1 });

// For a review of the annotation layers: each query that Grafana sends for them, and its result
const annotationQueries = [];
const consoleErrors = [];
/** The fields of the log frames of the Loki panels: the transformations of the tables use them. */
const logFrames = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("response", async (response) => {
    if (!response.url().includes("/api/ds/query")) return;
    const request = response.request().postData() ?? "";
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    const results = body?.results ?? {};
    if (!request.includes("logfmt")) {
        for (const [refId, result] of Object.entries(results)) {
            const frame = result.frames?.[0];
            const fields = frame?.schema?.fields?.map(f => `${f.name}:${f.type}`) ?? [];
            if (fields.some(f => f.startsWith("labels:") || f.startsWith("Line:") || f.startsWith("body:")) && logFrames.length < 20) {
                logFrames.push({ refId, fields, rows : frame?.data?.values?.[0]?.length ?? 0, firstLabels : frame?.data?.values?.find(v => typeof v?.[0] === "object")?.[0] });
            }
        }
        return;
    }
    annotationQueries.push({
        status : response.status(),
        queries : JSON.parse(request).queries?.map(q => ({ refId : q.refId, expr : q.expr, queryType : q.queryType })),
        frames : Object.fromEntries(Object.entries(results).map(([refId, r]) => [refId, { error : r.error, frames : r.frames?.length ?? 0, rows : r.frames?.[0]?.data?.values?.[0]?.length ?? 0 }])),
    });
});

/** Opens a dashboard in the time range of the sample, and loads all its panels. */
async function open(path) {
    await page.goto(`${args.grafana}${path}${path.includes("?") ? "&" : "?"}from=${from}&to=${to}&kiosk`, { waitUntil : "networkidle", timeout : 120_000 });
    // The panels load lazily: scroll to the end and back, then wait for the queries
    await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 800) {
            window.scrollTo(0, y);
            await new Promise(resolve => setTimeout(resolve, 400));
        }
        window.scrollTo(0, 0);
    });
    await page.waitForLoadState("networkidle", { timeout : 120_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
}

async function shoot(path, file) {
    await open(path);
    await page.screenshot({ path : join(args.out, file), fullPage : true });
    console.log(`Wrote ${join(args.out, file)}`);
}

/** The panel with this title, in view after its query. */
async function panelInView(title) {
    const panel = page.locator(`[data-viz-panel-key], section`).filter({ has : page.getByText(title, { exact : true }) }).first();
    await panel.scrollIntoViewIfNeeded({ timeout : 10_000 });
    await page.waitForTimeout(4_000);
    return panel;
}

await shoot("/d/lag-monitor/lag-monitor", "fleet.png");

// The tables of events and of traces, one at a time: each one in view, after its query
const tables = [];
const tableTitles = [
    "Page loads", "Recent page views and lifecycle transitions", "Recent hangs and stalls", "Recent clock jumps",
    "LoAF attribution: blocking time by script (events)", "Page view traces",
];
for (const title of tableTitles) {
    try {
        const panel = await panelInView(title);
        const file = `table-${title.toLowerCase().replaceAll(/[^a-z]+/g, "-")}.png`;
        await panel.screenshot({ path : join(args.out, file) });
        // The data links of the cells, for example the Trace links
        const links = await panel.locator("a").evaluateAll(as => as.map(a => ({ text : a.textContent.trim(), href : a.getAttribute("href") })).filter(a => a.text));
        tables.push({ title, file, text : (await panel.innerText()).slice(0, 400), links : links.slice(0, 20) });
    } catch (error) {
        tables.push({ title, error : String(error).slice(0, 300) });
    }
}
writeFileSync(join(args.out, "tables.json"), JSON.stringify(tables, null, 2));

// The traces in Explore. An Explore URL has one pane: a query of one datasource.
const traces = [];
const explore = (pane) => `${args.grafana}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify({ a : { ...pane, range : { from : String(from), to : String(to) } } }))}`;
const tempoPane = (traceId) => ({
    datasource : "tempo",
    queries : [{ refId : "A", datasource : { type : "tempo", uid : "tempo" }, queryType : "traceql", query : traceId }],
});

/**
 * Opens a trace in Explore (with `url`, or with `navigate`), waits for the
 * trace view, does `prepare` and takes the screenshot.
 */
async function shootTrace(url, file, prepare, navigate) {
    if (navigate) await navigate();
    else await page.goto(url, { waitUntil : "networkidle", timeout : 120_000 });
    await page.getByText("lag.page_view").first().waitFor({ timeout : 30_000 });
    await page.waitForTimeout(1_500);
    if (prepare) await prepare();
    await page.screenshot({ path : join(args.out, file) });
    console.log(`Wrote ${join(args.out, file)}`);
}

// 1. The trace of the first view of a page load, through the Trace link of the page views table. The
//    table of all page loads shows only its latest rows, thus the script selects the page load first.
const tracePage = summary.pages.find(p => p.index === Number(args["trace-page"]));
const traceView = tracePage?.views[0];
if (traceView) {
    const file = `trace-page-${tracePage.index}.png`;
    const tableFile = `table-page-views-page-${tracePage.index}.png`;
    try {
        await open(`/d/lag-monitor/lag-monitor?var-service_name=${tracePage.service}&var-instance=${tracePage.instanceId}`);
        const panel = await panelInView("Recent page views and lifecycle transitions");
        await panel.screenshot({ path : join(args.out, tableFile) });
        console.log(`Wrote ${join(args.out, tableFile)}`);
        // The cell shows "Open trace". The URL of the link has the trace ID.
        const link = panel.locator(`a[href*="${traceView.traceId}"]`).first();
        const href = await link.getAttribute("href", { timeout : 10_000 }).catch(() => null);
        // A click on the link, as a user does. Without the link, the trace opens with an Explore URL.
        await shootTrace(explore(tempoPane(traceView.traceId)), file, undefined, href ? () => link.click() : undefined);
        traces.push({
            file, table : tableFile, traceId : traceView.traceId, viewId : traceView.id, spans : traceView.spans,
            openedBy : href ? "a click on the Trace link of the page views table" : "an Explore URL: the page views table had no Trace link for this view",
            link : href, url : page.url(),
        });
    } catch (error) {
        traces.push({ file, traceId : traceView.traceId, error : String(error).slice(0, 300) });
    }
}

// 2. The trace of the page that hung, with the span of the abandoned hang and its references open:
//    the parent (the view of the page that hung) and the link to the view that reported the hang
const hang = summary.abandonedHangs?.[0];
if (hang) {
    const file = "trace-abandoned-hang.png";
    try {
        await shootTrace(explore(tempoPane(hang.traceId)), file, async () => {
            await page.getByText("lag.main_thread.hang").first().click();
            const references = page.getByText("References", { exact : true }).first();
            await references.click();
            await references.scrollIntoViewIfNeeded();
            await page.waitForTimeout(1_000);
        });
        traces.push({ file, traceId : hang.traceId, hungPage : hang.pageId, reporter : hang.reporter });
    } catch (error) {
        traces.push({ file, traceId : hang.traceId, error : String(error).slice(0, 300) });
    }
}

// 3. The lag.page_view.start event of that view in Explore: the derived field links it to its trace
if (traceView) {
    const file = "explore-loki-trace-link.png";
    try {
        const expr = `{service_name="${tracePage.service}", event_name="lag.page_view.start"} | lag_page_view_id="${traceView.id}"`;
        await page.goto(explore({ datasource : "loki", queries : [{ refId : "A", datasource : { type : "loki", uid : "loki" }, queryType : "range", expr }] }),
            { waitUntil : "networkidle", timeout : 120_000 });
        await page.getByText("lag.page_view.start lag.page_view.id=").first().click();
        const derived = page.getByText("Open the trace of the page view").first();
        await derived.scrollIntoViewIfNeeded();
        await page.waitForTimeout(1_000);
        await page.screenshot({ path : join(args.out, file) });
        console.log(`Wrote ${join(args.out, file)}`);
        traces.push({ file, viewId : traceView.id, link : await derived.evaluate(el => el.closest("a")?.getAttribute("href")) });
    } catch (error) {
        traces.push({ file, viewId : traceView.id, error : String(error).slice(0, 300) });
    }
}
writeFileSync(join(args.out, "traces.json"), JSON.stringify(traces, null, 2));
for (const index of args.pages.split(",").map(Number)) {
    const sample = summary.pages.find(p => p.index === index);
    if (!sample) continue;
    await shoot(`/d/lag-monitor-review/lag-monitor-review?var-service_name=${sample.service}&var-instance=${sample.instanceId}`, `page-${index}.png`);
}
await browser.close();
writeFileSync(join(args.out, "annotations.json"), JSON.stringify({ annotationQueries, consoleErrors, logFrames }, null, 2));
console.log(`Annotation queries: ${annotationQueries.length}; console errors: ${consoleErrors.length}`);
