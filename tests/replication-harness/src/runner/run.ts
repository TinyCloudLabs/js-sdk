import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactValue } from "./redact";
import { AssertionFailure, ScenarioSkip } from "./context";
import type { Clock } from "../contracts/clock";
import type { RunReport, ScenarioResult } from "../contracts/report";
import { writeLegReport } from "./report-json";
import type { ScenarioRow } from "./registry";
import type { Backend, SetId, Tier } from "../contracts/common";
import { scheduleRows, runWithDeadline } from "./schedule";
import { applyQuarantine, loadQuarantine, type QuarantineEntry } from "./quarantine";
import { initialResult, summarize } from "./status";
import { installInterruptHandler, type InterruptTarget } from "./signals";

export type RunRowsOptions = {
  rows: readonly ScenarioRow[]; clock: Clock; concurrency: number; abortGraceMs?: number; finalizeTimeoutMs?: number; runSignal?: AbortSignal;
  executeRow(row: ScenarioRow, signal: AbortSignal): Promise<ScenarioResult>;
  quarantine?: readonly QuarantineEntry[]; report: Omit<RunReport, "results" | "summary" | "quarantined" | "interrupted" | "finishedAt" | "durationMs">;
  reportDirectory: string; secrets?: readonly string[]; finalizeRow?(row: ScenarioRow, result: ScenarioResult, signal: AbortSignal): Promise<void>;
};
export type RunRowsOutput = { report: RunReport; interrupted: boolean };

/** Shared S3b hook: executes an already selected leg and writes schema-validated leg reports. */
export async function runRows(options: RunRowsOptions): Promise<RunRowsOutput> {
  const started = options.clock.now();
  const startWall = options.clock.wallNow();
  let interrupted = false;
  const results: ScenarioResult[] = [];
  const addRow = async (row: ScenarioRow): Promise<ScenarioResult> => {
    if (options.runSignal?.aborted) {
      interrupted = true;
      return initialResult(row, row.key.replaceAll(/[^A-Za-z0-9_.-]/g, "_"), "error", "INTERRUPTED");
    }
    if (row.reason) return initialResult(row, row.key.replaceAll(/[^A-Za-z0-9_.-]/g, "_"), row.unavailableStatus ?? "skipped", row.reason);
    let result: ScenarioResult;
    let timedOut = false;
    let cancelled = false;
    try {
      const timed = await runWithDeadline(options.clock, row.scenario.timeoutMs, options.abortGraceMs ?? 5000,
        options.runSignal, (signal) => options.executeRow(row, signal));
      timedOut = timed.timedOut;
      cancelled = timed.timedOut && timed.cancelled;
      result = cancelled
        ? initialResult(row, row.key.replaceAll(/[^A-Za-z0-9_.-]/g, "_"), "error", "INTERRUPTED")
        : timed.value ?? initialResult(row, row.key.replaceAll(/[^A-Za-z0-9_.-]/g, "_"), "error", "DEADLINE_EXCEEDED");
    } catch (error) {
      cancelled = options.runSignal?.aborted === true;
      interrupted ||= cancelled;
      const message = error instanceof Error ? error.message : String(error);
      if (cancelled) {
        result = initialResult(row, row.key.replaceAll(/[^A-Za-z0-9_.-]/g, "_"), "error", "INTERRUPTED");
      } else if (error instanceof ScenarioSkip) {
        const status = row.tier === "core" ? "error" : row.forcedUnsupported ? "xfail" : error.status;
        result = initialResult(row, row.key.replaceAll(/[^A-Za-z0-9_.-]/g, "_"), status, row.tier === "core" ? "CORE_STATUS_FORBIDDEN" : message);
      } else {
        const status = row.forcedUnsupported ? "xfail" : error instanceof AssertionFailure ? "fail" : "error";
        result = initialResult(row, row.key.replaceAll(/[^A-Za-z0-9_.-]/g, "_"), status, message);
      }
    }
    if (cancelled) {
      interrupted = true;
      result.status = "error";
      result.reason = "INTERRUPTED";
    } else if (timedOut) {
      result.status = row.forcedUnsupported ? "xfail" : "error";
      result.reason = "DEADLINE_EXCEEDED";
    } else if (row.forcedUnsupported) result.status = result.status === "pass" ? "xpass" : "xfail";
    if (row.tier === "core" && (result.status === "skipped" || result.status === "unsupported" || result.status === "xfail" || result.status === "xpass")) {
      result.status = "error";
      result.reason = "CORE_STATUS_FORBIDDEN";
    }
    if (options.finalizeRow) {
      const finalizeTimeoutMs = options.finalizeTimeoutMs ?? 60_000;
      try {
        const finalized = await runWithDeadline(options.clock, finalizeTimeoutMs, options.abortGraceMs ?? 5000, options.runSignal,
          (signal) => options.finalizeRow!(row, result, signal));
        if (finalized.timedOut) {
          interrupted ||= finalized.cancelled;
          result.status = "error";
          result.reason = finalized.cancelled ? "INTERRUPTED" : `FINALIZE_FAILED: deadline exceeded after ${finalizeTimeoutMs}ms`;
          result.teardown.errors.push(result.reason);
        }
      } catch (error) {
        result.status = "error";
        result.reason = `FINALIZE_FAILED: ${error instanceof Error ? error.message : String(error)}`;
        result.teardown.errors.push(result.reason);
      }
    }
    return result;
  };
  const core = options.rows.filter((row) => row.tier === "core");
  const preflights = core.filter((row) => row.id === "CORE-00");
  for (const preflight of preflights) results.push(await addRow(preflight));
  const preflightFailed = results.some((result) => result.id === "CORE-00" && result.status !== "pass");
  if (preflightFailed) {
    for (const row of core) if (row.id !== "CORE-00") results.push(initialResult(row, row.key.replaceAll(/[^A-Za-z0-9_.-]/g, "_"), "error", "PREFLIGHT_FAILED"));
  }
  const remaining = options.rows.filter((row) => !preflights.includes(row) && !(preflightFailed && row.tier === "core"));
  const scheduled = await scheduleRows(remaining, options.concurrency, addRow);
  results.push(...scheduled.map(({ value }) => value));
  if (options.runSignal?.aborted) interrupted = true;
  const quarantined = applyQuarantine(results, options.quarantine ?? await loadQuarantine());
  for (const result of results) {
    const rowDir = join(options.reportDirectory, result.artefactDir);
    const resultPath = join(rowDir, "result.json");
    const resultForFile = redactValue({ ...result, artefacts: result.artefacts.filter((file) => file.path !== "result.json") }, options.secrets ?? []);
    const bytes = Buffer.from(`${JSON.stringify(resultForFile, null, 2)}\n`);
    await mkdir(rowDir, { recursive: true });
    await writeFile(resultPath, bytes);
    result.artefacts = [...result.artefacts.filter((file) => file.path !== "result.json"),
      { path: "result.json", bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }];
  }
  const finishedAt = new Date(options.clock.wallNow()).toISOString();
  const report: RunReport = { ...options.report, startedAt: options.report.startedAt || new Date(startWall).toISOString(), finishedAt,
    durationMs: Math.max(0, options.clock.now() - started), interrupted, results, summary: summarize(results), quarantined,
    teardown: { leaked: results.flatMap((result) => result.teardown.leaked) } };
  await writeLegReport(report, options.reportDirectory, options.secrets);
  return { report, interrupted };
}
export async function runRowsWithInterrupt(options: Omit<RunRowsOptions, "runSignal">, target: InterruptTarget = process): Promise<RunRowsOutput> {
  const controller = new AbortController();
  const removeHandler = installInterruptHandler(controller, target);
  try { return await runRows({ ...options, runSignal: controller.signal }); }
  finally { removeHandler(); }
}

export function createRunReportBase(input: {
  kind?: "leg" | "adhoc"; runId: string; startedAt: string; tiers: Tier[]; set: SetId | null; only: string[] | null; backends: Backend[];
  concurrency: number; argv: string[]; filtered: boolean; subject: RunReport["subject"]; harnessSha: string;
  harnessDirty: boolean; inputsSha256?: string | null; manifestSha256?: string | null; environment: RunReport["environment"];
  sut: RunReport["sut"]; image: RunReport["image"];
}): RunRowsOptions["report"] {
  return { schema: "tc893.report/v1", kind: input.kind ?? "adhoc", runId: input.runId, startedAt: input.startedAt,
    invocation: { tiers: input.tiers, set: input.set, only: input.only, backends: input.backends, concurrency: input.concurrency,
      speedConcurrency: 1, argv: input.argv }, filtered: input.filtered, subject: input.subject,
    harnessSha: input.harnessSha, harnessDirty: input.harnessDirty, inputsSha256: input.inputsSha256 ?? null,
    manifestSha256: input.manifestSha256 ?? null, environment: input.environment, sut: input.sut, image: input.image, teardown: { leaked: [] } };
}
