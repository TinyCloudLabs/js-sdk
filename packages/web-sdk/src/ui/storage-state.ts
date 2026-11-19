import type { StorageStatus, StorageUsage, StorageUsageState } from "@tinycloud/sdk-core";
import { STORAGE_MANAGE_URL } from "./manage-url";

/**
 * Pure checks the Storage page, the storage-full part and the live adapter share. No DOM, no strings.
 * An untrusted body is a status only when every number is a non-negative safe integer and the state is known.
 */

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
