export type SharePublishFailure =
  | { readonly kind: "owner-space-unresolved"; readonly localKey?: boolean }
  | { readonly kind: "scope-denied"; readonly capability: "KV upload" | "sharing delegation"; readonly requiredAction?: "tinycloud.kv/put" | "tinycloud.kv/get" }
  | { readonly kind: "lifetime-exceeds-session"; readonly sessionExpiresAt: Date }
  | { readonly kind: "origin-mismatch" };

export class SharePublishAuthorityError extends Error {
  constructor(readonly failure: SharePublishFailure) {
    super(failure.kind);
    this.name = "SharePublishAuthorityError";
  }
}
