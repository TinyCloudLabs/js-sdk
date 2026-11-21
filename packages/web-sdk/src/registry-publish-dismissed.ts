// TC-3547: persist the owner's "Not now" decision for the publish consent so the
// Home / tinycloud.one "finish setup" banner stays dismissed across reloads.
//
// Storage is `localStorage` keyed by the owner's `did:pkh`, per Naomi 14:20:13Z.
// The earlier design put the flag in the owner's account-registry KV, but that
// space's SIWE recap (`ACCOUNT_MANIFEST_PERMISSIONS` in `packages/bootstrap/src/index.ts`)
// does not cover a `system/registry-publish/dismissed/` path, so a real node would
// refuse the write. `localStorage` also serves TinyChat's intended config
// (`autoBootstrapAccount: false` + `includeAccountRegistryPermissions: false`), which
// drops the account-registry recap entirely. Per-device dismissal is acceptable
// because the `?finish-setup=registry` URL intent (TC-3547 Soren §11.1, Bobbie
// 13:27:14Z) still bypasses it on a new device or a reset browser.
//
// This module is dynamic-import()'d from the registry-publish module, which is
// itself dynamic-import()'d from tcw.ts. Nothing here lands in the root web-sdk
// chunk.

const LOCAL_STORAGE_PREFIX = "tcw.tc3547.dismissed.";

/** Byte-identical key format used across reads and writes. Exported for tests only. */
export function dismissedStorageKey(subject: string): string {
  return `${LOCAL_STORAGE_PREFIX}${subject.toLowerCase()}`;
}

/**
 * Minimal localStorage shape accepted here. The browser's `Storage` satisfies it;
 * tests pass their own in-memory object. We never ask for `length`, iterate the
 * store, or interact with other keys.
 */
export interface DismissedFlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

interface DismissedFlagEnvelope {
  dismissed: boolean;
  at: string; // ISO-8601, for diagnosing when the "Not now" was recorded
}

function globalLocalStorage(): DismissedFlagStorage | undefined {
  // `localStorage` throws in SSR, private-browsing in some engines, or when the
  // storage partition rejects access. Treat every failure as "no storage available"
  // and let the caller decide ("not dismissed" fail-open).
  try {
    const candidate = (globalThis as { localStorage?: DismissedFlagStorage }).localStorage;
    return candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function"
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns true only when the owner previously declined the publish consent on this device.
 * Any failure (missing storage, unreadable value, quota reset, mangled JSON) returns false so
 * the host still gets to prompt once.
 */
export function readRegistryPublishDismissed(subject: string, storage: DismissedFlagStorage | undefined = globalLocalStorage()): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(dismissedStorageKey(subject));
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && "dismissed" in parsed && (parsed as DismissedFlagEnvelope).dismissed === true;
  } catch {
    return false;
  }
}

/**
 * Persist the owner's "Not now" decision on this device. Silently no-ops if storage is
 * unavailable or the write fails (quota, private mode, SecurityError in cross-origin
 * frames). Sign-in is never failed by a dismissed-flag write; the only consequence of a
 * silent no-op is that the host's "finish setup" banner shows once more on the next visit.
 */
export function writeRegistryPublishDismissed(subject: string, storage: DismissedFlagStorage | undefined = globalLocalStorage()): void {
  if (!storage) return;
  try {
    const envelope: DismissedFlagEnvelope = { dismissed: true, at: new Date().toISOString() };
    storage.setItem(dismissedStorageKey(subject), JSON.stringify(envelope));
  } catch {
    // SecurityError, QuotaExceededError, cross-origin storage denial — all intentional no-ops.
  }
}
