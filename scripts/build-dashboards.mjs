#!/usr/bin/env node
/**
 * Writes config/grafana/provisioning/dashboards/lag-monitor.json, the Lag
 * Monitor dashboard, from the panel definitions in this file.
 *
 * Query rules:
 * - Native histograms: aggregate first, then take the quantile:
 *   histogram_quantile(0.95, sum(rate(x[$__rate_interval]))).
 * - Counters: rate(), never the raw cumulative value.
 * - Never group by instance or session.
 *
 * Usage: node scripts/build-dashboards.mjs [--list]
 *   --list prints each panel and its queries.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { METRICS, VITAL_THRESHOLDS } from "./lib/lag-catalog.mjs";

const OUTPUT = fileURLToPath(new URL("../config/grafana/provisioning/dashboards/lag-monitor.json", import.meta.url));

const MIMIR = { type : "prometheus", uid : "mimir" };
const LOKI = { type : "loki", uid : "loki" };
const SERVICE = 'service_name=~"$service_name"';
const NAV = 'navigation_type=~"$navigation_type"';

// ---------------------------------------------------------------------------
// PromQL helpers
// ---------------------------------------------------------------------------

function selector(metric, ...matchers) {
    return `${metric}{${[SERVICE, ...matchers].join(", ")}}`;
}

/** The rate of a native histogram, summed: one histogram for the fleet (or for each `by` group). */
function sumRate(metric, { by, matchers = [], range = "$__rate_interval" } = {}) {
    return `sum${by ? ` by (${by})` : ""} (rate(${selector(metric, ...matchers)}[${range}]))`;
}

function quantile(q, metric, options) {
    return `histogram_quantile(${q}, ${sumRate(metric, options)})`;
}

/** Observations per minute of a native histogram. */
function observationsPerMinute(metric, options) {
    return `60 * histogram_count(${sumRate(metric, options)})`;
}

/** A counter as a rate per minute. */
function perMinute(metric, { by, matchers = [] } = {}) {
    return `60 * sum${by ? ` by (${by})` : ""} (rate(${selector(metric, ...matchers)}[$__rate_interval]))`;
}

// ---------------------------------------------------------------------------
// Panel helpers
// ---------------------------------------------------------------------------

const prom = (expr, legendFormat, extra = {}) => ({ datasource : MIMIR, expr, legendFormat, range : true, instant : false, ...extra });
const promInstant = (expr, legendFormat, extra = {}) => ({ datasource : MIMIR, expr, legendFormat, range : false, instant : true, ...extra });
const loki = (expr, legendFormat, extra = {}) => ({ datasource : LOKI, expr, legendFormat, queryType : "range", ...extra });
const lokiInstant = (expr, legendFormat, extra = {}) => ({ datasource : LOKI, expr, legendFormat, queryType : "instant", ...extra });

/** p50, p95 and p99 of one native histogram. */
function quantileTargets(metric, options = {}, quantiles = [0.5, 0.95, 0.99]) {
    const suffix = options.by ? ` {{${options.by}}}` : "";
    return quantiles.map(q => prom(quantile(q, metric, options), `p${Math.round(q * 100)}${suffix}`));
}

function vitalThresholds(name) {
    const { good, poor } = VITAL_THRESHOLDS[name];
    return {
        mode : "absolute",
        steps : [
            { color : "green", value : null },
            { color : "orange", value : good },
            { color : "red", value : poor },
        ],
    };
}

const panels = [];

function row(title) {
    panels.push({ type : "row", title, collapsed : false, panels : [] });
}

function timeseries(title, description, targets, { unit = "ms", w = 12, h = 8, min = 0, max, decimals, stack = false, bars = false, thresholds, overrides = [], legend = "list", interval } = {}) {
    panels.push({
        type : "timeseries",
        title,
        description,
        datasource : targets[0].datasource,
        ...(interval ? { interval } : {}),
        w, h,
        fieldConfig : {
            defaults : {
                unit,
                ...(min === undefined ? {} : { min }),
                ...(max === undefined ? {} : { max }),
                ...(decimals === undefined ? {} : { decimals }),
                color : { mode : "palette-classic" },
                custom : {
                    drawStyle : bars ? "bars" : "line",
                    lineWidth : 1,
                    fillOpacity : bars ? 60 : stack ? 40 : 8,
                    showPoints : "never",
                    spanNulls : false,
                    stacking : { mode : stack ? "normal" : "none", group : "A" },
                    ...(thresholds ? { thresholdsStyle : { mode : "dashed" } } : {}),
                },
                ...(thresholds ? { thresholds } : {}),
            },
            overrides,
        },
        options : {
            legend : { displayMode : legend, placement : "bottom", showLegend : true },
            tooltip : { mode : "multi", sort : "desc" },
        },
        targets,
    });
}

function stat(title, description, targets, { unit = "ms", w = 4, h = 4, thresholds, decimals, calcs = ["lastNotNull"], graph = true } = {}) {
    panels.push({
        type : "stat",
        title,
        description,
        datasource : targets[0].datasource,
        w, h,
        fieldConfig : {
            defaults : {
                unit,
                ...(decimals === undefined ? {} : { decimals }),
                color : { mode : "thresholds" },
                thresholds : thresholds ?? { mode : "absolute", steps : [{ color : "text", value : null }] },
            },
            overrides : [],
        },
        options : {
            reduceOptions : { calcs, fields : "", values : false },
            colorMode : thresholds ? "background" : "value",
            graphMode : graph ? "area" : "none",
            textMode : "auto",
            justifyMode : "auto",
            orientation : "auto",
            showPercentChange : false,
        },
        targets,
    });
}

/** A table of Loki instant metric queries: one row for each label set, one column for each query. */
function metricTable(title, description, targets, { w = 12, h = 8, rename = {}, sortBy, units = {} } = {}) {
    panels.push({
        type : "table",
        title,
        description,
        datasource : targets[0].datasource,
        w, h,
        fieldConfig : {
            defaults : { custom : { align : "auto", cellOptions : { type : "auto" } } },
            overrides : Object.entries(units).map(([name, unit]) => ({
                matcher : { id : "byName", options : name },
                properties : [{ id : "unit", value : unit }, ...(unit === "none" ? [{ id : "decimals", value : 0 }] : [])],
            })),
        },
        options : { showHeader : true, cellHeight : "sm", ...(sortBy ? { sortBy : [{ displayName : sortBy, desc : true }] } : {}) },
        targets,
        transformations : [
            { id : "labelsToFields", options : { mode : "columns" } },
            { id : "merge", options : {} },
            { id : "organize", options : { excludeByName : { Time : true }, renameByName : rename } },
        ],
    });
}

/** A table of recent log lines (events), with the chosen structured-metadata fields as columns. */
function eventTable(title, description, expr, fields, { w = 24, h = 9, rename = {}, units = {} } = {}) {
    panels.push({
        type : "table",
        title,
        description,
        datasource : LOKI,
        w, h,
        fieldConfig : {
            defaults : { custom : { align : "auto", cellOptions : { type : "auto" } } },
            overrides : Object.entries(units).map(([name, unit]) => ({
                matcher : { id : "byName", options : rename[name] ?? name },
                properties : [{ id : "unit", value : unit }],
            })),
        },
        options : { showHeader : true, cellHeight : "sm", sortBy : [{ displayName : "Time", desc : true }] },
        targets : [{ ...loki(expr, ""), maxLines : 200 }],
        transformations : [
            { id : "extractFields", options : { source : "labels", format : "auto", replace : false, keepTime : false } },
            { id : "filterFieldsByName", options : { include : { names : ["Time", ...fields] } } },
            {
                id : "organize",
                options : {
                    indexByName : Object.fromEntries(["Time", ...fields].map((f, i) => [f, i])),
                    renameByName : rename,
                },
            },
        ],
    });
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

const rightAxis = (name, unit, decimals) => ({
    matcher : { id : "byName", options : name },
    properties : [
        { id : "custom.axisPlacement", value : "right" },
        { id : "unit", value : unit },
        ...(decimals === undefined ? [] : [{ id : "decimals", value : decimals }]),
    ],
});

row("Overview");
stat("Active page loads",
    "Page loads (SDK instances) that sent drift samples in the minute before each point. Each page load has its own service.instance.id.",
    [prom(`count(count_over_time(${selector("lag_drift_histogram")}[1m])) or vector(0)`, "page loads")],
    { unit : "none", decimals : 0, calcs : ["last"] });
stat("Drift p95",
    "The 95th percentile of the drift lag of all page loads.",
    [prom(quantile(0.95, "lag_drift_histogram"), "p95")]);
stat("Heartbeat delay p95",
    "The 95th percentile of the worker heartbeat delivery delay: the lag that a random event sees.",
    [prom(quantile(0.95, "lag_worker_main_block_histogram"), "p95")]);
stat("INP p75",
    "Interaction to Next Paint, 75th percentile of the page views in the time range. Good: 200 ms or less. Poor: more than 500 ms.",
    [promInstant(`histogram_quantile(0.75, sum(increase(${selector("lag_web_vital_inp_histogram", NAV)}[$__range])))`, "INP p75")],
    { thresholds : vitalThresholds("inp"), graph : false });
stat("Hangs",
    "Main-thread hangs that the workers detected in the time range.",
    [promInstant(`sum(increase(${selector("lag_main_thread_hangs")}[$__range]))`, "hangs")],
    { unit : "none", decimals : 0, graph : false });
stat("Stalls",
    "Very long samples (hangs and suspends) in the time range.",
    [promInstant(`sum(increase(${selector("lag_stalls")}[$__range]))`, "stalls")],
    { unit : "none", decimals : 0, graph : false });

row("Drift (DriftLag)");
timeseries("Drift lag p50 / p95 / p99",
    "The lag of each window of chained timeouts (about 100 ms): its duration minus the idle duration of its steps. Each main-thread block in the window adds to it.",
    [...quantileTargets("lag_drift_histogram"), prom(`histogram_avg(${sumRate("lag_drift_histogram")})`, "mean")]);
timeseries("Drift baseline: timer granularity",
    "The idle duration of one timer step: the mean of the recent steps that are not blocks. An increase needs a probe that shows an idle thread, thus a sustained load does not change it. It is the timer granularity of the browser and the operating system. DriftLag subtracts it.",
    quantileTargets("lag_drift_baseline_histogram", {}, [0.5, 0.95]), { w : 6 });
timeseries("Drift windows per second",
    "Windows that DriftLag recorded each second, for all page loads. Windows of hidden or frozen pages are discarded.",
    [prom(`histogram_count(${sumRate("lag_drift_histogram")})`, "windows/s")], { unit : "none", w : 6 });

row("Macrotask (MacrotaskLag)");
timeseries("Macrotask queue delay p50 / p95 / p99",
    "The time that a zero-delay timeout waits in the task queue. Each page load measures one sample every 5 seconds.",
    [...quantileTargets("lag_macrotask_histogram"), prom(`histogram_avg(${sumRate("lag_macrotask_histogram")})`, "mean")], { w : 24 });

row("Scheduling fairness (SchedulingFairnessMonitor)");
const primitives = [
    ["lag_scheduling_microtask_histogram", "microtask"],
    ["lag_scheduling_macrotask_histogram", "macrotask (setTimeout 0)"],
    ["lag_scheduling_message_channel_histogram", "MessageChannel"],
];
timeseries("Scheduling latency p50, by primitive",
    "The median latency of each scheduling primitive. The microtask latency stays near 0 and is the baseline.",
    primitives.map(([metric, label]) => prom(quantile(0.5, metric), label)));
timeseries("Scheduling latency p99, by primitive",
    "The 99th percentile latency of each scheduling primitive. A high macrotask or MessageChannel value shows a busy task queue.",
    primitives.map(([metric, label]) => prom(quantile(0.99, metric), label)));

row("Worker heartbeat (WorkerLagMonitor)");
timeseries("Heartbeat delivery delay: the lag that a random event sees",
    "The primary lag estimator. A worker sends a heartbeat each second from its own thread. The delay is the time that the heartbeat waited for the main thread. Heartbeats arrive at random times, as user events do.",
    [...quantileTargets("lag_worker_main_block_histogram"), prom(`histogram_avg(${sumRate("lag_worker_main_block_histogram")})`, "mean")]);
timeseries("Worker self-lag",
    "The lateness of the worker's own heartbeat timer. A high value shows that the worker itself did not run, so its heartbeat delays are not reliable then.",
    quantileTargets("lag_worker_self_lag_histogram"), { w : 6 });
timeseries("Worker clock offset",
    "The absolute offset between the worker clock and the main-thread clock, from the clock synchronization exchange.",
    quantileTargets("lag_worker_clock_offset_histogram"), { w : 6 });

row("Hangs (WorkerLagMonitor)");
timeseries("Hangs per minute, by outcome",
    "Main-thread hangs that the workers detected: the main thread did not acknowledge heartbeats. Abandoned: the page closed or crashed during the hang. The next page of the origin, another open page of the origin, or the page itself at its close reported it (lag.hang.source).",
    [prom(perMinute("lag_main_thread_hangs", { by : "outcome" }), "{{outcome}}")], { unit : "none", bars : true });
timeseries("Hang duration p50 / p95, by outcome",
    "The duration of each hang. For an abandoned hang, the duration until the worker saw the hang for the last time, or until the end of the page.",
    quantileTargets("lag_main_thread_hang_duration_histogram", { by : "outcome" }, [0.5, 0.95]));

row("Measurement conditions (stalls and discarded samples)");
timeseries("Stalls per minute, by kind",
    "Very long samples. A hang has no evidence of a suspend. A suspend overlaps evidence that the system stopped (for example, the device slept).",
    [prom(perMinute("lag_stalls", { by : "kind" }), "{{kind}}")], { unit : "none", w : 8, bars : true });
timeseries("Stall duration p50 / p95, by kind",
    "The duration of each very long sample.",
    quantileTargets("lag_stall_duration_histogram", { by : "kind" }, [0.5, 0.95]), { w : 8 });
timeseries("Samples discarded per minute, by reason",
    "Samples that a monitor did not record, because the page was hidden or frozen, or the system was suspended during the measurement window.",
    [prom(perMinute("lag_samples_discarded", { by : "reason" }), "{{reason}}")], { unit : "none", w : 8, stack : true });

row("Clock (ClockDriftMonitor and ClockReliabilityChecker)");
timeseries("Clock jumps per minute, by kind and direction",
    "Discontinuities between the wall clock and the monotonic clock. Suspend: the monotonic clock stopped while the device slept. Step: the system clock changed.",
    [prom(perMinute("lag_clock_jumps", { by : "kind, direction" }), "{{kind}} {{direction}}")], { unit : "none", w : 8, bars : true });
timeseries("Clock skew p50 / p95 / p99",
    "The absolute difference between Date.now() and the absolute monotonic clock (timeOrigin plus performance.now()).",
    quantileTargets("lag_clock_skew_histogram"), { w : 8 });
stat("performance.now() resolution",
    "The resolution of performance.now() of the page loads in the time range. Each page load measures it one time. Cross-origin isolated pages get 5 µs.",
    [
        promInstant(`histogram_quantile(0.5, sum(increase(${selector("lag_clock_resolution_histogram")}[$__range])))`, "p50"),
        promInstant(`histogram_quantile(0.95, sum(increase(${selector("lag_clock_resolution_histogram")}[$__range])))`, "p95"),
    ],
    { w : 8, h : 8, graph : false, decimals : 3 });

row("Long animation frames (LongAnimationFrameMonitor)");
timeseries("LoAF blocking duration p50 / p95 / p99",
    "The blocking duration of each long animation frame: the time over 50 ms of its long tasks.",
    quantileTargets("lag_loaf_blocking_histogram"), { w : 8 });
timeseries("LoAF duration p50 / p95 / p99",
    "The total duration of each long animation frame.",
    quantileTargets("lag_loaf_duration_histogram"), { w : 8 });
timeseries("Long animation frames per minute",
    "Long animation frames of all page loads, each minute.",
    [prom(observationsPerMinute("lag_loaf_duration_histogram"), "frames/min")], { unit : "none", w : 8 });
const loafEvents = '{service_name=~"$service_name", event_name="lag.long_animation_frame"}';
const scriptLabels = "script_invoker_type, script_invoker, script_source_url";
metricTable("LoAF attribution: blocking time by script (events)",
    "From the lag.long_animation_frame events (frames that block 150 ms or more). The script is the script that blocked the frame most.",
    [
        lokiInstant(`sum by (${scriptLabels}) (sum_over_time(${loafEvents} | keep ${scriptLabels}, blocking_duration_ms | unwrap blocking_duration_ms [$__range]))`, ""),
        lokiInstant(`sum by (${scriptLabels}) (count_over_time(${loafEvents} | keep ${scriptLabels} [$__range]))`, ""),
    ],
    {
        w : 24,
        rename : { "Value #A" : "Blocking time", "Value #B" : "Frames", script_invoker_type : "Invoker type", script_invoker : "Invoker", script_source_url : "Script URL" },
        units : { "Value #A" : "ms", "Value #B" : "none" },
        sortBy : "Blocking time",
    });

row("Event timing (EventTimingMonitor)");
timeseries("Event duration p95, by interaction type",
    "The duration of each interaction event of 16 ms or more, from the input to the next paint.",
    [prom(quantile(0.95, "lag_event_duration_histogram", { by : "interaction" }), "{{interaction}}")], { w : 8 });
timeseries("Event phases p95",
    "Where the time of an interaction goes: the input delay before the handlers, the processing time of the handlers, and the presentation delay to the next paint.",
    [
        prom(quantile(0.95, "lag_event_input_delay_histogram"), "input delay"),
        prom(quantile(0.95, "lag_event_processing_histogram"), "processing"),
        prom(quantile(0.95, "lag_event_presentation_delay_histogram"), "presentation delay"),
    ], { w : 8 });
timeseries("Interactions per minute, by interaction type",
    "Interaction events of 16 ms or more, each minute.",
    [prom(observationsPerMinute("lag_event_duration_histogram", { by : "interaction" }), "{{interaction}}")], { unit : "none", w : 8, stack : true });

row("Layout shift (LayoutShiftMonitor)");
timeseries("Layout shift score p50 / p95 / p99",
    "The score of each layout shift that did not follow user input.",
    quantileTargets("lag_layout_shift_histogram"), { unit : "none", decimals : 3 });
timeseries("Layout shifts per minute",
    "Layout shifts without user input, each minute.",
    [prom(observationsPerMinute("lag_layout_shift_histogram"), "shifts/min")], { unit : "none" });

row("Web Vitals (PageViewVitals)");
const vitals = [
    ["inp", "INP", "lag_web_vital_inp_histogram", "Interaction to Next Paint"],
    ["cls", "CLS", "lag_web_vital_cls_histogram", "Cumulative Layout Shift"],
    ["lcp", "LCP", "lag_web_vital_lcp_histogram", "Largest Contentful Paint"],
    ["fcp", "FCP", "lag_web_vital_fcp_histogram", "First Contentful Paint"],
    ["ttfb", "TTFB", "lag_web_vital_ttfb_histogram", "Time to First Byte"],
];
const thresholdText = (name) => {
    const { good, poor, unit } = VITAL_THRESHOLDS[name];
    const u = unit === "ms" ? " ms" : "";
    return `Good: ${good}${u} or less. Poor: more than ${poor}${u}.`;
};
for (const [name, label, metric, long] of vitals) {
    stat(`${label} p75 (time range)`,
        `${long}, 75th percentile of the page views in the time range, by navigation type. ${thresholdText(name)}`,
        [promInstant(`histogram_quantile(0.75, sum by (navigation_type) (increase(${selector(metric, NAV)}[$__range])))`, "{{navigation_type}}")],
        { unit : name === "cls" ? "none" : "ms", decimals : name === "cls" ? 3 : 0, thresholds : vitalThresholds(name), graph : false, w : 4, h : 6 });
}
stat("Page views (time range)",
    "Page views that reported LCP in the time range: the sample size of the vitals. The count is approximate, because increase() extrapolates.",
    [promInstant(`histogram_count(sum(increase(${selector("lag_web_vital_lcp_histogram", NAV)}[$__range])))`, "page views")],
    { unit : "none", decimals : 0, graph : false, w : 4, h : 6 });
for (const [name, label, metric, long] of vitals) {
    timeseries(`${label} p75, by navigation type`,
        `${long} p75 of the page views that reported in each interval. The histogram gets one value for each page view, usually when the page is hidden for the first time. ${thresholdText(name)} The dashed lines show the thresholds.`,
        [prom(quantile(0.75, metric, { by : "navigation_type", matchers : [NAV] }), "{{navigation_type}}")],
        { unit : name === "cls" ? "none" : "ms", decimals : name === "cls" ? 3 : undefined, thresholds : vitalThresholds(name), w : name === "inp" || name === "cls" ? 12 : 8 });
}
const vitalEvents = '{service_name=~"$service_name", event_name="browser.web_vital"} | browser_web_vital_navigation_type=~"$navigation_type"';
metricTable("Web Vitals p75 from events, by navigation type",
    "From the browser.web_vital events (LogQL unwrap of browser_web_vital_value). A page view sends a new event at each change of a vital, so this p75 includes the earlier values too.",
    [
        lokiInstant(`quantile_over_time(0.75, ${vitalEvents} | keep browser_web_vital_name, browser_web_vital_navigation_type, browser_web_vital_value | unwrap browser_web_vital_value [$__range]) by (browser_web_vital_name, browser_web_vital_navigation_type)`, ""),
        lokiInstant(`sum by (browser_web_vital_name, browser_web_vital_navigation_type) (count_over_time(${vitalEvents} | keep browser_web_vital_name, browser_web_vital_navigation_type [$__range]))`, ""),
    ],
    {
        rename : { "Value #A" : "p75", "Value #B" : "Events", browser_web_vital_name : "Vital", browser_web_vital_navigation_type : "Navigation type" },
        units : { "Value #B" : "none" },
        sortBy : "Events",
    });
timeseries("Web Vitals p75 from events",
    "The p75 of browser_web_vital_value for each vital, from the events in a 5-minute window. CLS uses the right axis.",
    [loki(`quantile_over_time(0.75, ${vitalEvents} | keep browser_web_vital_name, browser_web_vital_value | unwrap browser_web_vital_value [5m]) by (browser_web_vital_name)`, "{{browser_web_vital_name}}")],
    { overrides : [rightAxis("cls", "none", 3)] });

row("Frames (FrameTimingMonitor)");
timeseries("Frames per second, delivered and dropped",
    "Animation frames of all visible page loads, each second. Dropped frames are estimated from long gaps between frames.",
    [prom(`sum by (outcome) (rate(${selector("lag_frames")}[$__rate_interval]))`, "{{outcome}}")], { unit : "none", w : 8, stack : true });
timeseries("Dropped frame ratio",
    "Dropped frames divided by all frames.",
    [prom(`sum(rate(${selector("lag_frames", 'outcome="dropped"')}[$__rate_interval])) / sum(rate(${selector("lag_frames")}[$__rate_interval]))`, "dropped")],
    { unit : "percentunit", w : 8, max : undefined });
timeseries("Frame delta p50 / p95 / p99",
    "The time between two animation frame callbacks. 16.7 ms is 60 frames per second.",
    quantileTargets("lag_frame_delta_histogram"), { w : 8 });

row("Idle time (IdleAvailabilityMonitor)");
timeseries("Idle time remaining p10 / p50 / p90",
    "The idle time that was available when an idle callback ran. Low values show a busy main thread.",
    quantileTargets("lag_idle_time_remaining_histogram", {}, [0.1, 0.5, 0.9]), { w : 6 });
timeseries("Idle gap p50 / p95 / p99",
    "The time between two idle callbacks.",
    quantileTargets("lag_idle_gap_histogram"), { w : 6 });
timeseries("Idle callbacks per minute, by timed_out",
    "Idle callbacks, each minute. A callback that timed out ran because no idle period came in time.",
    [prom(perMinute("lag_idle_callbacks", { by : "timed_out" }), "timed out: {{timed_out}}")], { unit : "none", w : 6, stack : true });
timeseries("Idle callbacks that timed out",
    "Idle callbacks that timed out, divided by all idle callbacks.",
    [prom(`sum(rate(${selector("lag_idle_callbacks", 'timed_out="true"')}[$__rate_interval])) / sum(rate(${selector("lag_idle_callbacks")}[$__rate_interval]))`, "timed out")],
    { unit : "percentunit", w : 6 });

row("Memory (MemoryMonitor)");
timeseries("Used JS heap p50 / p95, by source",
    "The used heap memory of each sample. Modern: performance.measureUserAgentSpecificMemory(). Legacy: performance.memory.",
    quantileTargets("lag_memory_used_bytes_histogram", { by : "source" }, [0.5, 0.95]), { unit : "bytes" });
timeseries("Heap usage ratio p50 / p95",
    "The used heap divided by the heap limit. Only the legacy source supplies the limit.",
    quantileTargets("lag_memory_usage_ratio_histogram", {}, [0.5, 0.95]), { unit : "percentunit" });

row("Compute pressure (ComputePressureMonitor)");
timeseries("Mean pressure state, by source",
    "The mean compute pressure state of the records: 0 nominal, 1 fair, 2 serious, 3 critical.",
    [prom(`histogram_avg(${sumRate("lag_pressure_state_histogram", { by : "source" })})`, "{{source}}")], { unit : "none", max : 3, decimals : 2 });
timeseries("Records at serious or critical pressure, by source",
    "Records with the state serious (2) or critical (3), divided by all records.",
    [prom(`1 - histogram_fraction(-Inf, 1.5, ${sumRate("lag_pressure_state_histogram", { by : "source" })})`, "{{source}}")], { unit : "percentunit" });

row("GC, page lifecycle and timer throttling");
timeseries("GC events per minute",
    "Garbage collections that the GC signal detector saw, each minute, for all page loads.",
    [prom(perMinute("lag_gc_events"), "GC events/min")], { unit : "none", w : 8 });
timeseries("Lifecycle transitions per minute",
    "Page lifecycle transitions, each minute, by the states and the trigger event.",
    [prom(perMinute("lag_lifecycle_transitions", { by : "from, to, trigger" }), "{{from}} → {{to}} ({{trigger}})")], { unit : "none", w : 8, bars : true, legend : "table" });
timeseries("Throttled timer calibrations",
    "Timer calibration rounds that found throttled timers, divided by all rounds. Browsers throttle the timers of hidden pages and of pages in power-saving modes.",
    [prom(`sum(rate(${selector("lag_timer_calibrations", 'throttled="true"')}[$__rate_interval])) / sum(rate(${selector("lag_timer_calibrations")}[$__rate_interval]))`, "throttled")],
    { unit : "percentunit", w : 8 });

row("Browser reports (BrowserReportMonitor)");
timeseries("Browser reports per minute, by type",
    "Reports from the Reporting API: interventions and deprecations.",
    [prom(perMinute("lag_browser_reports", { by : "type" }), "{{type}}")], { unit : "none", bars : true });
eventTable("Recent browser reports (events)",
    "The latest lag.browser_report events.",
    // A Grafana log frame has its own "id" field, so the report id becomes report_id.
    '{service_name=~"$service_name", event_name="lag.browser_report"} | label_format report_id=id',
    ["service_name", "type", "report_id", "message", "source_file", "line_number"],
    { w : 12, h : 8, rename : { service_name : "Service", type : "Type", report_id : "ID", message : "Message", source_file : "Source file", line_number : "Line" } });

row("Shared-memory liveness (SharedLivenessMonitor)");
timeseries("Liveness block duration p50 / p95 / p99",
    "The duration of each main-thread block that a worker saw through shared memory. Only cross-origin isolated pages have this monitor.",
    quantileTargets("lag_liveness_block_histogram"));
timeseries("Liveness blocks per minute",
    "Main-thread blocks that the shared-memory watcher saw, each minute.",
    [prom(observationsPerMinute("lag_liveness_block_histogram"), "blocks/min")], { unit : "none" });

row("Events (Loki)");
timeseries("Events per minute, by event name",
    "Lag events in Loki in the minute before each point. event_name is an index label.",
    [loki('sum by (event_name) (count_over_time({service_name=~"$service_name", event_name=~".+"} [1m]))', "{{event_name}}")], { unit : "none", w : 24, h : 7, interval : "15s" });
eventTable("Recent hangs and stalls",
    "The latest lag.main_thread.hang and lag.stall events. The worker sends the hang start itself (scope @lag/worker), because the main thread cannot. An abandoned hang comes from the next page of the origin (lag.hang.source journal), another open page (peer), or the page itself at its close (self).",
    '{service_name=~"$service_name", event_name=~"lag.main_thread.hang|lag.stall"}',
    ["service_name", "event_name", "phase", "kind", "duration_ms", "scope_name", "lag_page_view_id", "lag_hang_page_id", "session_id", "service_instance_id"],
    {
        h : 10,
        rename : {
            service_name : "Service", event_name : "Event", phase : "Phase", kind : "Kind", duration_ms : "Duration",
            scope_name : "Sender", lag_page_view_id : "Page view", lag_hang_page_id : "Hung page", session_id : "Session", service_instance_id : "Instance",
        },
        units : { duration_ms : "ms" },
    });
eventTable("Recent clock jumps",
    "The latest lag.clock.jump events, with the size of the jump.",
    '{service_name=~"$service_name", event_name="lag.clock.jump"}',
    ["service_name", "kind", "direction", "magnitude_ms", "skew_ms", "lateness_ms", "lag_page_view_id", "session_id"],
    {
        h : 7,
        rename : { service_name : "Service", kind : "Kind", direction : "Direction", magnitude_ms : "Magnitude", skew_ms : "Skew", lateness_ms : "Lateness", lag_page_view_id : "Page view", session_id : "Session" },
        units : { magnitude_ms : "ms", skew_ms : "ms", lateness_ms : "ms" },
    });

row("Long range (recording rules)");
const recorded = [
    ["lag_drift_histogram", "drift"],
    ["lag_macrotask_histogram", "macrotask"],
    ["lag_worker_main_block_histogram", "heartbeat delay"],
    ["lag_loaf_blocking_histogram", "LoAF blocking"],
    ["lag_event_duration_histogram", "event duration"],
    ["lag_frame_delta_histogram", "frame delta"],
];
timeseries("p95 by service (recorded)",
    "From the recording rules service_name:<metric>:p95_rate5m (5-minute windows, evaluated each minute). Use these panels for long time ranges.",
    recorded.map(([metric, label]) => prom(`service_name:${metric}:p95_rate5m{${SERVICE}}`, `{{service_name}} ${label}`)), { legend : "table" });
timeseries("p99 by service (recorded)",
    "From the recording rules service_name:<metric>:p99_rate5m.",
    recorded.map(([metric, label]) => prom(`service_name:${metric}:p99_rate5m{${SERVICE}}`, `{{service_name}} ${label}`)), { legend : "table" });
timeseries("Fleet p95 from recorded rates",
    "The p95 of all selected services, from the recorded native-histogram rates service_name:<metric>:rate5m. A sum of recorded rates is correct; a sum of recorded quantiles is not.",
    recorded.map(([metric, label]) => prom(`histogram_quantile(0.95, sum(service_name:${metric}:rate5m{${SERVICE}}))`, label)));
timeseries("Web Vitals p75 from recorded rates",
    "The p75 of each vital, from the recorded rates service_name_navigation_type:<metric>:rate5m. CLS uses the right axis.",
    vitals.map(([name, label, metric]) => prom(`histogram_quantile(0.75, sum(service_name_navigation_type:${metric}:rate5m{${SERVICE}, ${NAV}}))`, label)),
    { overrides : [rightAxis("CLS", "none", 3)] });

// ---------------------------------------------------------------------------
// Layout and output
// ---------------------------------------------------------------------------

let id = 1;
let x = 0;
let y = 0;
let rowHeight = 0;
const laidOut = [];
for (const panel of panels) {
    const { w = 24, h = 1, ...rest } = panel;
    if (panel.type === "row") {
        if (x > 0) y += rowHeight;
        laidOut.push({ ...rest, id : id++, gridPos : { h : 1, w : 24, x : 0, y } });
        y += 1;
        x = 0;
        rowHeight = 0;
        continue;
    }
    if (x + w > 24) {
        y += rowHeight;
        x = 0;
        rowHeight = 0;
    }
    const targets = rest.targets.map((t, i) => ({ refId : String.fromCharCode(65 + i), ...t }));
    laidOut.push({ ...rest, targets, id : id++, gridPos : { h, w, x, y } });
    x += w;
    rowHeight = Math.max(rowHeight, h);
}

const dashboard = {
    uid : "lag-monitor",
    title : "Lag Monitor",
    description : "Main-thread lag of browser pages, from the lag library: native-histogram metrics in Mimir and events in Loki.",
    tags : ["lag", "performance", "otel", "browser"],
    editable : true,
    graphTooltip : 1,
    schemaVersion : 41,
    version : 1,
    time : { from : "now-1h", to : "now" },
    refresh : "30s",
    timepicker : {},
    timezone : "browser",
    fiscalYearStartMonth : 0,
    liveNow : false,
    links : [],
    annotations : {
        list : [{
            builtIn : 1,
            datasource : { type : "grafana", uid : "-- Grafana --" },
            enable : true,
            hide : true,
            iconColor : "rgba(0, 211, 255, 1)",
            name : "Annotations & Alerts",
            type : "dashboard",
        }],
    },
    templating : {
        list : [
            {
                name : "service_name",
                label : "Service",
                description : "The service.name resource attribute. Mimir promotes it to the service_name label. Loki indexes it.",
                type : "query",
                datasource : MIMIR,
                definition : "label_values(lag_drift_histogram, service_name)",
                query : { qryType : 1, query : "label_values(lag_drift_histogram, service_name)", refId : "PrometheusVariableQueryEditor-VariableQuery" },
                refresh : 2,
                includeAll : true,
                multi : true,
                allValue : ".+",
                current : { selected : true, text : ["All"], value : ["$__all"] },
                sort : 1,
                regex : "",
                options : [],
                hide : 0,
            },
            {
                name : "navigation_type",
                label : "Navigation type",
                description : "How the page view started. Used by the Web Vitals panels.",
                type : "query",
                datasource : MIMIR,
                definition : 'label_values(lag_web_vital_lcp_histogram{service_name=~"$service_name"}, navigation_type)',
                query : { qryType : 1, query : 'label_values(lag_web_vital_lcp_histogram{service_name=~"$service_name"}, navigation_type)', refId : "PrometheusVariableQueryEditor-VariableQuery" },
                refresh : 2,
                includeAll : true,
                multi : true,
                allValue : ".+",
                current : { selected : true, text : ["All"], value : ["$__all"] },
                sort : 1,
                regex : "",
                options : [],
                hide : 0,
            },
        ],
    },
    panels : laidOut,
};

// Every catalog metric must appear in at least one query.
const allExpressions = laidOut.flatMap(p => (p.targets ?? []).map(t => t.expr)).join("\n");
const missing = METRICS.filter(m => !new RegExp(`\\b${m.name}\\b`).test(allExpressions)).map(m => m.name);
if (missing.length > 0) {
    console.error(`Metrics without a panel: ${missing.join(", ")}`);
    process.exit(1);
}

writeFileSync(OUTPUT, `${JSON.stringify(dashboard, null, 2)}\n`);
const panelCount = laidOut.filter(p => p.type !== "row").length;
console.log(`Wrote ${OUTPUT}: ${panelCount} panels in ${laidOut.length - panelCount} rows; all ${METRICS.length} catalog metrics have a panel.`);

if (process.argv.includes("--list")) {
    let currentRow = "";
    for (const panel of laidOut) {
        if (panel.type === "row") {
            currentRow = panel.title;
            console.log(`\n## ${currentRow}`);
            continue;
        }
        console.log(`- ${panel.title} [${panel.type}]`);
        for (const t of panel.targets) console.log(`    ${t.refId}: ${t.expr}`);
    }
}
