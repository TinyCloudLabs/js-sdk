export const CREDENTIAL_ERROR_CODES = [
  "ACTIVE_SESSION_REQUIRED",
  "CANCELED",
  "DESCRIPTOR_INVALID",
  "HOLDER_MISMATCH",
  "ISSUER_UNREADY",
  "OFFLINE",
  "POPUP_BLOCKED",
  "REQUEST_EXPIRED",
  "REQUEST_SUBSTITUTED",
  "SIGNATURE_REJECTED",
  "UNSUPPORTED_PROFILE",
  "UNSUPPORTED_VERSION",
  "VERIFICATION_FAILED",
  "VERIFIED_NOT_SAVED",
] as const;

export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number];

const RECOVERABLE = new Set<CredentialErrorCode>([
  "CANCELED",
  "ISSUER_UNREADY",
  "OFFLINE",
  "POPUP_BLOCKED",
  "REQUEST_EXPIRED",
  "SIGNATURE_REJECTED",
  "VERIFIED_NOT_SAVED",
]);

/** Stable, redaction-safe error returned by the credential acquisition module. */
export class CredentialError extends Error {
  readonly name = "CredentialError";
  readonly recoverable: boolean;

  constructor(
    readonly code: CredentialErrorCode,
    message: string,
    readonly details: {
      readonly retryAfterMs?: number;
      readonly state?: string;
      readonly correlationId?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message);
    this.recoverable = RECOVERABLE.has(code);
  }
}

export function credentialError(
  value: unknown,
  fallbackCode: CredentialErrorCode = "VERIFICATION_FAILED",
): CredentialError {
  if (value instanceof CredentialError) return value;
  if (value instanceof DOMException && value.name === "AbortError") {
    return new CredentialError("CANCELED", "Credential acquisition was canceled", { cause: value });
  }
  return new CredentialError(fallbackCode, "Credential acquisition failed", { cause: value });
}
