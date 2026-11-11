import type { StorageRejection } from "../output/storage.js";

export type SharePublishFailure =
  | { readonly kind: "owner-space-unresolved"; readonly localKey?: boolean; readonly profileName?: string }
  | { readonly kind: "scope-denied"; readonly capability: "KV upload" | "sharing delegation" | "artifact storage"; readonly requiredAction?: "tinycloud.kv/put" | "tinycloud.kv/get" | "tinycloud.kv/list"; readonly localKey?: boolean; readonly profileName?: string }
  | { readonly kind: "caveated-session"; readonly profileName?: string }
  | { readonly kind: "lifetime-exceeds-session"; readonly sessionExpiresAt: Date; readonly reason: "beyond-session" | "below-minimum" | "session-too-close"; readonly localKey?: boolean; readonly profileName?: string }
  | { readonly kind: "origin-mismatch" }
  /** Preflight detail; any included node version must be sanitized. */
  | { readonly kind: "invalid-request"; readonly reason: string }
  /** Network failure, 5xx, 408 or 429: a retry can succeed. */
  | { readonly kind: "registry-unavailable" }
  /** The Share service's public config could not be fetched (network failure, timeout, or a non-OK answer). */
  | { readonly kind: "share-service-unavailable"; readonly origin: string }
  /** The node's version cannot be verified for domain invite delivery. */
  | { readonly kind: "node-info-unavailable" }
  /** The registry refused the record (other 4xx, or an invalid record): a retry cannot succeed. */
  | { readonly kind: "registry-rejected" }
  /** Storage is full or too small for the upload; account totals only when the SDK reported them. */
  | ({ readonly kind: "storage-full" } & StorageRejection)
  | { readonly kind: "upload-failed" }
  /** The Node answered a share upload 404 "Space not found": the owner space has no row there. Retryable. */
  | { readonly kind: "space-not-ready" }
  /** An addressed share's ceiling includes decrypt on the owner's encryption network; this session does not hold it. Refused before any upload or network call. */
  | { readonly kind: "decrypt-not-held" }
  /** The sealed envelope was over the link limit after the policy was registered; nothing was linked. `remaining` says what could not be removed. */
  | { readonly kind: "over-limit"; readonly remaining: readonly string[] };

export class SharePublishAuthorityError extends Error {
  constructor(readonly failure: SharePublishFailure, options?: { readonly cause?: unknown }) {
    super(failure.kind, options);
    this.name = "SharePublishAuthorityError";
  }
}

/** The pinned sender-history profile changed keys or disappeared mid-operation. */
export class ShareHistoryRetryError extends Error {
  readonly code = "SHARE_HISTORY_RETRY" as const;

  constructor(readonly profile: string) {
    super("sender history changed during the operation");
    this.name = "ShareHistoryRetryError";
  }
}

/** An existing sender-history file cannot be decrypted or parsed with the current session key. */
export class ShareHistoryUnreadableError extends Error {
  constructor() {
    super("share history is unavailable");
    this.name = "ShareHistoryUnreadableError";
  }
}

/** The filesystem refused or failed to read an existing sender-history file. */
export class ShareHistoryReadError extends Error {
  constructor() {
    super("share history could not be read");
    this.name = "ShareHistoryReadError";
  }
}

/** Why a published share was not written to sender history. Stable codes for scripts; never carry paths or key material. */
export type ShareHistoryReason = "HISTORY_UNREADABLE" | "HISTORY_READ_FAILED" | "HISTORY_WRITE_FAILED" | "HISTORY_UNAVAILABLE";

export type ShareHistoryStatus =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly reason: ShareHistoryReason };

const HISTORY_WRITE_ERROR_CODES: Readonly<Record<string, true>> = { EACCES: true, EPERM: true, EROFS: true, ENOSPC: true, EDQUOT: true, EIO: true };

/** Maps a sender-history failure to its reason. Decrypt or parse failures of an existing file are UNREADABLE; filesystem read errors are READ_FAILED; filesystem write errors keep their errno code as WRITE_FAILED. Anything else, including lock timeouts, is HISTORY_UNAVAILABLE. */
export function shareHistoryReason(error: unknown): ShareHistoryReason {
  if (error instanceof ShareHistoryUnreadableError) return "HISTORY_UNREADABLE";
  if (error instanceof ShareHistoryReadError) return "HISTORY_READ_FAILED";
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && HISTORY_WRITE_ERROR_CODES[code] === true ? "HISTORY_WRITE_FAILED" : "HISTORY_UNAVAILABLE";
}
