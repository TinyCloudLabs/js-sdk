import type { StorageStatus, StorageUsage, StorageUsageState } from "@tinycloud/sdk-core";
import { STORAGE_MANAGE_URL } from "./manage-url";

/**
 * Pure view-state reducer for the storage section. No DOM, no strings.
 * Numbers are shown only for `known` and `unlimited`; every other state
 * renders words, never a 0 or a full bar.
 */

/** The shape `client.storage.status()` resolves to, with the error code kept open. */
export type StorageResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string };

/** The `manageUrl` in a status value, if it is https. The constant otherwise. */
export function manageHrefFor(value: unknown): string {
  if (typeof value !== "object" || value === null || !("manageUrl" in value)) return STORAGE_MANAGE_URL;
  const url: unknown = value.manageUrl;
  if (typeof url !== "string") return STORAGE_MANAGE_URL;
  try {
    return new URL(url).protocol === "https:" ? url : STORAGE_MANAGE_URL;
  } catch {
    return STORAGE_MANAGE_URL;
  }
}

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

const UNAVAILABLE_CODES: Readonly<Record<string, true>> = {
  unsupported: true,
  STORAGE_STATUS_UNAVAILABLE: true,
};

/** Failure codes that mean this node cannot report usage at all, so retrying will not help. */
export function isUnavailableCode(code: string): boolean {
  return UNAVAILABLE_CODES[code] === true;
}

function isByteCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function isUsage(value: unknown): value is StorageUsage {
  if (typeof value !== "object" || value === null) return false;
  if (!("usedBytes" in value) || !("limitBytes" in value)) return false;
  return isByteCount(value.usedBytes) && (value.limitBytes === null || isByteCount(value.limitBytes));
}

function isUsageState(value: unknown): value is StorageUsageState {
  return value === "ok" || value === "nearly_full" || value === "full";
}

/** Narrow an untrusted body to a usable status; anything else is unavailable. */
export function isStorageStatus(value: unknown): value is StorageStatus {
  if (!isUsage(value)) return false;
  if (!("state" in value) || !isUsageState(value.state)) return false;
  // `account` is the budget the owner is held to: a malformed one is as unusable as a malformed top level.
  return !("account" in value) || value.account === undefined || isUsage(value.account);
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
 * Outcome of the needs-permission action. Approval refetches (back to loading).
 * A refusal without a code, or with `declined`, settles on `declined` with no
 * automatic retry. `unsupported` is a node/authority limit, not a user choice,
 * so it is unavailable. Any other code keeps that code and offers Retry.
 */
export function afterAuthority(outcome: {
  readonly approved: boolean;
  readonly code?: string;
}): StorageViewState {
  if (outcome.approved) return { kind: "loading" };
  if (outcome.code === undefined || outcome.code === "declined") return { kind: "declined" };
  if (outcome.code === "unsupported") return { kind: "unavailable" };
  return { kind: "error", code: outcome.code };
}

/** The button the panel offers for a view. `allow` and `try_again` ask for authority; `retry` re-reads. */
export type StorageAction = "allow" | "try_again" | "retry";

/** Byte amounts shown with a number. Only `known` and `unlimited` carry one. */
export interface StorageUsageView {
  readonly key: "storage.usage.known" | "storage.usage.unlimited";
  readonly usedBytes: number;
  readonly limitBytes?: number;
  /** Bar fill, 0 to 100. Only for `known`. */
  readonly percent?: number;
}

/** Copy keys and numbers for one render. Keys, not strings: the section looks them up. */
export interface StorageModel {
  readonly wordKey?: string;
  readonly noteKey?: string;
  readonly usage?: StorageUsageView;
  readonly action?: StorageAction;
}

const STATE_KEYS: Readonly<Record<StorageUsageState, string>> = {
  ok: "storage.state.ok",
  nearly_full: "storage.state.nearly_full",
  full: "storage.state.full",
};

const ERROR_KEYS: ReadonlyMap<string, string> = new Map([
  ["NETWORK_ERROR", "storage.error.network"],
  ["AUTH_UNAUTHORIZED", "storage.error.auth"],
]);

function percentFull(usedBytes: number, limitBytes: number): number {
  if (limitBytes <= 0) return 100;
  return Math.min(100, Math.round((usedBytes * 100) / limitBytes));
}

function viewModel(view: StorageViewState, canAsk: boolean): StorageModel {
  switch (view.kind) {
    case "signed_out":
      return {};
    case "loading":
      return { wordKey: "storage.checking" };
    case "known":
      return {
        wordKey: STATE_KEYS[view.state],
        usage: {
          key: "storage.usage.known",
          usedBytes: view.usedBytes,
          limitBytes: view.limitBytes,
          percent: percentFull(view.usedBytes, view.limitBytes),
        },
      };
    case "unlimited":
      return {
        wordKey: "storage.state.unlimited",
        usage: { key: "storage.usage.unlimited", usedBytes: view.usedBytes },
      };
    case "needs_permission":
      // Without an authority request the panel has nothing to ask, so it states the need and stops.
      return canAsk ? { noteKey: "storage.permission", action: "allow" } : { noteKey: "storage.permission" };
    case "declined":
      return { noteKey: "storage.declined", action: "try_again" };
    case "unavailable":
      return { noteKey: "storage.unavailable" };
    case "error":
      return {
        noteKey: ERROR_KEYS.get(view.code) ?? "storage.error.generic",
        action: "retry",
      };
  }
}

/**
 * What the panel renders for a view. An own-storage episode (`storage.full` fired
 * and no successful write since) wins over the status read: it shows the full word
 * and drops numbers, because a 413 can arrive while status still says `ok` (contract §3.3).
 * The note and action of a failed read stay, so the user can still retry.
 */
export function storageModel(view: StorageViewState, episodeOn: boolean, canAsk: boolean): StorageModel {
  const base = viewModel(view, canAsk);
  if (!episodeOn || view.kind === "signed_out") return base;
  return { wordKey: "storage.state.full", noteKey: base.noteKey, action: base.action };
}
