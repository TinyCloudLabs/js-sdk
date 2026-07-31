import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  vault_decrypt,
  vault_encrypt,
  vault_random_bytes,
} from "@tinycloud/node-sdk-wasm";
import type { TelemetrySpanEvent } from "@tinycloud/sdk-services";
import { checkServerHealth, SERVER_URL, TEST_KEY } from "../setup";
import { writeDashboard } from "./dashboard";
import { createTimedFetch, type HttpTimingSample } from "./request-timing";

type BenchmarkSource = "http" | "manual" | "telemetry";

interface ServerInfo {
  version?: string;
  features: string[];
}

interface BenchmarkRecord {
  runId: string;
  timestamp: string;
  server: string;
  benchmark: string;
  span: string;
  source: BenchmarkSource;
  iteration: number;
  ok: boolean;
  durationMs: number;
  meta?: Record<string, unknown>;
}

interface SpanSummary {
  runId: string;
  timestamp: string;
  server: string;
  span: string;
  source: BenchmarkSource;
  count: number;
  okCount: number;
  errorCount: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

const iterations = positiveInt(process.env.TC_BENCH_ITERATIONS, 10);
const warmupIterations = positiveInt(process.env.TC_BENCH_WARMUP, 2);
const outputDir = process.env.TC_BENCH_OUTPUT_DIR ?? join("benchmarks", "results");
const runId = process.env.TC_BENCH_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const timestamp = new Date().toISOString();
const forceDuckDb = process.env.TC_BENCH_DUCKDB === "true";
const baselinePath = process.env.TC_BENCH_BASELINE_PATH;
const overwriteBaseline = process.env.TC_BENCH_OVERWRITE_BASELINE === "true";
const logRequests = process.env.TC_BENCH_LOG_REQUESTS === "true";
const records: BenchmarkRecord[] = [];

let currentBenchmark = "setup";
let currentIteration = -1;
const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = createTimedFetch(originalFetch, {
  server: SERVER_URL,
  context: () => ({
    benchmark: currentBenchmark,
    iteration: currentIteration,
  }),
  record: recordHttpTiming,
  logRequests,
}) as typeof globalThis.fetch;

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nowMs(): number {
  return performance.now();
}

function record(record: Omit<BenchmarkRecord, "runId" | "timestamp" | "server">): void {
  records.push({
    runId,
    timestamp,
    server: SERVER_URL,
    ...record,
  });
}

function recordTelemetrySpan(data: unknown): void {
  const span = data as Partial<TelemetrySpanEvent>;
  if (typeof span.span !== "string" || typeof span.durationMs !== "number") {
    return;
  }
  record({
    benchmark: currentBenchmark,
    span: span.span,
    source: "telemetry",
    iteration: currentIteration,
    ok: span.ok !== false,
    durationMs: span.durationMs,
    meta: {
      service: span.service,
      action: span.action,
      status: span.status,
    },
  });
}

function recordHttpTiming(sample: HttpTimingSample): void {
  const {
    benchmark,
    iteration,
    method,
    path,
    phase,
    ok,
    durationMs,
    ...meta
  } = sample;
  const route = path === "/" ? "root" : path.slice(1).replaceAll("/", ".");
  record({
    benchmark,
    span: `${benchmark}.http.${phase}.${method.toLowerCase()}.${route}`,
    source: "http",
    iteration,
    ok,
    durationMs,
    meta: {
      method,
      path,
      phase,
      ...meta,
    },
  });
}

async function measure<T>(
  span: string,
  iteration: number,
  operation: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  currentBenchmark = span;
  currentIteration = iteration;
  const start = nowMs();
  try {
    const value = await operation();
    record({
      benchmark: span,
      span,
      source: "manual",
      iteration,
      ok: true,
      durationMs: nowMs() - start,
      meta,
    });
    return value;
  } catch (error) {
    record({
      benchmark: span,
      span,
      source: "manual",
      iteration,
      ok: false,
      durationMs: nowMs() - start,
      meta: {
        ...meta,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

function assertOk<T>(result: { ok: true; data: T } | { ok: false; error: { message: string } }): T {
  if (result.ok === false) {
    throw new Error(result.error.message);
  }
  return result.data;
}

async function serverInfo(): Promise<ServerInfo> {
  const response = await fetch(`${SERVER_URL}/info`);
  if (!response.ok) {
    return { features: [] };
  }
  const info = (await response.json()) as { version?: unknown; features?: unknown };
  return {
    ...(typeof info.version === "string" ? { version: info.version } : {}),
    features: Array.isArray(info.features)
      ? info.features.filter((feature): feature is string => typeof feature === "string")
      : [],
  };
}

async function main(): Promise<void> {
  if (baselinePath) {
    await assertBaselineWritable(baselinePath);
  }
  await checkServerHealth();
  const info = await serverInfo();
  const includeDuckDb = forceDuckDb || info.features.includes("duckdb");

  const client = new TinyCloudNode({
    privateKey: TEST_KEY,
    host: SERVER_URL,
    prefix: `sdk-bench-${runId}`,
    autoCreateSpace: true,
    telemetry: {
      enabled: true,
      onEvent(event, data) {
        if (event === "telemetry.span") {
          recordTelemetrySpan(data);
        }
      },
    },
  });

  await measure("sdk.signIn", 0, () => client.signIn());

  const sqlTable = `sdk_bench_sql_${Date.now()}`;
  const duckTable = `sdk_bench_duck_${Date.now()}`;
  const cryptoKey = vault_random_bytes(32);
  const cryptoPlaintext = new TextEncoder().encode("x".repeat(1024));

  await measure("sdk.sql.setup", 0, async () => {
    assertOk(
      await client.sql.execute(
        `CREATE TABLE IF NOT EXISTS ${sqlTable} (id INTEGER PRIMARY KEY, value TEXT)`,
      ),
    );
  });

  if (includeDuckDb) {
    await measure("sdk.duckdb.setup", 0, async () => {
      assertOk(
        await client.duckdb.execute(
          `CREATE TABLE IF NOT EXISTS ${duckTable} (id INTEGER, value VARCHAR)`,
        ),
      );
    });
  }

  for (let i = -warmupIterations; i < iterations; i += 1) {
    const isWarmup = i < 0;
    const iteration = isWarmup ? i : i + 1;
    const key = `${isWarmup ? "warmup" : "item"}-${iteration}`;
    const value = { iteration, runId, payload: "x".repeat(256) };
    let encrypted: Uint8Array<ArrayBufferLike> = new Uint8Array();

    await measure("sdk.crypto.encrypt", iteration, async () => {
      encrypted = vault_encrypt(cryptoKey, cryptoPlaintext);
    }, { warmup: isWarmup, payloadBytes: cryptoPlaintext.byteLength });

    await measure("sdk.crypto.decrypt", iteration, async () => {
      const decrypted = vault_decrypt(cryptoKey, encrypted);
      if (decrypted.byteLength !== cryptoPlaintext.byteLength) {
        throw new Error("Decrypted benchmark payload has the wrong length");
      }
    }, { warmup: isWarmup, payloadBytes: cryptoPlaintext.byteLength });

    await measure("sdk.kv.put", iteration, async () => {
      assertOk(await client.kv.put(key, value));
    }, { warmup: isWarmup });

    await measure("sdk.kv.get", iteration, async () => {
      assertOk(await client.kv.get(key));
    }, { warmup: isWarmup });

    await measure("sdk.kv.list", iteration, async () => {
      assertOk(await client.kv.list({ prefix: isWarmup ? "warmup" : "item" }));
    }, { warmup: isWarmup });

    await measure("sdk.sql.execute", iteration, async () => {
      assertOk(
        await client.sql.execute(`INSERT OR REPLACE INTO ${sqlTable} (id, value) VALUES (?, ?)`, [
          iteration,
          `value-${iteration}`,
        ]),
      );
    }, { warmup: isWarmup });

    await measure("sdk.sql.query", iteration, async () => {
      assertOk(await client.sql.query(`SELECT * FROM ${sqlTable} WHERE id = ?`, [iteration]));
    }, { warmup: isWarmup });

    if (includeDuckDb) {
      await measure("sdk.duckdb.execute", iteration, async () => {
        assertOk(
          await client.duckdb.execute(`INSERT INTO ${duckTable} VALUES (?, ?)`, [
            iteration,
            `value-${iteration}`,
          ]),
        );
      }, { warmup: isWarmup });

      await measure("sdk.duckdb.query", iteration, async () => {
        assertOk(await client.duckdb.query(`SELECT * FROM ${duckTable} WHERE id = ?`, [iteration]));
      }, { warmup: isWarmup });
    }
  }

  await measure("sdk.sql.cleanup", 0, async () => {
    assertOk(await client.sql.execute(`DROP TABLE IF EXISTS ${sqlTable}`));
  });
  if (includeDuckDb) {
    await measure("sdk.duckdb.cleanup", 0, async () => {
      assertOk(await client.duckdb.execute(`DROP TABLE IF EXISTS ${duckTable}`));
    });
  }

  await writeResults(info);
}

function summarize(records: BenchmarkRecord[]): SpanSummary[] {
  const measuredRecords = records.filter((record) => record.iteration > 0);
  const groups = new Map<string, BenchmarkRecord[]>();
  for (const record of measuredRecords) {
    const key = `${record.source}\u0000${record.span}`;
    const group = groups.get(key);
    if (group) {
      group.push(record);
    } else {
      groups.set(key, [record]);
    }
  }

  return [...groups.values()]
    .map((group) => {
      const durations = group.map((record) => record.durationMs).sort((a, b) => a - b);
      const okCount = group.filter((record) => record.ok).length;
      return {
        runId,
        timestamp,
        server: SERVER_URL,
        span: group[0].span,
        source: group[0].source,
        count: group.length,
        okCount,
        errorCount: group.length - okCount,
        minMs: durations[0],
        meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        p99Ms: percentile(durations, 0.99),
        maxMs: durations[durations.length - 1],
      };
    })
    .sort((a, b) => a.span.localeCompare(b.span) || a.source.localeCompare(b.source));
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(sortedValues.length * p) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

async function writeResults(info: ServerInfo): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const cpuInfo = cpus();
  const rawPath = join(outputDir, `${runId}.jsonl`);
  const summaryPath = join(outputDir, `${runId}.summary.json`);
  const summaryCsvPath = join(outputDir, "summary.csv");
  const summaries = summarize(records);
  const summaryDocument = {
    schemaVersion: 2,
    runId,
    timestamp,
    server: {
      url: SERVER_URL,
      ...info,
      revision: process.env.TC_BENCH_SERVER_REVISION,
    },
    client: {
      revision: process.env.TC_BENCH_CLIENT_REVISION ?? gitRevision(),
      branch: gitBranch(),
      dirty: gitDirty(),
      bun: process.versions.bun,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpuInfo[0]?.model,
      logicalCpus: cpuInfo.length,
      memoryBytes: totalmem(),
    },
    config: {
      iterations,
      warmupIterations,
      sequential: true,
      duckDb: forceDuckDb || info.features.includes("duckdb"),
      ...(process.env.TC_BENCH_LABEL ? { label: process.env.TC_BENCH_LABEL } : {}),
      ...(process.env.TC_BENCH_NOTES ? { notes: process.env.TC_BENCH_NOTES } : {}),
    },
    records: records.length,
    summaries,
  };

  await writeFile(rawPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const summaryJson = JSON.stringify(summaryDocument, null, 2) + "\n";
  await writeFile(summaryPath, summaryJson);
  await appendCsv(summaryCsvPath, summaries);
  if (baselinePath) {
    await writeBaseline(baselinePath, summaryJson);
  }
  const dashboardPath = await writeDashboard({
    outputDir,
    baselineDir: process.env.TC_BENCH_BASELINE_DIR ?? join("benchmarks", "baselines"),
    baselinePaths: baselinePath ? [baselinePath] : [],
    dashboardPath:
      process.env.TC_BENCH_DASHBOARD_PATH ?? join(outputDir, "index.html"),
  });

  console.log(`[Bench] Wrote raw samples: ${rawPath}`);
  console.log(`[Bench] Wrote run summary: ${summaryPath}`);
  console.log(`[Bench] Appended plot index: ${summaryCsvPath}`);
  console.log(`[Bench] Wrote local dashboard: ${dashboardPath}`);
  console.table(
    summaries
      .filter(
        (summary) =>
          summary.source === "manual" ||
          (summary.source === "http" && summary.span.includes(".http.headers.")),
      )
      .map((summary) => ({
        span: summary.span,
        source: summary.source,
        count: summary.count,
        meanMs: summary.meanMs.toFixed(2),
        p50Ms: summary.p50Ms.toFixed(2),
        p95Ms: summary.p95Ms.toFixed(2),
        p99Ms: summary.p99Ms.toFixed(2),
        maxMs: summary.maxMs.toFixed(2),
      })),
  );
}

async function writeBaseline(path: string, contents: string): Promise<void> {
  await assertBaselineWritable(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  console.log(`[Bench] Wrote named baseline: ${path}`);
}

async function assertBaselineWritable(path: string): Promise<void> {
  if ((await Bun.file(path).exists()) && !overwriteBaseline) {
    throw new Error(
      `Baseline already exists at ${path}. Set TC_BENCH_OVERWRITE_BASELINE=true to replace it.`,
    );
  }
}

function gitRevision(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function gitBranch(): string | undefined {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function gitDirty(): boolean | undefined {
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().length > 0;
  } catch {
    return undefined;
  }
}

async function appendCsv(path: string, summaries: SpanSummary[]): Promise<void> {
  const header = [
    "timestamp",
    "runId",
    "server",
    "span",
    "source",
    "count",
    "okCount",
    "errorCount",
    "minMs",
    "meanMs",
    "p50Ms",
    "p95Ms",
    "p99Ms",
    "maxMs",
  ];
  const rows = summaries.map((summary) =>
    [
      summary.timestamp,
      summary.runId,
      summary.server,
      summary.span,
      summary.source,
      summary.count,
      summary.okCount,
      summary.errorCount,
      summary.minMs,
      summary.meanMs,
      summary.p50Ms,
      summary.p95Ms,
      summary.p99Ms,
      summary.maxMs,
    ]
      .map(csvCell)
      .join(","),
  );

  let needsHeader = false;
  try {
    const file = Bun.file(path);
    needsHeader = !(await file.exists()) || file.size === 0;
  } catch {
    needsHeader = true;
  }

  await appendFile(path, `${needsHeader ? `${header.join(",")}\n` : ""}${rows.join("\n")}\n`);
}

function csvCell(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toFixed(3) : "";
  }
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

main()
  .catch((error) => {
    console.error("[Bench] Failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch as typeof globalThis.fetch;
  });
