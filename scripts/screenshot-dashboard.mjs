#!/usr/bin/env node
/**
 * Takes screenshots of the Lag Monitor dashboard after
 * `scripts/send-sample-data.mjs`, so that a reviewer can see the panels and
 * the annotation layers:
 *
 * - fleet.png: the dashboard as provisioned (all page loads).
 * - page-<index>.png: one page load of the sample, with every annotation
 *   layer turned on. The script saves a copy of the dashboard with all
 *   layers on (uid lag-monitor-review), because a URL cannot turn a layer on.
 *
 * Usage:
 *   node scripts/screenshot-dashboard.mjs --summary sample-summary.json
 *     [--grafana http://localhost:3000] [--out screenshots] [--pages 0,1]
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

async function shoot(path, file) {
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
    await page.screenshot({ path : join(args.out, file), fullPage : true });
    console.log(`Wrote ${join(args.out, file)}`);
}

await shoot("/d/lag-monitor/lag-monitor", "fleet.png");

// The tables of events, one at a time: each one in view, after its query
const tables = [];
for (const title of ["Page loads", "Recent page views and lifecycle transitions", "Recent hangs and stalls", "Recent clock jumps"]) {
    const panel = page.locator(`[data-viz-panel-key], section`).filter({ has : page.getByText(title, { exact : true }) }).first();
    try {
        await panel.scrollIntoViewIfNeeded({ timeout : 10_000 });
        await page.waitForTimeout(4_000);
        const file = `table-${title.toLowerCase().replaceAll(/[^a-z]+/g, "-")}.png`;
        await panel.screenshot({ path : join(args.out, file) });
        tables.push({ title, file, text : (await panel.innerText()).slice(0, 400) });
    } catch (error) {
        tables.push({ title, error : String(error).slice(0, 300) });
    }
}
writeFileSync(join(args.out, "tables.json"), JSON.stringify(tables, null, 2));
for (const index of args.pages.split(",").map(Number)) {
    const sample = summary.pages.find(p => p.index === index);
    if (!sample) continue;
    await shoot(`/d/lag-monitor-review/lag-monitor-review?var-service_name=${sample.service}&var-instance=${sample.instanceId}`, `page-${index}.png`);
}
await browser.close();
writeFileSync(join(args.out, "annotations.json"), JSON.stringify({ annotationQueries, consoleErrors, logFrames }, null, 2));
console.log(`Annotation queries: ${annotationQueries.length}; console errors: ${consoleErrors.length}`);
