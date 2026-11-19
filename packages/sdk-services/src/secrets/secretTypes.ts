/**
 * What a secret is, so a client can render it the right way. `secret` is the
 * default: a secret with no stored type, or one this client does not know, is
 * a `secret`.
 */
export const SECRET_TYPES = ["secret", "totp", "username", "password"] as const;

export type SecretType = (typeof SECRET_TYPES)[number];

export const DEFAULT_SECRET_TYPE: SecretType = "secret";

export function isSecretType(value: unknown): value is SecretType {
  return SECRET_TYPES.some((type) => type === value);
}

/** The type a client should show for a stored payload. */
export function secretTypeOf(payload: { type?: string | undefined }): SecretType {
  return isSecretType(payload.type) ? payload.type : DEFAULT_SECRET_TYPE;
}
