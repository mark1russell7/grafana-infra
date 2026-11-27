// The sink and the load of the measure, end to end, in one process tree: node --test bench/sink/sink.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const here = import.meta.dirname;
const folder = mkdtempSync(join(tmpdir(), "sink-test-"));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

const run = (script: string, args: readonly string[]): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, script), ...args], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("exit", (code) => resolve({ code, out }));
  });

let port = 0;
let sink: ReturnType<typeof spawn> | undefined;
const url = (path: string): string => `http://127.0.0.1:${port}${path}`;
const json = async (path: string): Promise<Record<string, unknown>> => (await (await fetch(url(path))).json()) as Record<string, unknown>;

before(async () => {
  port = await freePort();
  sink = spawn(process.execPath, [join(here, "sqlite-sink.ts"), "--db", join(folder, "otlp.db"), "--port", String(port)], { stdio: "ignore" });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(url("/ready"))).ok) return;
    } catch {
      // the sink is not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the sink did not start");
});

after(async () => {
  // the file of the sink stays open until its process exits, and Windows refuses to remove an open file
  if (sink !== undefined && sink.exitCode === null && sink.signalCode === null) {
    const exited = once(sink, "exit");
    sink.kill("SIGTERM");
    await exited;
  }
  rmSync(folder, { recursive: true, force: true });
});

test("the sink keeps each span and log line of the load, and answers each question", async () => {
  const summaryFile = join(folder, "load-summary.json");
  const load = await run("load.ts", ["--rate", "40", "--seconds", "3", "--otlp", url(""), "--summary", summaryFile]);
  assert.equal(load.code, 0);
  const summary = JSON.parse(readFileSync(summaryFile, "utf8")) as { sent: { spans: number; logs: number }; failed: number };
  assert.equal(summary.failed, 0);
  assert.ok(summary.sent.spans > 0);
  const stats = await json("/stats");
  assert.equal(stats["spans"], summary.sent.spans);
  assert.equal(stats["logs"], summary.sent.logs);
  // the times stay exact: each duration of the load is a whole number of milliseconds
  const slowest = (await json("/query/slowest")) as { rows: { ms: number }[] };
  assert.ok(slowest.rows.length > 0);
  for (const row of slowest.rows) assert.equal(row.ms, Math.round(row.ms));
  const errors = (await json("/query/errors")) as { rows: { spans: number }[] };
  assert.ok(errors.rows.length > 0);
});

test("the sink keeps the points of a counter and a histogram", async () => {
  const before = (await json("/stats"))["points"] as number;
  const point = { timeUnixNano: "1700000000000000000", attributes: [{ key: "http.route", value: { stringValue: "/a" } }] };
  const body = {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "test" } }] },
        scopeMetrics: [
          {
            metrics: [
              { name: "requests", sum: { dataPoints: [{ ...point, asInt: "7" }] } },
              { name: "duration", histogram: { dataPoints: [{ ...point, count: "2", sum: 30, explicitBounds: [10], bucketCounts: ["1", "1"] }] } },
            ],
          },
        ],
      },
    ],
  };
  const response = await fetch(url("/v1/metrics"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal((await json("/stats"))["points"], before + 2);
});

test("the sink refuses protobuf and a body that is not JSON", async () => {
  const protobuf = await fetch(url("/v1/traces"), { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: "x" });
  assert.equal(protobuf.status, 415);
  const broken = await fetch(url("/v1/traces"), { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(broken.status, 400);
});

test("the summary gives the mean and the spread of the rounds of each cell", async () => {
  const records = join(folder, "records");
  for (const [round, mem] of [[1, "40MiB / 15GiB"], [2, "44MiB / 15GiB"]] as const) {
    const job = join(records, `sqlite-100-${round}`);
    mkdirSync(job, { recursive: true });
    writeFileSync(join(job, "meta.json"), JSON.stringify({ arm: "sqlite", rate: 100, round }));
    const lines = [1, 2].map((t) => JSON.stringify({ t, phase: t === 1 ? "idle" : "load", name: "sqlite-sink", mem, cpu: "1.5%" }));
    writeFileSync(join(job, "stats.jsonl"), `${lines.join("\n")}\n`);
    writeFileSync(join(job, "load-summary.json"), JSON.stringify({ failed: 0, requests: 10, latencyMs: { p99: 5 } }));
  }
  const out = join(folder, "summary.json");
  const result = await run("summarize.ts", [records, "--json", out]);
  assert.equal(result.code, 0);
  const { table } = JSON.parse(readFileSync(out, "utf8")) as { table: { phase: string; memMeanMB: number; memSpreadMB: number; requests: number | null }[] };
  const load = table.find((row) => row.phase === "load");
  assert.equal(load?.memMeanMB, 44);
  assert.equal(load?.memSpreadMB, 4.2);
  assert.equal(load?.requests, 20);
});
