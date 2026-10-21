import type { StorageStatus, StorageUsageState } from "@tinycloud/sdk-core";

/**
 * Pure view-state reducer for the storage section. No DOM, no strings.
 * Numbers are shown only for `known` and `unlimited`; every other state
 * renders words, never a 0 or a full bar.
 */

/** The shape `client.storage.status()` resolves to, with the error code kept open. */
export type StorageResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string };

export type StorageRead =
  | { readonly signedIn: false }
  | { readonly signedIn: true; readonly result?: StorageResult };

export type StorageViewState =
  | { readonly kind: "signed_out" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "known";
      readonly usedBytes: number;
      readonly limitBytes: number;
      readonly state: StorageUsageState;
    }
  | { readonly kind: "unlimited"; readonly usedBytes: number }
  | { readonly kind: "needs_permission" }
  | { readonly kind: "declined" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error"; readonly code: string };

const USAGE_STATES: readonly StorageUsageState[] = ["ok", "nearly_full", "full"];

const UNAVAILABLE_CODES: Readonly<Record<string, true>> = {
  unsupported: true,
  STORAGE_STATUS_UNAVAILABLE: true,
};

function isByteCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/** Narrow an untrusted body to a usable status; anything else is unavailable. */
export function isStorageStatus(value: unknown): value is StorageStatus {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!isByteCount(v.usedBytes)) return false;
  if (v.limitBytes !== null && !isByteCount(v.limitBytes)) return false;
  return typeof v.state === "string" && USAGE_STATES.includes(v.state as StorageUsageState);
}

/** Reduce a read to the view. `loading` covers the in-flight read. */
export function reduceStorage(read: StorageRead): StorageViewState {
  if (!read.signedIn) return { kind: "signed_out" };
  const result = read.result;
  if (result === undefined) return { kind: "loading" };
  if (result.ok === false) {
    if (result.code === "PERMISSION_DENIED") return { kind: "needs_permission" };
    if (UNAVAILABLE_CODES[result.code]) return { kind: "unavailable" };
    return { kind: "error", code: result.code };
  }
  if (!isStorageStatus(result.value)) return { kind: "unavailable" };

  // Account totals are the budget the owner is held to; fall back to the space.
  const usage = result.value.account ?? result.value;
  if (usage.limitBytes === null) return { kind: "unlimited", usedBytes: usage.usedBytes };
  return {
    kind: "known",
    usedBytes: usage.usedBytes,
    limitBytes: usage.limitBytes,
    state: result.value.state,
  };
}

/**
 * Outcome of the needs-permission action. Approval refetches (back to loading);
 * refusal settles on `declined` with no automatic retry.
 */
export function afterAuthority(outcome: { readonly approved: boolean }): StorageViewState {
  return outcome.approved ? { kind: "loading" } : { kind: "declined" };
}
