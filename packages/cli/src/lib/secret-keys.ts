import { parseSecretCatalogKey, secretKeyPath } from "@tinycloud/sdk-services";
import { formatKeyResource } from "@tinycloud/sdk-services/encryption/resource";

const VAULT_PREFIX = "vault/secrets/";

/**
 * The exact key resource of the secret at a vault path (`vault/secrets/…`) on `networkId`. Undefined for a path
 * that is not one secret; `parseSecretCatalogKey` already refuses a name or scope over 64 characters.
 */
export function secretKeyResourceForVaultPath(networkId: string, vaultPath: string): string | undefined {
  if (!vaultPath.startsWith(VAULT_PREFIX)) return undefined;
  const parsed = parseSecretCatalogKey(vaultPath.slice(VAULT_PREFIX.length));
  return parsed === undefined ? undefined : formatKeyResource(networkId, secretKeyPath(parsed.name, parsed.scope));
}

/** The exact key resource of one secret key path (`secrets/…`) on `networkId`. */
export function secretKeyResource(networkId: string, keyPath: string): string {
  return formatKeyResource(networkId, keyPath);
}
