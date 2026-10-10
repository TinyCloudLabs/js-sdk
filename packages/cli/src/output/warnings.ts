import type { OperationWarningOutput } from "./formatter.js";

// The entry and legacy command graph are separate bundles. Keep the sink on
// globalThis so either copy can record or drain the same command's warnings.
const PENDING_WARNINGS = Symbol.for("tinycloud.cli.pendingWarnings.v1");
type WarningHolder = { [PENDING_WARNINGS]?: OperationWarningOutput[] };

function warningKey(warning: OperationWarningOutput): string {
  return JSON.stringify([warning.code, warning.reason, warning.grantCid ?? null]);
}
export function mergeWarnings<Warning extends OperationWarningOutput>(
  first: readonly Warning[],
  second: readonly Warning[],
): Warning[] {
  const merged = [...first];
  const counts = new Map<string, number>();
  for (const warning of first) {
    const key = warningKey(warning);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const warning of second) {
    const key = warningKey(warning);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    if (occurrence > (counts.get(key) ?? 0)) merged.push(warning);
  }
  return merged;
}

export function recordWarnings(warnings: readonly OperationWarningOutput[]): void {
  if (warnings.length === 0) return;
  const holder = globalThis as WarningHolder;
  holder[PENDING_WARNINGS] = mergeWarnings(holder[PENDING_WARNINGS] ?? [], warnings);
}

export function drainWarnings(): OperationWarningOutput[] {
  const holder = globalThis as WarningHolder;
  const warnings = holder[PENDING_WARNINGS] ?? [];
  delete holder[PENDING_WARNINGS];
  return warnings;
}

export function discardWarnings(cid: string): void {
  const holder = globalThis as WarningHolder;
  if (holder[PENDING_WARNINGS]) {
    holder[PENDING_WARNINGS] = holder[PENDING_WARNINGS].filter((warning) => warning.grantCid !== cid);
  }
}
