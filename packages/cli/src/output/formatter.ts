import ora from "ora";
import { theme } from "./theme.js";

export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

/** A skipped-grant (or other) diagnostic from an operation result: fixed codes only. */
export interface OperationWarningOutput {
  readonly code: string;
  readonly reason: string;
  readonly grantCid?: string;
}

function warningLine(warnings: readonly OperationWarningOutput[]): string {
  const which = warnings.map((warning) => `${warning.grantCid ?? "unidentified"}: ${warning.reason}`).join(", ");
  const subject = warnings.length === 1 ? "A stored grant was" : `${warnings.length} stored grants were`;
  return `${subject} not used (${which}). Approve access again when a command needs it; the old grant expires on its own.`;
}

/**
 * Write a command error to stderr. `meta` (validated authorization fields)
 * and `warnings` (fixed-code diagnostics) appear only in the JSON form; the
 * human form adds one warnings line.
 */
export function outputError(
  code: string,
  message: string,
  hint?: string,
  details: { readonly meta?: Record<string, unknown>; readonly warnings?: readonly OperationWarningOutput[] } = {},
): void {
  const { meta, warnings = [] } = details;
  if (!shouldOutputJson()) {
    process.stderr.write(
      `${theme.error("✗")} ${theme.label(code)}: ${message}\n`
    );
    if (hint) {
      for (const line of hint.split("\n")) {
        process.stderr.write(`  ${theme.hint(line)}\n`);
      }
    }
    if (warnings.length > 0) process.stderr.write(`  ${theme.warn(warningLine(warnings))}\n`);
  } else {
    const payload: {
      error: {
        code: string;
        message: string;
        hint?: string;
        meta?: Record<string, unknown>;
        warnings?: readonly OperationWarningOutput[];
      };
    } = {
      error: { code, message },
    };
    if (hint) payload.error.hint = hint;
    if (meta) payload.error.meta = meta;
    if (warnings.length > 0) payload.error.warnings = warnings;
    process.stderr.write(JSON.stringify(payload, null, 2) + "\n");
  }
}

/**
 * Report diagnostics of a successful command on stderr without breaking
 * machine-readable output: one JSON line in JSON mode (`--json`, or stdout
 * not a terminal), one human line otherwise. Call it only after the
 * command's output has been written.
 */
export function outputWarnings(warnings: readonly OperationWarningOutput[]): void {
  if (warnings.length === 0) return;
  process.stderr.write(shouldOutputJson()
    ? `${JSON.stringify({ warnings })}\n`
    : `${theme.warn("!")} ${warningLine(warnings)}\n`);
}

const WARNING_CODE = /^[A-Z][A-Z_]{0,63}$/;
const WARNING_REASON = /^[a-z][a-z_]{0,63}$/;
const DELEGATION_CID = /^bafkr4i[a-z2-7]{52}$/;

/**
 * The well-formed warnings of an operation result (or error metadata). Only
 * code-shaped values and delegation-CID-shaped identifiers are kept, so no
 * free text reaches stderr even if a producer misbehaves.
 */
export function operationWarnings(value: unknown): OperationWarningOutput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((warning: unknown): OperationWarningOutput[] => {
    if (warning === null || typeof warning !== "object") return [];
    const { code, reason, grantCid } = warning as Record<string, unknown>;
    if (typeof code !== "string" || !WARNING_CODE.test(code) || typeof reason !== "string" || !WARNING_REASON.test(reason)) {
      return [];
    }
    return [{ code, reason, ...(typeof grantCid === "string" && DELEGATION_CID.test(grantCid) ? { grantCid } : {}) }];
  });
}

export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY);
}

export async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // JSON mode keeps stderr machine-readable, even with stdout on a terminal.
  if (shouldOutputJson()) {
    return fn();
  }
  const spinner = ora(label).start();
  try {
    const result = await fn();
    spinner.succeed(label);
    return result;
  } catch (error) {
    spinner.fail(label);
    throw error;
  }
}

// The published CLI is two bundles (the entry and the lazily loaded command
// graph), each with its own copy of this module, so the flag lives on the
// process rather than in module state.
const JSON_REQUESTED = Symbol.for("tinycloud.cli.jsonOutputRequested");
type JsonFlagHolder = { [JSON_REQUESTED]?: boolean };

/**
 * Record the `--json` option as commander parsed it, so an operand after `--`
 * that happens to read `--json` does not switch the output mode.
 */
export function setJsonOutputRequested(requested: boolean): void {
  (globalThis as JsonFlagHolder)[JSON_REQUESTED] = requested;
}

/**
 * Whether output should be JSON: stdout is not a terminal, or `--json` was
 * given. Entry points that never record the parsed option fall back to argv.
 */
export function shouldOutputJson(): boolean {
  return !isInteractive() ||
    ((globalThis as JsonFlagHolder)[JSON_REQUESTED] ?? process.argv.includes("--json"));
}

/** Format a key-value pair for human display */
export function formatField(label: string, value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return `  ${theme.label(label + ":")} ${theme.muted("—")}`;
  if (typeof value === "boolean") {
    return `  ${theme.label(label + ":")} ${value ? theme.success("yes") : theme.muted("no")}`;
  }
  return `  ${theme.label(label + ":")} ${theme.value(String(value))}`;
}

/** Format a list of items as a simple table */
export function formatTable(headers: string[], rows: string[][]): string {
  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] || "").length))
  );

  const headerLine = headers.map((h, i) => theme.label(h.padEnd(widths[i]))).join("  ");
  const separator = widths.map(w => theme.dim("─".repeat(w))).join("  ");
  const dataLines = rows.map(row =>
    row.map((cell, i) => (cell || "").padEnd(widths[i])).join("  ")
  );

  return [headerLine, separator, ...dataLines].join("\n");
}

/** Output data in either JSON or human-friendly format */
export function output(data: unknown, humanFormatter?: () => string): void {
  if (shouldOutputJson() || !humanFormatter) {
    outputJson(data);
  } else {
    process.stdout.write(humanFormatter() + "\n");
  }
}

/** Format a status check line (for doctor command etc.) */
export function formatCheck(ok: boolean | "warn", label: string, detail?: string): string {
  const icon = ok === "warn" ? theme.warn("⚠") : ok ? theme.success("✓") : theme.error("✗");
  const detailStr = detail ? ` ${theme.muted(`(${detail})`)}` : "";
  return `${icon} ${label}${detailStr}`;
}

/** Format a section heading */
export function formatSection(title: string): string {
  return `\n${theme.heading(title)}`;
}

/** Format bytes to human readable */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format relative time */
export function formatTimeAgo(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
