#!/usr/bin/env node
/**
 * Reads the records of the jobs of .github/workflows/measure-sink.yml and gives
 * one table: the memory and CPU of each arm (the stack or the SQLite sink) at
 * each rate, idle and under the load, with the spread of the two rounds (A/A).
 *
 * Each job folder has:
 *   meta.json          {arm, rate, round}
 *   stats.jsonl        one line for each container at each sample:
 *                      {t, phase, name, mem: "41.2MiB / 15.6GiB", cpu: "0.52%"}
 *   load-summary.json  the summary of bench/sink/load.ts
 *   query.json         {query, seconds}: the time of one question
 *   rows.json          the sink only: the rows of each table and the bytes of the file
 *
 * Usage:
 *   node bench/sink/summarize.ts <records folder> [--markdown summary.md] [--json summary.json]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPrinter } from "@mark1russell7/text/print";

const print = createPrinter({ out: process.stdout, err: process.stderr });

interface Meta {
  readonly arm: string;
  readonly rate: number;
  readonly round: number;
}
interface StatLine {
  readonly t: number;
  readonly phase: string;
  readonly name: string;
  readonly mem: string;
  readonly cpu: string;
}
interface LoadSummary {
  readonly failed: number;
  readonly requests: number;
  readonly latencyMs: { readonly p99: number | null };
}
interface Query {
  readonly seconds?: number;
}
interface Rows {
  readonly bytes?: number;
}
interface Phase {
  readonly samples: number;
  readonly memMeanMB: number | null;
  readonly memMaxMB: number | null;
  readonly cpuMeanPercent: number | null;
  readonly containersMeanMB: Record<string, number | null>;
}
interface Round extends Phase {
  readonly load?: LoadSummary | undefined;
  readonly query?: Query | undefined;
  readonly rows?: Rows | undefined;
}
interface Cell {
  readonly key: string;
  readonly arm: string;
  readonly rate: number;
  readonly phase: string;
  readonly rounds: Round[];
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { markdown: { type: "string" }, json: { type: "string" } } });
const root = positionals[0];
if (root === undefined) throw new Error("give the folder of the records");

const UNITS: Record<string, number> = { B: 1, kB: 1e3, KiB: 1024, MB: 1e6, MiB: 1024 ** 2, GB: 1e9, GiB: 1024 ** 3 };
const bytes = (text: string): number => {
  const match = /^([\d.]+)\s*([A-Za-z]+)/.exec((String(text).split("/")[0] ?? "").trim());
  const unit = match === null ? undefined : UNITS[match[2] ?? ""];
  if (match === null || unit === undefined) throw new Error(`no size in "${text}"`);
  return Number(match[1]) * unit;
};
const mean = (list: readonly number[]): number | null => (list.length === 0 ? null : list.reduce((a, b) => a + b, 0) / list.length);
const read = <T>(folder: string, name: string): T | undefined => (existsSync(join(folder, name)) ? (JSON.parse(readFileSync(join(folder, name), "utf8")) as T) : undefined);
const round = (value: number | null | undefined, digits = 1): number | null => (value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits);

const jobs: (Meta & { phases: Record<string, Phase>; load?: LoadSummary | undefined; query?: Query | undefined; rows?: Rows | undefined })[] = [];
for (const name of readdirSync(root)) {
  const folder = join(root, name);
  const meta = read<Meta>(folder, "meta.json");
  if (meta === undefined) continue;
  const lines = readFileSync(join(folder, "stats.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as StatLine);
  const phases: Record<string, Phase> = {};
  for (const phase of ["idle", "load"]) {
    const samples = new Map<number, { mem: number; cpu: number }>();
    const containers: Record<string, number[]> = {};
    for (const line of lines.filter((l) => l.phase === phase)) {
      const sample = samples.get(line.t) ?? { mem: 0, cpu: 0 };
      sample.mem += bytes(line.mem);
      sample.cpu += Number.parseFloat(line.cpu);
      samples.set(line.t, sample);
      (containers[line.name] ??= []).push(bytes(line.mem));
    }
    const list = [...samples.values()];
    phases[phase] = {
      samples: list.length,
      memMeanMB: round((mean(list.map((s) => s.mem)) ?? 0) / 1e6),
      memMaxMB: round(Math.max(...list.map((s) => s.mem)) / 1e6),
      cpuMeanPercent: round(mean(list.map((s) => s.cpu))),
      containersMeanMB: Object.fromEntries(Object.entries(containers).map(([n, m]) => [n, round((mean(m) ?? 0) / 1e6)])),
    };
  }
  jobs.push({ ...meta, phases, load: read<LoadSummary>(folder, "load-summary.json"), query: read<Query>(folder, "query.json"), rows: read<Rows>(folder, "rows.json") });
}
jobs.sort((a, b) => a.arm.localeCompare(b.arm) || a.rate - b.rate || a.round - b.round);

/** Each cell: the mean of its rounds, and the spread of its rounds */
const cells: Cell[] = [];
for (const job of jobs) {
  for (const phase of ["idle", "load"]) {
    const key = `${job.arm} ${job.rate} ${phase}`;
    let cell = cells.find((c) => c.key === key);
    if (cell === undefined) cells.push((cell = { key, arm: job.arm, rate: job.rate, phase, rounds: [] }));
    const measured = job.phases[phase];
    if (measured === undefined) continue;
    cell.rounds.push({ ...measured, load: phase === "load" ? job.load : undefined, query: phase === "load" ? job.query : undefined, rows: phase === "load" ? job.rows : undefined });
  }
}
const spread = (list: readonly (number | null)[]): number | null => (list.length < 2 || list.some((v) => v === null) ? null : Math.max(...(list as number[])) - Math.min(...(list as number[])));
const table = cells.map((cell) => {
  const mem = cell.rounds.map((r) => r.memMeanMB);
  const cpu = cell.rounds.map((r) => r.cpuMeanPercent);
  const loads = cell.rounds.map((r) => r.load).filter((l): l is LoadSummary => l !== undefined);
  const queries = cell.rounds.map((r) => r.query?.seconds).filter((s): s is number => typeof s === "number");
  return {
    arm: cell.arm,
    rate: cell.rate,
    phase: cell.phase,
    rounds: cell.rounds.length,
    memMeanMB: round(mean(mem.filter((m): m is number => m !== null))),
    memSpreadMB: round(spread(mem)),
    memMaxMB: round(Math.max(...cell.rounds.map((r) => r.memMaxMB ?? 0))),
    cpuMeanPercent: round(mean(cpu.filter((c): c is number => c !== null))),
    cpuSpreadPercent: round(spread(cpu)),
    failed: loads.length === 0 ? null : loads.reduce((a, l) => a + l.failed, 0),
    requests: loads.length === 0 ? null : loads.reduce((a, l) => a + l.requests, 0),
    sendP99Ms: loads.length === 0 ? null : Math.max(...loads.map((l) => l.latencyMs.p99 ?? 0)),
    queryMs: queries.length === 0 ? null : round((mean(queries) ?? 0) * 1000),
    fileMB: cell.rounds[0]?.rows?.bytes === undefined ? null : round((mean(cell.rounds.map((r) => r.rows?.bytes ?? 0)) ?? 0) / 1e6),
    containersMeanMB: cell.rounds[0]?.containersMeanMB ?? {},
  };
});

const cellText = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : String(value));
const lines = [
  "## Memory and CPU of each sink",
  "",
  "Memory is the sum of the containers of the arm, in MB (10^6 bytes). CPU is the sum of their CPU percent (100 is one core). Each cell is the mean of its rounds, with the spread of the rounds (A/A).",
  "",
  "| Arm | Spans/s | Phase | Memory mean (spread) | Memory max | CPU % (spread) | Failed / requests | Send p99 ms | Query ms | File MB |",
  "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...table.map((r) =>
    `| ${r.arm} | ${r.rate} | ${r.phase} | ${cellText(r.memMeanMB)} (${cellText(r.memSpreadMB)}) | ${cellText(r.memMaxMB)} | ${cellText(r.cpuMeanPercent)} (${cellText(r.cpuSpreadPercent)}) | ${r.requests === null ? "–" : `${r.failed} / ${r.requests}`} | ${cellText(r.sendP99Ms)} | ${cellText(r.queryMs)} | ${cellText(r.fileMB)} |`,
  ),
  "",
  "### The containers of each arm under the load, mean MB",
  "",
  ...table
    .filter((r) => r.phase === "load")
    .map((r) => `- ${r.arm} at ${r.rate} spans/s: ${Object.entries(r.containersMeanMB).map(([n, m]) => `${n} ${m}`).join(", ")}`),
  "",
];
const markdown = lines.join("\n");
print.line(markdown);
if (values.markdown) writeFileSync(values.markdown, markdown);
if (values.json) writeFileSync(values.json, `${JSON.stringify({ jobs, table }, null, 2)}\n`);
