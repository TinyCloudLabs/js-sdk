export type HeldCredentialErrorCode =
  | "bad-config"
  | "bad-issuer-set"
  | "bad-presentation"
  | "bad-header"
  | "did-method-not-allowed"
  | "issuer-not-accepted"
  | "unknown-issuer"
  | "issuer-not-yet-valid"
  | "issuer-stopped"
  | "bad-signature"
  | "bad-payload"
  | "issuer-retired"
  | "profile-not-accepted"
  | "profile-mismatch"
  | "not-yet-valid"
  | "expired"
  | "bad-lifetime"
  | "bad-status"
  | "bad-holder-binding"
  | "bad-subject"
  | "bad-disclosure"
  | "bad-siwe"
  | "bad-siwe-signature"
  | "bad-nonce"
  | "nonce-replayed"
  | "nonce-account-mismatch";

/** Every refusal is one of these. The code is stable; the message is for logs and never carries a credential. */
export class HeldCredentialError extends Error {
  readonly code: HeldCredentialErrorCode;
  constructor(code: HeldCredentialErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "HeldCredentialError";
    this.code = code;
  }
}

export function refuse(code: HeldCredentialErrorCode, message: string): never {
  throw new HeldCredentialError(code, message);
}
