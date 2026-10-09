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
import { mkdirSync, readFileSync } from "node:fs";
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
for (const index of args.pages.split(",").map(Number)) {
    const sample = summary.pages.find(p => p.index === index);
    if (!sample) continue;
    await shoot(`/d/lag-monitor-review/lag-monitor-review?var-service_name=${sample.service}&var-instance=${sample.instanceId}`, `page-${index}.png`);
}
await browser.close();
