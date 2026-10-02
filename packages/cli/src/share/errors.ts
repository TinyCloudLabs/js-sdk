export type SharePublishFailure =
  | { readonly kind: "owner-space-unresolved"; readonly localKey?: boolean; readonly profileName?: string }
  | { readonly kind: "scope-denied"; readonly capability: "KV upload" | "sharing delegation"; readonly requiredAction?: "tinycloud.kv/put" | "tinycloud.kv/get"; readonly localKey?: boolean; readonly profileName?: string }
  | { readonly kind: "lifetime-exceeds-session"; readonly sessionExpiresAt: Date; readonly reason: "beyond-session" | "below-minimum" | "session-too-close"; readonly localKey?: boolean; readonly profileName?: string }
  | { readonly kind: "origin-mismatch" }
  /** A share-sdk preflight refusal; `reason` is a fixed SDK message, never remote text. */
  | { readonly kind: "invalid-request"; readonly reason: string }
  | { readonly kind: "registry-unavailable" };

export class SharePublishAuthorityError extends Error {
  constructor(readonly failure: SharePublishFailure) {
    super(failure.kind);
    this.name = "SharePublishAuthorityError";
  }
}
