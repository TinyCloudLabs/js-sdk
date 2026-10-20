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
  /** The node's version cannot be verified for domain invite delivery. */
  | { readonly kind: "node-info-unavailable" }
  /** The registry refused the record (other 4xx, or an invalid record): a retry cannot succeed. */
  | { readonly kind: "registry-rejected" }
  /** Storage is full or too small for the upload; account totals only when the SDK reported them. */
  | ({ readonly kind: "storage-full" } & StorageRejection)
  | { readonly kind: "upload-failed" }
  /** The Node answered a share upload 404 "Space not found": the owner space has no row there. Retryable. */
  | { readonly kind: "space-not-ready" };

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

/** Why a published share was not written to sender history. Stable codes for scripts; never carry paths or key material. */
export type ShareHistoryReason = "HISTORY_UNREADABLE" | "HISTORY_WRITE_FAILED" | "HISTORY_UNAVAILABLE";

export type ShareHistoryStatus =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly reason: ShareHistoryReason };

const HISTORY_WRITE_ERROR_CODES: Readonly<Record<string, true>> = { EACCES: true, EPERM: true, EROFS: true, ENOSPC: true, EDQUOT: true, EIO: true };

/** Maps a sender-history failure to its reason. The adapter reports an existing file it cannot decrypt or parse as "share history is unavailable"; filesystem write errors keep their errno code. Anything else is HISTORY_UNAVAILABLE. */
export function shareHistoryReason(error: unknown): ShareHistoryReason {
  if (error instanceof Error && error.message === "share history is unavailable") return "HISTORY_UNREADABLE";
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && HISTORY_WRITE_ERROR_CODES[code] === true ? "HISTORY_WRITE_FAILED" : "HISTORY_UNAVAILABLE";
}
