import { parseSecretCatalogKey, secretKeyPath } from "@tinycloud/sdk-services";
import { formatKeyResource } from "@tinycloud/sdk-services/encryption/resource";

const VAULT_PREFIX = "vault/secrets/";

/**
 * The exact key resource of the secret at a vault path (`vault/secrets/…`) on `networkId`. Undefined for a path
 * that is not one secret, or for a name or scope over 64 bytes, which has no key of its own and stays on the network.
 */
export function secretKeyResourceForVaultPath(networkId: string, vaultPath: string): string | undefined {
  if (!vaultPath.startsWith(VAULT_PREFIX)) return undefined;
  const parsed = parseSecretCatalogKey(vaultPath.slice(VAULT_PREFIX.length));
  if (parsed === undefined) return undefined;
  let keyPath: string;
  try {
    // The catalog key is already a valid name and canonical scope, so the only refusal is a segment over 64 bytes.
    keyPath = secretKeyPath(parsed.name, parsed.scope);
  } catch {
    return undefined;
  }
  return formatKeyResource(networkId, keyPath);
}

/** The exact key resource of one secret key path (`secrets/…`) on `networkId`. */
export function secretKeyResource(networkId: string, keyPath: string): string {
  return formatKeyResource(networkId, keyPath);
}
