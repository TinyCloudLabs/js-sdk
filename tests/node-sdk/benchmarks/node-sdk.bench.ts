import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TinyCloudNode, type TelemetrySpanEvent } from "@tinycloud/node-sdk";
import { checkServerHealth, SERVER_URL, TEST_KEY } from "../setup";

type BenchmarkSource = "manual" | "telemetry";

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
const records: BenchmarkRecord[] = [];

let currentBenchmark = "setup";
let currentIteration = -1;

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
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.data;
}

async function serverFeatures(): Promise<string[]> {
  const response = await fetch(`${SERVER_URL}/info`);
  if (!response.ok) {
    return [];
  }
  const info = (await response.json()) as { features?: unknown };
  return Array.isArray(info.features)
    ? info.features.filter((feature): feature is string => typeof feature === "string")
    : [];
}

async function main(): Promise<void> {
  await checkServerHealth();
  const features = await serverFeatures();
  const includeDuckDb = forceDuckDb || features.includes("duckdb");

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

  await writeResults();
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

async function writeResults(): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const rawPath = join(outputDir, `${runId}.jsonl`);
  const summaryPath = join(outputDir, `${runId}.summary.json`);
  const summaryCsvPath = join(outputDir, "summary.csv");
  const summaries = summarize(records);

  await writeFile(rawPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        runId,
        timestamp,
        server: SERVER_URL,
        iterations,
        warmupIterations,
        records: records.length,
        summaries,
      },
      null,
      2,
    ) + "\n",
  );
  await appendCsv(summaryCsvPath, summaries);

  console.log(`[Bench] Wrote raw samples: ${rawPath}`);
  console.log(`[Bench] Wrote run summary: ${summaryPath}`);
  console.log(`[Bench] Appended plot index: ${summaryCsvPath}`);
  console.table(
    summaries
      .filter((summary) => summary.source === "manual")
      .map((summary) => ({
        span: summary.span,
        count: summary.count,
        meanMs: summary.meanMs.toFixed(2),
        p95Ms: summary.p95Ms.toFixed(2),
        maxMs: summary.maxMs.toFixed(2),
      })),
  );
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

main().catch((error) => {
  console.error("[Bench] Failed:", error);
  process.exit(1);
});
