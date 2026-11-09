#!/usr/bin/env node
/**
 * Sends the telemetry of a sample Node service to the stack, with
 * `startNodeTelemetry()` of `@mark1russell7/otel-ts/node` (roadmap item C9 of
 * otel-ts). It is the form of telemetry of each Node service of the fleet:
 * OTLP/HTTP protobuf to Alloy on port 4318.
 *
 * The service runs some requests. Each request is a trace: a server span
 * `GET /orders`, a child span `db.query`, and one log line in the context of
 * the server span. One request fails, so its spans have the status ERROR. A
 * counter counts the requests. `scripts/verify-pipeline.mjs --node-summary`
 * then checks that:
 *
 * - Tempo has each trace, with the service name of the sample;
 * - each log line in Loki has the trace ID and the span ID of its request
 *   (the link from a log line to its trace);
 * - Mimir has the span metrics of Alloy for the service, with exemplars that
 *   have the trace IDs (the link from a metric to its traces);
 * - Mimir has the counter of the service.
 *
 * With --service, a second sample has its own series. CI sends one with the
 * tail sampler of Alloy at TRACE_SAMPLE_PERCENT=0 (verify-pipeline.mjs
 * --sampled-summary).
 *
 * Usage:
 *   node scripts/send-node-service-data.mjs [--summary node-summary.json]
 *     [--otlp http://localhost:4318] [--requests 20]
 *     [--service sample-node-service]
 */

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";

const { values : args } = parseArgs({
    options : {
        summary : { type : "string" },
        otlp : { type : "string", default : process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? `http://localhost:${process.env.OTLP_HTTP_PORT ?? 4318}` },
        requests : { type : "string", default : "20" },
        service : { type : "string", default : "sample-node-service" },
    },
});

/** The service name of the sample. The checks of verify-pipeline.mjs read it from the summary. */
const SERVICE_NAME = args.service;

// The OTLP exporters read their endpoint from the environment, so set it before the start
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = args.otlp;

const { startNodeTelemetry } = await import("@mark1russell7/otel-ts/node");
const { trace, metrics, context, SpanKind, SpanStatusCode } = await import("@opentelemetry/api");
const { logs, SeverityNumber } = await import("@opentelemetry/api-logs");
const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");

const telemetry = startNodeTelemetry({
    serviceName : SERVICE_NAME,
    enabled : true,
    stopOnSignals : false,
    metricReaders : [new PeriodicExportingMetricReader({ exporter : new OTLPMetricExporter({ url : `${args.otlp}/v1/metrics` }), exportIntervalMillis : 5_000 })],
});

const tracer = trace.getTracer("sample-node-service");
const logger = logs.getLogger("sample-node-service");
const requests = metrics.getMeter("sample-node-service").createCounter("sample_node_requests", { description : "The requests of the sample Node service" });

const startedAt = new Date().toISOString();
const traces = [];
const count = Number(args.requests);
for (let i = 0; i < count; i++) {
    // The last request fails
    const failed = i === count - 1;
    await tracer.startActiveSpan("GET /orders", { kind : SpanKind.SERVER, attributes : { "http.request.method" : "GET", "http.route" : "/orders" } }, async (server) => {
        await tracer.startActiveSpan("db.query", { kind : SpanKind.CLIENT, attributes : { "db.system.name" : "sqlite" } }, async (query) => {
            await new Promise(resolve => setTimeout(resolve, 5 + (i % 5) * 3));
            if (failed) query.setStatus({ code : SpanStatusCode.ERROR, message : "the sample request fails" });
            query.end();
        });
        // The log record gets the trace ID and the span ID of the active span
        logger.emit({
            severityNumber : failed ? SeverityNumber.ERROR : SeverityNumber.INFO,
            severityText : failed ? "ERROR" : "INFO",
            body : failed ? `request ${i} failed` : `request ${i} served`,
            attributes : { "sample.request" : i },
            context : context.active(),
        });
        requests.add(1, { "http.response.status_code" : failed ? 500 : 200 });
        if (failed) server.setStatus({ code : SpanStatusCode.ERROR, message : "the sample request fails" });
        traces.push({ traceId : server.spanContext().traceId, spanId : server.spanContext().spanId, failed, line : failed ? `request ${i} failed` : `request ${i} served` });
        server.end();
    });
}

// The stop flushes the spans, the log records and the metrics
await telemetry.shutdown();
const summary = { service : SERVICE_NAME, startedAt, endedAt : new Date().toISOString(), requests : count, traces };
console.log(`Sent ${count} requests of ${SERVICE_NAME} (${traces.filter(t => t.failed).length} failed) to ${args.otlp}`);
if (args.summary) writeFileSync(args.summary, `${JSON.stringify(summary, null, 2)}\n`);
