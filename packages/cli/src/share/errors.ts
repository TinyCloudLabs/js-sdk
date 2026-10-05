import type { StorageRejection } from "../output/storage.js";

export type SharePublishFailure =
  | { readonly kind: "owner-space-unresolved"; readonly localKey?: boolean; readonly profileName?: string }
  | { readonly kind: "scope-denied"; readonly capability: "KV upload" | "sharing delegation"; readonly requiredAction?: "tinycloud.kv/put" | "tinycloud.kv/get"; readonly localKey?: boolean; readonly profileName?: string }
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
  | { readonly kind: "upload-failed" };

export class SharePublishAuthorityError extends Error {
  constructor(readonly failure: SharePublishFailure) {
    super(failure.kind);
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
