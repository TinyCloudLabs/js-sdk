import type { StatusCode, SyncEffective } from "./slots";

/** Highest priority first. The button dot and panel header show the first status present. */
export const STATUS_PRIORITY: readonly StatusCode[] = ["storage_full", "sync_pending", "sync_attention"];

const SYNC_EFFECTIVE: Record<SyncEffective, true> = {
  off: true,
  enabling: true,
  on: true,
  wiping: true,
  pending: true,
  unavailable: true,
};

/** Unknown effective values are treated as `unavailable`. */
export function normalizeSyncEffective(value: unknown): SyncEffective {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(SYNC_EFFECTIVE, value)) {
    return value as SyncEffective;
  }
  return "unavailable";
}

/** Status for the sync section: pending always; unavailable only when the user asked for sync. */
export function syncStatus(effective: unknown, requested: boolean): StatusCode | null {
  const state = normalizeSyncEffective(effective);
  if (state === "pending") return "sync_pending";
  if (state === "unavailable" && requested) return "sync_attention";
  return null;
}

export function highestStatus(statuses: Iterable<StatusCode | null>): StatusCode | null {
  const present = new Set<StatusCode>();
  for (const status of statuses) {
    if (status !== null) present.add(status);
  }
  return STATUS_PRIORITY.find((status) => present.has(status)) ?? null;
}

/**
 * Per-source status. `onChange` fires only when the highest-priority status changes.
 */
export function createStatusBoard(onChange: (top: StatusCode | null) => void) {
  const bySource = new Map<string, StatusCode | null>();
  let top: StatusCode | null = null;

  return {
    set(source: string, status: StatusCode | null): void {
      if (status === null) bySource.delete(source);
      else bySource.set(source, status);
      const next = highestStatus(bySource.values());
      if (next !== top) {
        top = next;
        onChange(top);
      }
    },
    top(): StatusCode | null {
      return top;
    },
  };
}
