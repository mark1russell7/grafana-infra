#!/usr/bin/env node
/**
 * Sends a steady OTLP/HTTP JSON load to a sink: the stack of this repository
 * (Alloy on port 4318) or the SQLite sink of bench/sink/sqlite-sink.ts. It is
 * the load of the measure in .github/workflows/measure-sink.yml.
 *
 * The load is a number of services. Each second, each service sends:
 * - its share of the traces: a trace is a server span and a child span `db.query`;
 *   one trace in 50 fails, so its spans have the status ERROR;
 * - one log line for each trace, with the trace ID and the span ID of the server span;
 * - each 10 seconds, its metrics: a counter and a histogram for 3 routes.
 *
 * The IDs come from a counter, so two runs send the same data.
 *
 * Usage:
 *   node bench/sink/load.ts --rate 100 [--seconds 180] [--services 6]
 *     [--otlp http://localhost:4318] [--summary load-summary.json]
 *
 * --rate is the spans each second over all the services (2 spans in a trace).
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPrinter } from "@mark1russell7/text/print";

const print = createPrinter({ out: process.stdout, err: process.stderr });

const { values } = parseArgs({
  options: {
    rate: { type: "string", default: "100" },
    seconds: { type: "string", default: "180" },
    services: { type: "string", default: "6" },
    otlp: { type: "string", default: "http://localhost:4318" },
    summary: { type: "string" },
  },
});
const rate = Number(values.rate);
const seconds = Number(values.seconds);
const services = Number(values.services);
const otlp = (values.otlp ?? "http://localhost:4318").replace(/\/$/, "");
if (!(rate >= 0 && seconds > 0 && services > 0)) throw new Error("--rate, --seconds and --services must be numbers");

const ROUTES = ["GET /orders", "POST /orders", "GET /health"];
const hex = (value: number, width: number): string => value.toString(16).padStart(width, "0").slice(-width);
const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const nanos = (ms: number): string => `${BigInt(Math.round(ms)) * 1_000_000n}`;
const resource = (service: number) => ({
  attributes: [str("service.name", `load-${service}`), str("service.version", "1.0.0"), str("service.instance.id", `load-${service}-1`)],
});

let traces = 0;
/** The spans and the log lines of the traces of one service in one second */
const traceBatch = (service: number, count: number, now: number): { spans: object[]; logs: object[] } => {
  const spans: object[] = [];
  const logs: object[] = [];
  for (let n = 0; n < count; n += 1) {
    traces += 1;
    const traceId = hex(service, 8) + hex(traces, 24);
    const serverId = hex(traces * 2, 16);
    const dbId = hex(traces * 2 + 1, 16);
    const route = ROUTES[traces % ROUTES.length] ?? "GET /orders";
    const [method = "GET", target = "/"] = route.split(" ");
    const failed = traces % 50 === 0;
    const duration = 5 + (traces % 97);
    const start = now - duration;
    const status = failed ? { code: 2, message: "the order store refused the call" } : { code: 1 };
    spans.push({
      traceId,
      spanId: serverId,
      name: route,
      kind: 2,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(now),
      attributes: [str("http.request.method", method), str("http.route", target), { key: "http.response.status_code", value: { intValue: failed ? 500 : 200 } }],
      status,
    });
    spans.push({
      traceId,
      spanId: dbId,
      parentSpanId: serverId,
      name: "db.query",
      kind: 3,
      startTimeUnixNano: nanos(start + 1),
      endTimeUnixNano: nanos(start + 1 + duration / 2),
      attributes: [str("db.system.name", "sqlite"), str("db.operation.name", "SELECT")],
      status,
    });
    logs.push({
      timeUnixNano: nanos(now),
      severityNumber: failed ? 17 : 9,
      severityText: failed ? "ERROR" : "INFO",
      body: { stringValue: failed ? `${route} failed` : `${route} served` },
      traceId,
      spanId: serverId,
      attributes: [str("http.route", target)],
    });
  }
  return { spans, logs };
};

/** The metrics of one service: a counter and a histogram for each route */
const metricBatch = (service: number, start: number, now: number, served: number) => ({
  resourceMetrics: [
    {
      resource: resource(service),
      scopeMetrics: [
        {
          scope: { name: "load" },
          metrics: [
            {
              name: "http.server.requests",
              unit: "{request}",
              sum: {
                aggregationTemporality: 2,
                isMonotonic: true,
                dataPoints: ROUTES.map((route) => ({ attributes: [str("http.route", route)], startTimeUnixNano: nanos(start), timeUnixNano: nanos(now), asInt: `${served}` })),
              },
            },
            {
              name: "http.server.request.duration",
              unit: "ms",
              histogram: {
                aggregationTemporality: 2,
                dataPoints: ROUTES.map((route) => ({
                  attributes: [str("http.route", route)],
                  startTimeUnixNano: nanos(start),
                  timeUnixNano: nanos(now),
                  count: `${served}`,
                  sum: served * 50,
                  explicitBounds: [10, 25, 50, 100],
                  bucketCounts: [0, 1, 2, 1, 0].map((share) => `${Math.floor((served * share) / 4)}`),
                })),
              },
            },
          ],
        },
      ],
    },
  ],
});

const outcome = {
  sent: { traces: 0, spans: 0, logs: 0, metricBatches: 0 },
  requests: 0,
  failed: 0,
  statuses: {} as Record<string, number>,
  latencyMs: [] as number[],
};
const post = async (path: string, body: unknown): Promise<void> => {
  const started = performance.now();
  try {
    const response = await fetch(`${otlp}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await response.arrayBuffer();
    outcome.statuses[response.status] = (outcome.statuses[response.status] ?? 0) + 1;
    if (!response.ok) outcome.failed += 1;
  } catch (error) {
    outcome.failed += 1;
    const code = (error as { cause?: { code?: string } }).cause?.code ?? "error";
    outcome.statuses[code] = (outcome.statuses[code] ?? 0) + 1;
  }
  outcome.requests += 1;
  outcome.latencyMs.push(performance.now() - started);
};

const share = rate / 2 / services;
const owed = Array.from({ length: services }, () => 0);
const served = Array.from({ length: services }, () => 0);
const begin = Date.now();
for (let second = 1; second <= seconds; second += 1) {
  const now = Date.now();
  const sends: Promise<void>[] = [];
  for (let service = 0; service < services; service += 1) {
    const due = (owed[service] ?? 0) + share;
    const count = Math.floor(due);
    owed[service] = due - count;
    served[service] = (served[service] ?? 0) + count;
    if (count > 0) {
      const { spans, logs } = traceBatch(service, count, now);
      outcome.sent.traces += count;
      outcome.sent.spans += spans.length;
      outcome.sent.logs += logs.length;
      sends.push(post("/v1/traces", { resourceSpans: [{ resource: resource(service), scopeSpans: [{ scope: { name: "load" }, spans }] }] }));
      sends.push(post("/v1/logs", { resourceLogs: [{ resource: resource(service), scopeLogs: [{ scope: { name: "load" }, logRecords: logs }] }] }));
    }
    if (second % 10 === 0) {
      outcome.sent.metricBatches += 1;
      sends.push(post("/v1/metrics", metricBatch(service, begin, now, served[service] ?? 0)));
    }
  }
  await Promise.all(sends);
  const wait = begin + second * 1000 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

const sorted = outcome.latencyMs.sort((a, b) => a - b);
const at = (q: number): number | null => (sorted.length === 0 ? null : Math.round((sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0) * 10) / 10);
const summary = { rate, seconds, services, otlp, sent: outcome.sent, requests: outcome.requests, failed: outcome.failed, statuses: outcome.statuses, latencyMs: { p50: at(0.5), p99: at(0.99), max: at(1) } };
print.line(JSON.stringify(summary));
if (values.summary) writeFileSync(values.summary, `${JSON.stringify(summary, null, 2)}\n`);
if (outcome.failed > 0) process.exitCode = 1;
