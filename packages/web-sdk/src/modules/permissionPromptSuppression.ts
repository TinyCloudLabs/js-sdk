import type { Manifest } from "@tinycloud/sdk-core";

const STORAGE_PREFIX = "tinycloud:permission-prompt-suppression:";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface SuppressionRecord {
  expiresAt: number;
}

interface SuppressionOptions {
  storage?: Storage;
  now?: () => number;
  pageScope?: string;
}

function defaultStorage(): Storage | undefined {
  return typeof globalThis.localStorage !== "undefined"
    ? globalThis.localStorage
    : undefined;
}

function defaultPageScope(): string {
  if (typeof globalThis.location === "undefined") {
    return "unknown-page";
  }

  return `${globalThis.location.origin}${globalThis.location.pathname}`;
}

function storageKey(manifest: Manifest, pageScope: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(pageScope)}:${encodeURIComponent(
    manifest.app_id,
  )}`;
}

export function isPermissionPromptSuppressed(
  manifest: Manifest,
  options: SuppressionOptions = {},
): boolean {
  const storage = options.storage ?? defaultStorage();
  if (!storage) return false;

  const key = storageKey(
    manifest,
    options.pageScope ?? defaultPageScope(),
  );
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return false;
  }
  if (!raw) return false;

  try {
    const parsed = JSON.parse(raw) as SuppressionRecord;
    const now = options.now?.() ?? Date.now();
    if (
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= now
    ) {
      try {
        storage.removeItem(key);
      } catch {
        // A failed cleanup should not block the permission flow.
      }
      return false;
    }
    return true;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // A failed cleanup should not block the permission flow.
    }
    return false;
  }
}

export function suppressPermissionPromptFor30Days(
  manifest: Manifest,
  options: SuppressionOptions = {},
): void {
  const storage = options.storage ?? defaultStorage();
  if (!storage) return;

  const now = options.now?.() ?? Date.now();
  const key = storageKey(
    manifest,
    options.pageScope ?? defaultPageScope(),
  );
  try {
    storage.setItem(
      key,
      JSON.stringify({ expiresAt: now + THIRTY_DAYS_MS }),
    );
  } catch {
    // Storage is a convenience for suppressing this SDK prompt. If it is
    // unavailable, the grant itself should still succeed.
  }
}
