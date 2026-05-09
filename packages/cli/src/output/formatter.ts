import ora from "ora";
import { theme } from "./theme.js";

export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export function outputError(code: string, message: string, hint?: string): void {
  if (isInteractive()) {
    process.stderr.write(
      `${theme.error("✗")} ${theme.label(code)}: ${message}\n`
    );
    if (hint) {
      for (const line of hint.split("\n")) {
        process.stderr.write(`  ${theme.hint(line)}\n`);
      }
    }
  } else {
    const payload: { error: { code: string; message: string; hint?: string } } = {
      error: { code, message },
    };
    if (hint) payload.error.hint = hint;
    process.stderr.write(JSON.stringify(payload, null, 2) + "\n");
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY);
}

export async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!isInteractive()) {
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

/** Check if output should be JSON (non-TTY or --json flag) */
export function shouldOutputJson(): boolean {
  return !isInteractive() || process.argv.includes("--json");
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
