#!/usr/bin/env node
/**
 * Sends sample lag telemetry to the stack in the same form as browsers:
 *
 * - The OpenTelemetry JS SDK exports OTLP/HTTP JSON to Alloy.
 * - Metrics have cumulative temporality and exponential histograms.
 * - Each simulated page load is one SDK instance (a MeterProvider and a
 *   LoggerProvider) with its own random service.instance.id.
 * - Every metric of the lag catalog gets realistic values with permitted
 *   attribute values only.
 * - The lag events are log records with an event name. Each one has
 *   lag.page_view.id and session.id attributes, as otel-ts sends them.
 * - The worker sends hang reports in the exact JSON shape of the library's
 *   encodeOtlpLogs, with fetch(..., { keepalive: true }) and a page Origin.
 *
 * Usage:
 *   node scripts/send-sample-data.mjs [--endpoint http://localhost:4318]
 *     [--duration 180] [--interval 15] [--pages 6] [--seed 1]
 *     [--summary sample-summary.json]
 *
 * --duration is the run time in seconds. --interval is the metric export
 * interval in seconds. --summary writes the instance IDs and counts to a
 * file for `scripts/verify-pipeline.mjs --summary`.
 */

import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { AggregationType, InstrumentType, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { AggregationTemporalityPreference, OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { M, METRICS, VITAL_THRESHOLDS } from "./lib/lag-catalog.mjs";

const { values : args } = parseArgs({
    options : {
        endpoint : { type : "string", default : "http://localhost:4318" },
        duration : { type : "string", default : "180" },
        interval : { type : "string", default : "15" },
        pages : { type : "string", default : "6" },
        seed : { type : "string", default : "1" },
        summary : { type : "string" },
    },
});

const ENDPOINT = args.endpoint.replace(/\/$/, "");
const DURATION_S = Number(args.duration);
const EXPORT_INTERVAL_MS = Number(args.interval) * 1000;
/** The origin of a page on a dev server. The worker reports send it, as a browser does. */
const PAGE_ORIGIN = "http://localhost:5173";

// ---------------------------------------------------------------------------
// Random numbers (seeded, so that runs are reproducible)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rnd = mulberry32(Number(args.seed));
const uniform = (a, b) => a + (b - a) * rnd();
const chance = (p) => rnd() < p;
const pick = (values) => values[Math.floor(rnd() * values.length)];
function gauss() {
    const u = 1 - rnd();
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** A log-normal value with this median. A larger sigma gives a longer tail. */
const lognormal = (median, sigma) => median * Math.exp(sigma * gauss());
/** Rounds to a multiple of `step`, without binary-fraction noise for steps below 1. */
const round = (value, step) => step >= 1 ? Math.round(value / step) * step : Math.round(value / step) / Math.round(1 / step);

// ---------------------------------------------------------------------------
// The worker path: the exact JSON shape of encodeOtlpLogs (lag otlp-json.ts)
// ---------------------------------------------------------------------------

function encodeValue(value) {
    if (typeof value === "string") return { stringValue : value };
    if (typeof value === "boolean") return { boolValue : value };
    return Number.isInteger(value) ? { intValue : String(value) } : { doubleValue : value };
}

function encodeAttributes(attributes) {
    return Object.entries(attributes).map(([key, value]) => ({ key, value : encodeValue(value) }));
}

function millisToUnixNanoString(timeMs) {
    const wholeMs = Math.floor(timeMs);
    const micros = Math.round((timeMs - wholeMs) * 1_000);
    return (BigInt(wholeMs) * 1_000_000n + BigInt(micros) * 1_000n).toString();
}

function encodeOtlpLogs(resource, scopeName, records) {
    return JSON.stringify({
        resourceLogs : [{
            resource : { attributes : encodeAttributes(resource) },
            scopeLogs : [{
                scope : { name : scopeName },
                logRecords : records.map(r => ({
                    timeUnixNano : millisToUnixNanoString(r.timeMs),
                    observedTimeUnixNano : millisToUnixNanoString(r.timeMs),
                    eventName : r.eventName,
                    severityNumber : r.severityNumber,
                    severityText : r.severityText,
                    body : { stringValue : r.body },
                    attributes : encodeAttributes(r.attributes),
                })),
            }],
        }],
    });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const SCRIPTS = [
    { invoker : "IMG#hero.onload", invokerType : "event-listener", url : "https://shop.example/assets/app.js" },
    { invoker : "TimerHandler:setTimeout", invokerType : "user-callback", url : "https://cdn.example/analytics.js" },
    { invoker : "Response.json.then", invokerType : "resolve-promise", url : "https://shop.example/assets/vendor.js" },
    { invoker : "https://shop.example/assets/app.js", invokerType : "classic-script", url : "https://shop.example/assets/app.js" },
    { invoker : "BUTTON#buy.onclick", invokerType : "event-listener", url : "https://shop.example/assets/checkout.js" },
];

const PRESSURE_STATES = ["nominal", "fair", "serious", "critical"];
const ALL_FEATURES = ["loaf", "eventTiming", "memory", "pressure", "liveness", "idle"];

/**
 * One profile for each simulated page load. The profiles together use every
 * navigation type and every attribute value that a real browser produces.
 */
const PROFILES = [
    {
        service : "lag-sample-shop", version : "1.5.0", platform : "Windows", mobile : false,
        navigation : "navigate", startS : 0, lifeS : Infinity, timerMs : 1.0, resolutionMs : 0.005,
        memorySource : "modern", features : ALL_FEATURES,
        hidden : [40, 55], bfcache : [80, 90], clockJump : { atS : 100, direction : "forward", kind : "suspend", magnitudeMs : 45_000 },
        report : { atS : 12, type : "intervention" },
    },
    {
        service : "lag-sample-shop", version : "1.5.0", platform : "macOS", mobile : false,
        navigation : "reload", startS : 6, lifeS : Infinity, timerMs : 1.0, resolutionMs : 0.1,
        memorySource : "modern", features : ["loaf", "eventTiming", "memory", "pressure", "idle"],
        softNavigationAtS : 70, hang : { atS : 48, durationMs : 7_200 },
        clockJump : { atS : 35, direction : "backward", kind : "step", magnitudeMs : 1_200 },
        blur : [20, 26],
    },
    {
        service : "lag-sample-shop", version : "1.4.2", platform : "Android", mobile : true,
        navigation : "back-forward", startS : 12, lifeS : Infinity, timerMs : 4.0, resolutionMs : 0.1,
        memorySource : "modern", features : ["loaf", "eventTiming", "memory", "pressure", "idle"], thermals : true,
        frozen : [58, 60, 70, 72], abandonedHang : { durationMs : 12_400 },
        clockJump : { atS : 45, direction : "forward", kind : "step", magnitudeMs : 850 },
        report : { atS : 14, type : "deprecation" },
    },
    {
        // Leaves after 20 s: fewer than two export intervals.
        service : "lag-sample-shop", version : "1.5.0", platform : "Windows", mobile : false,
        navigation : "navigate", startS : 18, lifeS : 20, timerMs : 15.6, resolutionMs : 0.1,
        memorySource : "modern", features : ["loaf", "eventTiming", "memory", "pressure", "idle"],
    },
    {
        service : "lag-sample-docs", version : "0.9.0", platform : "Linux", mobile : false,
        navigation : "prerender", startS : 3, lifeS : Infinity, timerMs : 1.0, resolutionMs : 1,
        memorySource : "legacy", features : ["eventTiming", "memory", "idle"],
        blur : [20, 25], report : { atS : 20, type : "deprecation" },
    },
    {
        // Safari: no LoAF, Event Timing, memory, Compute Pressure or idle callbacks.
        service : "lag-sample-docs", version : "0.9.0", platform : "iOS", mobile : true,
        navigation : "restore", startS : 24, lifeS : Infinity, timerMs : 1.0, resolutionMs : 1,
        memorySource : undefined, features : [], hidden : [60, 64],
    },
];

const counts = { metrics : {}, attributeSets : {}, events : {}, appLogs : 0 };
const workerReports = [];

function checkAttributes(definition, attributes) {
    const keys = Object.keys(definition.attributes);
    for (const key of keys) {
        if (!(key in attributes)) throw new Error(`${definition.name}: attribute ${key} is missing`);
        if (!definition.attributes[key].includes(attributes[key])) {
            throw new Error(`${definition.name}: ${key}="${attributes[key]}" is not a permitted value`);
        }
    }
    for (const key of Object.keys(attributes)) {
        if (!keys.includes(key)) throw new Error(`${definition.name}: attribute ${key} is not in the catalog`);
    }
}

class Page {
    constructor(profile, index) {
        this.profile = profile;
        this.index = index;
        this.instanceId = randomUUID();
        this.workerInstanceId = randomUUID();
        this.sessionId = randomUUID();
        this.t = 0;
        this.state = "active";
        this.blocked = false;
        this.views = [];
        this.newView(profile.navigation);

        const resource = resourceFromAttributes({
            "service.name" : profile.service,
            "service.version" : profile.version,
            "service.instance.id" : this.instanceId,
            "deployment.environment.name" : "development",
            "browser.platform" : profile.platform,
            "browser.mobile" : profile.mobile,
        });

        // As otel-ts with histogramAggregation: "exponential": the exporter's
        // aggregation preference, not a View.
        const exporter = new OTLPMetricExporter({
            url : `${ENDPOINT}/v1/metrics`,
            temporalityPreference : AggregationTemporalityPreference.CUMULATIVE,
            aggregationPreference : (type) => type === InstrumentType.HISTOGRAM
                ? { type : AggregationType.EXPONENTIAL_HISTOGRAM }
                : { type : AggregationType.DEFAULT },
        });
        this.meterProvider = new MeterProvider({
            resource,
            readers : [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis : EXPORT_INTERVAL_MS })],
        });
        const meter = this.meterProvider.getMeter("@lag/core");
        this.instruments = {};
        for (const definition of METRICS) {
            const options = { unit : definition.unit };
            this.instruments[definition.key] = definition.kind === "histogram"
                ? meter.createHistogram(definition.name, options)
                : meter.createCounter(definition.name, options);
        }

        this.loggerProvider = new LoggerProvider({
            resource,
            // sdk-logs 0.223 takes an options object (0.213 took the exporter as the first argument).
            processors : [new BatchLogRecordProcessor({ exporter : new OTLPLogExporter({ url : `${ENDPOINT}/v1/logs` }), scheduledDelayMillis : 1000 })],
        });
        this.logger = this.loggerProvider.getLogger("@lag/core");
    }

    has(feature) {
        return this.profile.features.includes(feature);
    }

    get view() {
        return this.views[this.views.length - 1];
    }

    newView(navigationType) {
        const host = this.profile.service === "lag-sample-docs" ? "docs.example" : "shop.example";
        const path = navigationType === "soft-navigation" ? "/cart" : `/products/${10 + this.index}`;
        const previous = this.views.length > 0 ? this.view : undefined;
        this.views.push({
            id : randomUUID(),
            navigationType,
            url : `https://${host}${path}`,
            startT : this.t,
            inp : 0,
            cls : 0,
            reported : false,
            last : {},
        });
        // As the library: one event at the start of each page view
        this.emit("lag.page_view.start", {
            navigation_type : navigationType,
            "lag.page_view.url" : this.view.url,
            ...(previous ? { "lag.page_view.previous_id" : previous.id } : {}),
        });
    }

    record(key, value, attributes = {}) {
        const definition = M[key];
        checkAttributes(definition, attributes);
        if (definition.kind === "histogram") this.instruments[key].record(value, attributes);
        else this.instruments[key].add(value, attributes);
        counts.metrics[definition.name] = (counts.metrics[definition.name] ?? 0) + 1;
        const set = `${definition.name}${JSON.stringify(attributes)}`;
        counts.attributeSets[set] = (counts.attributeSets[set] ?? 0) + 1;
    }

    /**
     * As createOtelEventSink: eventName, severity INFO, no body, and the time
     * of the occurrence as the time of the record (`timeMs`, the start of an
     * event with a duration). Without it, the record gets the time of the call.
     */
    emit(name, attributes, timeMs) {
        this.logger.emit({
            eventName : name,
            severityText : "INFO",
            severityNumber : 9,
            attributes : { ...attributes, "lag.page_view.id" : this.view.id, "session.id" : this.sessionId },
            ...(timeMs === undefined ? {} : { timestamp : timeMs }),
        });
        counts.events[name] = (counts.events[name] ?? 0) + 1;
    }

    /** As createOtelLoggerAdapter: a plain log record without an event name. */
    log(level, severityNumber, message, attributes) {
        this.logger.emit({ severityText : level, severityNumber, body : message, attributes : { ...attributes, "session.id" : this.sessionId } });
        counts.appLogs++;
    }

    transition(to, trigger) {
        this.record("lifecycleTransitions", 1, { from : this.state, to, trigger });
        this.emit("lag.lifecycle.transition", { from : this.state, to, trigger });
        this.state = to;
    }

    /** One pressure record: the histogram, and an event when the state of the source changes, as the library. */
    pressure(source, ordinal) {
        this.record("pressureState", ordinal, { source });
        const state = PRESSURE_STATES[ordinal];
        this.pressureStates ??= {};
        const previous = this.pressureStates[source];
        if (previous === state) return;
        this.pressureStates[source] = state;
        this.emit("lag.pressure.change", { source, state, ...(previous ? { previous_state : previous } : {}) });
    }

    async flush() {
        await Promise.allSettled([this.meterProvider.forceFlush(), this.loggerProvider.forceFlush()]);
    }

    /** The worker's own hang report: OTLP/HTTP JSON straight to /v1/logs. */
    async postWorkerHangReport(phase, durationMs) {
        const body = encodeOtlpLogs(
            { "service.name" : this.profile.service, "service.version" : this.profile.version, "service.instance.id" : this.workerInstanceId },
            "@lag/worker",
            [{
                timeMs : Date.now(),
                eventName : "lag.main_thread.hang",
                severityText : "WARN",
                severityNumber : 13,
                body : `Main thread hang ${phase}`,
                attributes : { "lag.page_view.id" : this.view.id, phase, duration_ms : durationMs },
            }],
        );
        const result = { phase, pageViewId : this.view.id, workerInstanceId : this.workerInstanceId };
        try {
            const response = await fetch(`${ENDPOINT}/v1/logs`, {
                method : "POST",
                headers : { "Content-Type" : "application/json", Origin : PAGE_ORIGIN },
                body,
                keepalive : true,
            });
            result.status = response.status;
            result.allowOrigin = response.headers.get("access-control-allow-origin");
            result.response = await response.text();
        } catch (error) {
            result.error = String(error);
        }
        workerReports.push(result);
        counts.events["lag.main_thread.hang"] = (counts.events["lag.main_thread.hang"] ?? 0) + 1;
    }

    // -----------------------------------------------------------------------
    // Vitals: the histogram gets the value at the first report of a page
    // view; each change also sends a browser.web_vital event.
    // -----------------------------------------------------------------------

    vitalValues(view) {
        const p = this.profile;
        const restored = view.navigationType === "back-forward-cache" || view.navigationType === "soft-navigation";
        const values = {};
        if (!view.ttfb && !restored) view.ttfb = p.navigation === "prerender" ? 0 : lognormal(p.mobile ? 520 : 260, 0.6);
        if (!view.fcp) view.fcp = restored ? lognormal(90, 0.4) : (view.ttfb ?? 0) + lognormal(p.mobile ? 1_100 : 650, 0.5);
        if (!view.lcp) view.lcp = view.fcp + lognormal(restored ? 60 : 550, 0.7);
        if (!restored) values.ttfb = view.ttfb;
        values.fcp = view.fcp;
        values.lcp = view.lcp;
        values.cls = view.cls;
        if (this.has("eventTiming") && view.inp > 0) values.inp = view.inp;
        return values;
    }

    reportVitals(view) {
        const values = this.vitalValues(view);
        for (const [name, value] of Object.entries(values)) {
            const last = view.last[name];
            if (last === undefined) {
                // As the library: the histogram gets the first reported value of each vital of a view.
                const key = { inp : "vitalInp", cls : "vitalCls", lcp : "vitalLcp", fcp : "vitalFcp", ttfb : "vitalTtfb" }[name];
                this.record(key, value, { navigation_type : view.navigationType });
            }
            if (last === value) continue;
            const { good, poor } = VITAL_THRESHOLDS[name];
            const attribution = name === "lcp"
                ? { "lag.web_vital.target" : "main > img.hero", "lag.web_vital.url" : "https://shop.example/img/hero.avif" }
                : name === "cls" ? { "lag.web_vital.target" : "div.banner" }
                    : name === "inp" ? { "lag.web_vital.target" : "button#buy" } : {};
            this.logger.emit({
                eventName : "browser.web_vital",
                severityText : "INFO",
                severityNumber : 9,
                attributes : {
                    "browser.web_vital.name" : name,
                    "browser.web_vital.value" : value,
                    "browser.web_vital.delta" : value - (last ?? 0),
                    "browser.web_vital.id" : `${view.id}-${name}`,
                    "browser.web_vital.rating" : value <= good ? "good" : value <= poor ? "needs-improvement" : "poor",
                    "browser.web_vital.navigation_type" : view.navigationType,
                    "lag.page_view.id" : view.id,
                    "lag.page_view.url" : view.url,
                    "session.id" : this.sessionId,
                    ...attribution,
                },
            });
            counts.events["browser.web_vital"] = (counts.events["browser.web_vital"] ?? 0) + 1;
            view.last[name] = value;
        }
        view.reported = true;
    }

    // -----------------------------------------------------------------------
    // One second of page life
    // -----------------------------------------------------------------------

    async tick() {
        const p = this.profile;
        const t = this.t;

        if (t === 0) {
            this.log("info", 9, "Lag monitors started", { type : "setupAllMonitors" });
            this.record("clockResolution", p.resolutionMs);
            if (p.abandonedHang) {
                // The journal of an earlier page of the origin: that page did not survive its hang.
                const durationMs = p.abandonedHang.durationMs;
                this.record("hangs", 1, { outcome : "abandoned" });
                this.record("hangDuration", durationMs, { outcome : "abandoned" });
                this.emit("lag.main_thread.hang", { phase : "abandoned", duration_ms : durationMs, "lag.hang.page_id" : randomUUID() });
            }
        }

        await this.lifecycleEvents(t);

        if (this.state === "frozen") {
            this.t++;
            return;
        }
        if (p.hang && t >= p.hang.atS && t < p.hang.atS + Math.ceil(p.hang.durationMs / 1000)) {
            await this.hang(t);
            this.t++;
            return;
        }

        const visible = this.state === "active" || this.state === "passive";
        if (visible) this.foregroundMonitors(t);
        else this.record("samplesDiscarded", 10, { reason : "hidden" });

        this.backgroundMonitors(t, visible);
        this.t++;
    }

    async lifecycleEvents(t) {
        const p = this.profile;
        if (p.blur && t === p.blur[0]) this.transition("passive", "blur");
        if (p.blur && t === p.blur[1]) this.transition("active", "focus");

        if (p.hidden && t === p.hidden[0]) {
            this.transition("hidden", "visibilitychange");
            if (!this.view.reported) this.reportVitals(this.view);
            await this.flush(); // otel-ts flushes on every page hide
        }
        if (p.hidden && t === p.hidden[1]) {
            this.transition("active", "visibilitychange");
            this.view.inp = Math.max(this.view.inp, lognormal(260, 0.4)); // a slow interaction after the return
            this.reportVitals(this.view); // a change: an event only
        }

        if (p.frozen) {
            const [hideAt, freezeAt, resumeAt, showAt] = p.frozen;
            if (t === hideAt) {
                this.transition("hidden", "visibilitychange");
                if (!this.view.reported) this.reportVitals(this.view);
                await this.flush();
            }
            if (t === freezeAt) this.transition("frozen", "freeze");
            if (t === resumeAt) {
                this.transition("hidden", "resume");
                this.record("samplesDiscarded", 1, { reason : "frozen" });
            }
            if (t === showAt) this.transition("active", "visibilitychange");
        }

        if (p.bfcache && t === p.bfcache[0]) {
            this.reportVitals(this.view);
            this.transition("frozen", "pagehide");
            await this.flush();
        }
        if (p.bfcache && t === p.bfcache[1]) {
            this.transition("active", "pageshow");
            this.newView("back-forward-cache");
        }

        if (p.softNavigationAtS !== undefined && t === p.softNavigationAtS) {
            this.reportVitals(this.view);
            this.newView("soft-navigation");
        }

        if (p.report && t === p.report.atS) {
            const report = p.report.type === "intervention"
                ? { id : "HeavyAdIntervention", message : "Ad was removed because its CPU usage exceeded the limit.", source_file : "https://ads.example/ad.js", line_number : 118 }
                : { id : "UnloadHandler", message : "Unload event listeners are deprecated and will be removed.", source_file : "https://shop.example/assets/legacy.js", line_number : 42 };
            this.record("browserReports", 1, { type : p.report.type });
            this.emit("lag.browser_report", { type : p.report.type, ...report });
        }

        if (p.clockJump && t === p.clockJump.atS) {
            const { direction, kind, magnitudeMs } = p.clockJump;
            this.record("clockJumps", 1, { direction, kind });
            this.emit("lag.clock.jump", {
                direction, kind, magnitude_ms : magnitudeMs,
                skew_ms : round(uniform(0.5, 3), 0.001), lateness_ms : kind === "suspend" ? magnitudeMs : round(uniform(0, 4), 0.001),
            });
            if (kind === "suspend") {
                this.record("stalls", 1, { kind : "suspend" });
                this.record("stallDuration", magnitudeMs, { kind : "suspend" });
                this.record("samplesDiscarded", 1, { reason : "suspend" });
                this.emit("lag.stall", { kind : "suspend", duration_ms : magnitudeMs });
            }
        }
    }

    /** A main-thread hang: the page runs nothing; only the worker reports. */
    async hang(t) {
        const { atS, durationMs } = this.profile.hang;
        if (t === atS + 5) await this.postWorkerHangReport("started", 5_000); // the 5 s hang threshold
        if (t === atS + Math.ceil(durationMs / 1000) - 1) {
            await this.postWorkerHangReport("ended", durationMs);
            // The main thread runs again: the queued heartbeats arrive late.
            for (let waited = durationMs; waited > 0; waited -= 1000) this.record("workerMainBlock", waited);
            this.record("hangs", 1, { outcome : "ended" });
            this.record("hangDuration", durationMs, { outcome : "ended" });
            this.record("stalls", 1, { kind : "hang" });
            this.record("stallDuration", durationMs, { kind : "hang" });
            // The time of each event is the start of the hang
            const startedAt = Date.now() - durationMs;
            this.emit("lag.main_thread.hang", { phase : "ended", duration_ms : durationMs }, startedAt);
            this.emit("lag.stall", { kind : "hang", duration_ms : durationMs }, startedAt);
        }
    }

    foregroundMonitors(t) {
        const p = this.profile;
        const view = this.view;

        // DriftLag: ten windows of about 100 ms each second, and the baseline.
        for (let i = 0; i < 10; i++) {
            const block = chance(0.02) ? lognormal(60, 0.8) : 0;
            this.record("drift", lognormal(0.6, 0.9) + block);
        }
        this.record("driftBaseline", p.timerMs * (1 + Math.abs(gauss()) * 0.05));

        // MacrotaskLag: one sample every 5 s.
        if (t % 5 === 0) this.record("macrotask", lognormal(0.35, 0.8) + (chance(0.08) ? lognormal(40, 0.7) : 0));

        // SchedulingFairnessMonitor: every 2 s.
        if (t % 2 === 0) {
            this.record("schedulingMicrotask", chance(0.6) ? 0 : uniform(0.001, 0.05));
            this.record("schedulingMacrotask", lognormal(0.3, 0.8) + (chance(0.05) ? lognormal(25, 0.6) : 0));
            this.record("schedulingMessageChannel", lognormal(0.08, 0.8) + (chance(0.05) ? lognormal(20, 0.6) : 0));
        }

        // FrameTimingMonitor: about 60 frames each second.
        const dropped = chance(0.25) ? Math.floor(uniform(1, 9)) : 0;
        for (let i = 0; i < 60 - dropped; i++) this.record("frameDelta", 16.67 + gauss() * 0.4);
        if (dropped > 0) this.record("frameDelta", 16.67 * (dropped + 1));
        this.record("frames", 60 - dropped, { outcome : "delivered" });
        if (dropped > 0) this.record("frames", dropped, { outcome : "dropped" });

        // LongAnimationFrameMonitor
        if (this.has("loaf") && (chance(0.4) || t === 3)) {
            const duration = t === 3 ? 260 : 50 + lognormal(45, 0.8);
            const blocking = t === 3 ? 190 : Math.max(0, duration - 50 - uniform(0, 30));
            this.record("loafDuration", duration);
            this.record("loafBlocking", blocking);
            if (blocking >= 150) {
                const script = pick(SCRIPTS);
                this.emit("lag.long_animation_frame", {
                    duration_ms : round(duration, 0.1), blocking_duration_ms : round(blocking, 0.1),
                    "script.invoker" : script.invoker, "script.invoker_type" : script.invokerType,
                    "script.source_url" : script.url, "script.duration_ms" : round(blocking * 0.8 + 40, 0.1),
                });
            }
        }

        // EventTimingMonitor: an interaction about every 3 s.
        if (this.has("eventTiming") && (t % 3 === 0) && chance(0.8)) {
            const interaction = rnd() < 0.6 ? "pointer" : rnd() < 0.75 ? "keyboard" : "other";
            const inputDelay = lognormal(3, 1.0);
            const processing = lognormal(interaction === "keyboard" ? 8 : 14, 0.9);
            const presentation = lognormal(10, 0.6);
            const duration = Math.max(16, round(inputDelay + processing + presentation, 8));
            this.record("eventDuration", duration, { interaction });
            this.record("eventInputDelay", inputDelay, { interaction });
            this.record("eventProcessing", processing, { interaction });
            this.record("eventPresentationDelay", presentation, { interaction });
            view.inp = Math.max(view.inp, duration);
        }

        // LayoutShiftMonitor: shifts without user input.
        if (chance(0.08)) {
            const score = Math.min(0.3, lognormal(0.01, 1.1));
            this.record("layoutShift", score);
            view.cls = round(view.cls + score, 0.0001);
        }

        // IdleAvailabilityMonitor: about five idle callbacks each second.
        if (this.has("idle")) {
            for (let i = 0; i < 5; i++) {
                const timedOut = chance(0.05);
                this.record("idleTimeRemaining", timedOut ? 0 : uniform(0.5, 49.9));
                this.record("idleGap", lognormal(45, 0.9));
                this.record("idleCallbacks", 1, { timed_out : timedOut ? "true" : "false" });
            }
        }

        // WorkerLagMonitor: one heartbeat each second.
        this.record("workerMainBlock", lognormal(0.5, 0.9) + (chance(0.05) ? lognormal(80, 0.7) : 0));
        this.record("workerSelfLag", lognormal(0.25, 0.7));
        if (t % 10 === 0) this.record("workerClockOffset", uniform(0.01, 0.6));

        // SharedLivenessMonitor (cross-origin isolated pages only)
        if (this.has("liveness") && chance(0.06)) this.record("livenessBlock", uniform(60, 900));

        // GCSignalDetector
        if (chance(0.15)) this.record("gcEvents", 1);

        // Vitals of a page view that is now visible for 5 s are known (FCP, LCP, TTFB).
        if (t - view.startT === 5 && !view.reported) this.vitalValues(view);
    }

    backgroundMonitors(t, visible) {
        const p = this.profile;

        // MemoryMonitor: every 10 s.
        if (this.has("memory") && t % 10 === 0) {
            const used = (p.mobile ? 28e6 : 45e6) + t * 60e3 + Math.abs(gauss()) * 4e6;
            this.record("memoryUsed", used, { source : p.memorySource });
            if (p.memorySource === "legacy") this.record("memoryUsage", used / 2.17e9);
        }

        // ComputePressureMonitor: every 5 s.
        if (this.has("pressure") && t % 5 === 0) {
            const r = rnd();
            this.pressure("cpu", r < 0.7 ? 0 : r < 0.9 ? 1 : r < 0.98 ? 2 : 3);
            if (p.thermals) this.pressure("thermals", rnd() < 0.8 ? 0 : 1 + Math.floor(rnd() * 2));
        }

        // TimerThrottleDetector: every 10 s. Hidden tabs get throttled timers.
        if (t % 10 === 5) this.record("timerCalibrations", 1, { throttled : visible && !p.mobile ? "false" : chance(visible ? 0.3 : 0.9) ? "true" : "false" });

        // ClockDriftMonitor: every 5 s.
        if (t % 5 === 0) this.record("clockSkew", Math.abs(0.3 + t * 0.004 + gauss() * 0.2));
    }

    async close() {
        if (!this.view.reported || this.view.inp !== this.view.last.inp || this.view.cls !== this.view.last.cls) {
            this.reportVitals(this.view);
        }
        this.transition("terminated", "pagehide");
        // otel-ts shuts the providers down on pagehide: the final export.
        await Promise.allSettled([this.meterProvider.shutdown(), this.loggerProvider.shutdown()]);
    }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
    const profiles = PROFILES.slice(0, Number(args.pages));
    const startedAt = new Date();
    console.log(`Sending sample lag telemetry to ${ENDPOINT} for ${DURATION_S} s, ${profiles.length} page loads, export every ${EXPORT_INTERVAL_MS / 1000} s.`);

    const pages = [];
    const open = new Set();
    for (let second = 0; second < DURATION_S; second++) {
        const tickStart = Date.now();
        for (const [index, profile] of profiles.entries()) {
            if (second === profile.startS) {
                const page = new Page(profile, index);
                pages.push(page);
                open.add(page);
                console.log(`  ${second.toString().padStart(3)} s  page ${index} starts: ${profile.service} ${profile.navigation} instance ${page.instanceId}`);
            }
        }
        await Promise.all([...open].map(page => page.tick()));
        for (const page of [...open]) {
            if (page.t >= page.profile.lifeS) {
                open.delete(page);
                await page.close();
                console.log(`  ${second.toString().padStart(3)} s  page ${page.index} closed after ${page.t} s`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 1000 - (Date.now() - tickStart))));
    }
    await Promise.all([...open].map(page => page.close()));

    const used = new Set(Object.keys(counts.metrics));
    const missing = METRICS.filter(m => !used.has(m.name)).map(m => m.name);
    const summary = {
        endpoint : ENDPOINT,
        startedAt : startedAt.toISOString(),
        endedAt : new Date().toISOString(),
        exportIntervalS : EXPORT_INTERVAL_MS / 1000,
        pages : pages.map(page => ({
            index : page.index,
            service : page.profile.service,
            instanceId : page.instanceId,
            workerInstanceId : page.workerInstanceId,
            sessionId : page.sessionId,
            views : page.views.map(v => ({ id : v.id, navigationType : v.navigationType })),
        })),
        workerReports,
        metricsWithoutValues : missing,
        counts,
    };
    if (args.summary) writeFileSync(args.summary, JSON.stringify(summary, null, 2));

    console.log(`Recorded ${Object.values(counts.metrics).reduce((a, b) => a + b, 0)} measurements in ${used.size} of ${METRICS.length} metrics and ${Object.keys(counts.attributeSets).length} attribute sets.`);
    console.log(`Events: ${JSON.stringify(counts.events)}; app logs: ${counts.appLogs}.`);
    for (const report of workerReports) {
        console.log(`Worker hang report (${report.phase}): HTTP ${report.status ?? report.error}, Access-Control-Allow-Origin: ${report.allowOrigin}`);
    }
    if (missing.length > 0) {
        console.error(`Metrics without values: ${missing.join(", ")}`);
        process.exitCode = 1;
    }
    if (workerReports.some(r => r.status !== 200)) process.exitCode = 1;
}

await main();
