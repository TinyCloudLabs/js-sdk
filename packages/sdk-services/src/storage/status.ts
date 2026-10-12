import type { Result } from "../types";

/** Where the owner frees up space or upgrades their plan. */
export const STORAGE_MANAGE_URL = "https://account.tinycloud.xyz/billing";

/** Storage counts as nearly full from this share of the limit. */
export const STORAGE_NEARLY_FULL_RATIO = 0.9;

export type StorageUsageState = "ok" | "nearly_full" | "full";

/** Byte counts as the node's usage read reports them; `null` limit means unlimited. */
export interface StorageUsage {
  usedBytes: number;
  limitBytes: number | null;
}

/**
 * The owner's TinyCloud storage, as `tc.storage.status()` reports it.
 * `usedBytes`/`limitBytes` describe the space that was asked about; its limit
 * is that space's share of the account budget.
 */
export interface StorageStatus extends StorageUsage {
  /** Account-wide totals; storage is one budget shared by all the owner's spaces. */
  account?: StorageUsage & { plan?: string };
  /** Plan tier id, e.g. `free` or `paid`, when known. */
  plan?: string;
  /** From the account totals when known, else from the space. */
  state: StorageUsageState;
  /** Where to free up space or upgrade. */
  manageUrl: string;
}

export interface StorageStatusOptions {
  /** Space name (e.g. `secrets`) or full space id. Defaults to the session's primary space. */
  space?: string;
}

/** `tc.storage.status()`: reads the owner's usage and plan from the node. */
export interface IStorageService {
  status(options?: StorageStatusOptions): Promise<Result<StorageStatus>>;
}

/** `full` at or over the limit, `nearly_full` from 90% of it; never full without a limit. */
export function storageUsageState(usedBytes: number, limitBytes: number | null): StorageUsageState {
  if (limitBytes === null) return "ok";
  if (usedBytes >= limitBytes) return "full";
  return usedBytes >= limitBytes * STORAGE_NEARLY_FULL_RATIO ? "nearly_full" : "ok";
}

function storageUsageOf(value: unknown): StorageUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { usedBytes, limitBytes } = value as Record<string, unknown>;
  const isByteCount = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!isByteCount(usedBytes)) return undefined;
  if (limitBytes !== null && !isByteCount(limitBytes)) return undefined;
  return { usedBytes, limitBytes };
}

/**
 * Parse the node's usage read (`tinycloud.space/info`):
 * `{space: {usedBytes, limitBytes}, account?: {usedBytes, limitBytes, plan?}, manageUrl}`.
 * Returns undefined when the body lacks the space numbers, e.g. a node that
 * predates the usage read.
 */
export function parseStorageStatus(body: unknown): StorageStatus | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const space = storageUsageOf(record.space);
  if (!space) return undefined;

  const status: StorageStatus = {
    ...space,
    state: storageUsageState(space.usedBytes, space.limitBytes),
    manageUrl:
      typeof record.manageUrl === "string" && record.manageUrl.startsWith("https://")
        ? record.manageUrl
        : STORAGE_MANAGE_URL,
  };
  const account = storageUsageOf(record.account);
  if (account) {
    const plan = (record.account as Record<string, unknown>).plan;
    status.account = typeof plan === "string" && plan !== "" ? { ...account, plan } : account;
    if (status.account.plan) status.plan = status.account.plan;
    status.state = storageUsageState(account.usedBytes, account.limitBytes);
  }
  return status;
}
