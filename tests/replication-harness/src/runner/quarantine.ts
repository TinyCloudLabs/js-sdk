import { readFile } from "node:fs/promises";
import type { ScenarioResult } from "../contracts/report";

export type QuarantineEntry = { key: string; ticket: string; reason: string };
export function validateQuarantine(value: unknown): QuarantineEntry[] {
  if (!Array.isArray(value)) throw new Error("quarantine.json must contain an array");
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("quarantine entry must be an object");
    const { key, ticket, reason } = entry as Record<string, unknown>;
    if (typeof key !== "string" || !/^[A-Z][A-Z0-9-]*(?:\[[A-Za-z0-9-]+\])?@(sqlite|pg16|pg16-c)$/.test(key)) throw new Error("quarantine entry has an invalid row key");
    if (seen.has(key)) throw new Error(`duplicate quarantine key ${key}`);
    seen.add(key);
    if (typeof ticket !== "string" || !/^(?:[A-Z][A-Z0-9]*-\d+|https?:\/\/\S+)$/.test(ticket)) throw new Error(`quarantine entry ${key} needs a ticket`);
    if (typeof reason !== "string" || reason.trim().length === 0) throw new Error(`quarantine entry ${key} needs a reason`);
    return { key, ticket, reason };
  });
}

export async function loadQuarantine(path = new URL("../../quarantine.json", import.meta.url)): Promise<QuarantineEntry[]> {
  return validateQuarantine(JSON.parse(await readFile(path, "utf8")));
}

export function applyQuarantine(results: ScenarioResult[], entries: readonly QuarantineEntry[]): string[] {
  const entryByKey = new Map(validateQuarantine(entries).map((entry) => [entry.key, entry]));
  const matched: string[] = [];
  for (const result of results) {
    const entry = entryByKey.get(result.key);
    if (!entry) continue;
    matched.push(result.key);
    // Keep the observed status: in particular, quarantined core scenarios remain visible to the gate.
    result.reason = result.reason ? `${result.reason}; quarantined (${entry.ticket}: ${entry.reason})` : `quarantined (${entry.ticket}: ${entry.reason})`;
  }
  return matched;
}
