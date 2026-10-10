import type { Status } from "../contracts/scenario";
import type { ScenarioRow } from "./registry";
import type { ScenarioResult } from "../contracts/report";

export function emptySummary(): Record<Status, number> {
  return { pass: 0, fail: 0, error: 0, skipped: 0, unsupported: 0, xfail: 0, xpass: 0 };
}
export function summarize(results: readonly ScenarioResult[]): Record<Status, number> {
  const summary = emptySummary();
  for (const result of results) summary[result.status]++;
  return summary;
}
export function initialResult(row: ScenarioRow, artefactDir: string, status: Status, reason: string): ScenarioResult {
  return { key: row.key, id: row.id, variant: row.variant, backend: row.backend, tier: row.tier, sets: row.sets, status, reason,
    durationMs: 0, assertions: [], metrics: [], artefactDir, artefacts: [], teardown: { leaked: [], errors: [] } };
}
export function rowKey(id: string, variant: string | null, backend: string): string {
  return `${id}${variant === null ? "" : `[${variant}]`}@${backend}`;
}
