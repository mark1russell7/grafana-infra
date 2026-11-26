#!/usr/bin/env node
/**
 * A light OTLP sink for the measure of .github/workflows/measure-sink.yml: an
 * OTLP/HTTP JSON receiver that writes each span, log line and metric point to
 * one SQLite file, through @mark1russell7/sqlite.
 *
 * It is a prototype for one decision: where the telemetry of the services lands
 * (the stack of this repository, always on, or a sink of this size). The measure
 * compares its memory and CPU with the stack at the same load. The code moves to
 * the home that the decision names, or it goes away.
 *
 * Each question is a query:
 *   GET /query/slow?service=load-0&ms=50
 *                       the server spans of a service over a time in the last hour (the
 *                       question that the measure also asks of Tempo)
 *   GET /query/slowest  the slowest server span of each service in the last day
 *   GET /query/errors   the error rate of each service in the last hour
 *   GET /stats          the count of the rows of each table, and the size of the file
 *
 * Usage:
 *   node bench/sink/sqlite-sink.mjs [--db otlp.db] [--port 4318]
 */
import { statSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { migrate, openDatabase, transaction } from "@mark1russell7/sqlite";

const { values } = parseArgs({ options: { db: { type: "string", default: "otlp.db" }, port: { type: "string", default: "4318" } } });

const db = openDatabase(values.db, { synchronous: "NORMAL", busyTimeoutMs: 5000, makeFolder: true });
migrate(db, [
  `CREATE TABLE spans (trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_id TEXT, service TEXT NOT NULL, name TEXT NOT NULL,
    kind INTEGER, start_ns INTEGER NOT NULL, end_ns INTEGER NOT NULL, status INTEGER NOT NULL, attributes TEXT NOT NULL) STRICT`,
  "CREATE INDEX spans_service_start ON spans (service, start_ns)",
  "CREATE INDEX spans_trace ON spans (trace_id)",
  `CREATE TABLE logs (time_ns INTEGER NOT NULL, service TEXT NOT NULL, severity INTEGER, body TEXT, trace_id TEXT, span_id TEXT,
    attributes TEXT NOT NULL) STRICT`,
  "CREATE INDEX logs_service_time ON logs (service, time_ns)",
  "CREATE INDEX logs_trace ON logs (trace_id)",
  `CREATE TABLE points (time_ns INTEGER NOT NULL, service TEXT NOT NULL, metric TEXT NOT NULL, attributes TEXT NOT NULL,
    value REAL, histogram TEXT) STRICT`,
  "CREATE INDEX points_metric_time ON points (metric, time_ns)",
]);

const insertSpan = db.prepare("INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertLog = db.prepare("INSERT INTO logs VALUES (?, ?, ?, ?, ?, ?, ?)");
const insertPoint = db.prepare("INSERT INTO points VALUES (?, ?, ?, ?, ?, ?)");

/** The value of an OTLP JSON AnyValue */
const valueOf = (value) =>
  value === undefined || value === null
    ? null
    : (value.stringValue ?? value.boolValue ?? (value.intValue === undefined ? undefined : Number(value.intValue)) ?? value.doubleValue ?? (value.arrayValue ? value.arrayValue.values?.map(valueOf) : undefined) ?? null);
const attributesOf = (list = []) => Object.fromEntries(list.map(({ key, value }) => [key, valueOf(value)]));
const serviceOf = (resource) => String(attributesOf(resource?.attributes)["service.name"] ?? "unknown_service");
// the times stay BigInt from the parse to SQLite: a nanosecond time of today is past 2^53
const ns = (text) => (text === undefined ? 0n : BigInt(text));

const writers = {
  "/v1/traces": (body) => {
    let rows = 0;
    for (const { resource, scopeSpans = [] } of body.resourceSpans ?? [])
      for (const { spans = [] } of scopeSpans)
        for (const span of spans) {
          insertSpan.run(span.traceId, span.spanId, span.parentSpanId || null, serviceOf(resource), span.name, span.kind ?? null, ns(span.startTimeUnixNano), ns(span.endTimeUnixNano), span.status?.code ?? 0, JSON.stringify(attributesOf(span.attributes)));
          rows += 1;
        }
    return rows;
  },
  "/v1/logs": (body) => {
    let rows = 0;
    for (const { resource, scopeLogs = [] } of body.resourceLogs ?? [])
      for (const { logRecords = [] } of scopeLogs)
        for (const log of logRecords) {
          const text = valueOf(log.body);
          insertLog.run(ns(log.timeUnixNano ?? log.observedTimeUnixNano), serviceOf(resource), log.severityNumber ?? null, text === null ? null : String(text), log.traceId || null, log.spanId || null, JSON.stringify(attributesOf(log.attributes)));
          rows += 1;
        }
    return rows;
  },
  "/v1/metrics": (body) => {
    let rows = 0;
    for (const { resource, scopeMetrics = [] } of body.resourceMetrics ?? [])
      for (const { metrics = [] } of scopeMetrics)
        for (const metric of metrics) {
          const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
          for (const point of points) {
            insertPoint.run(ns(point.timeUnixNano), serviceOf(resource), metric.name, JSON.stringify(attributesOf(point.attributes)), point.asDouble ?? Number(point.asInt ?? 0), null);
            rows += 1;
          }
          for (const point of metric.histogram?.dataPoints ?? []) {
            const { count, sum, explicitBounds, bucketCounts } = point;
            insertPoint.run(ns(point.timeUnixNano), serviceOf(resource), metric.name, JSON.stringify(attributesOf(point.attributes)), sum ?? null, JSON.stringify({ count: Number(count ?? 0), explicitBounds, bucketCounts: bucketCounts?.map(Number) }));
            rows += 1;
          }
        }
    return rows;
  },
};

const DAY_NS = 86_400_000_000_000n;
const HOUR_NS = 3_600_000_000_000n;
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const slowest = db.prepare(
  `SELECT service, name, trace_id AS traceId, MAX(end_ns - start_ns) / 1e6 AS ms FROM spans
   WHERE kind = 2 AND start_ns >= ? GROUP BY service ORDER BY ms DESC`,
);
const slow = db.prepare(
  `SELECT trace_id AS traceId, name, (end_ns - start_ns) / 1e6 AS ms FROM spans
   WHERE service = ? AND kind = 2 AND start_ns >= ? AND end_ns - start_ns > ? ORDER BY start_ns DESC LIMIT 20`,
);
const errors = db.prepare(
  `SELECT service, COUNT(*) AS spans, SUM(status = 2) AS failed, ROUND(1.0 * SUM(status = 2) / COUNT(*), 4) AS rate FROM spans
   WHERE kind = 2 AND start_ns >= ? GROUP BY service ORDER BY service`,
);
const counts = () => ({
  spans: db.prepare("SELECT COUNT(*) AS n FROM spans").get().n,
  logs: db.prepare("SELECT COUNT(*) AS n FROM logs").get().n,
  points: db.prepare("SELECT COUNT(*) AS n FROM points").get().n,
});
const fileBytes = () => ["", "-wal"].reduce((total, suffix) => {
  try {
    return total + statSync(values.db + suffix).size;
  } catch {
    return total;
  }
}, 0);

const reply = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const timed = (rows) => {
  const started = performance.now();
  const result = rows();
  return { ms: Math.round((performance.now() - started) * 1000) / 1000, rows: result };
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://sink");
  const path = url.pathname;
  if (request.method === "GET") {
    if (path === "/ready") return reply(response, 200, { ready: true });
    if (path === "/stats") return reply(response, 200, { ...counts(), bytes: fileBytes() });
    if (path === "/query/slow")
      return reply(response, 200, timed(() => slow.all(url.searchParams.get("service") ?? "", nowNs() - HOUR_NS, BigInt(Math.round(Number(url.searchParams.get("ms") ?? 0) * 1e6)))));
    if (path === "/query/slowest") return reply(response, 200, timed(() => slowest.all(nowNs() - DAY_NS)));
    if (path === "/query/errors") return reply(response, 200, timed(() => errors.all(nowNs() - HOUR_NS)));
    return reply(response, 404, { error: `no route ${path}` });
  }
  const write = writers[path];
  if (request.method !== "POST" || write === undefined) return reply(response, 404, { error: `no route ${request.method} ${path}` });
  if (!String(request.headers["content-type"] ?? "").includes("json")) return reply(response, 415, { error: "the sink takes OTLP/HTTP JSON only" });
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      transaction(db, () => write(body));
      reply(response, 200, {});
    } catch (error) {
      reply(response, 400, { error: String(error?.message ?? error) });
    }
  });
});

server.listen(Number(values.port), () => console.log(`the SQLite sink takes OTLP/HTTP JSON on port ${values.port}, file ${values.db}`));
const stop = () => server.close(() => {
  db.close();
  process.exit(0);
});
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
