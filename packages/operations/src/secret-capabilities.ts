export type SecretCapabilityAction = "get" | "put" | "del" | "list";

/** Capability vocabulary for legacy projections remains operations-owned. */
export function secretCapabilityAction(action: SecretCapabilityAction): string {
  return `tinycloud.kv/${action}`;
}

export const SECRET_DECRYPT_CAPABILITY = "tinycloud.encryption/decrypt";
