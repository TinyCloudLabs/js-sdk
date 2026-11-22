import { parseSecretCatalogKey } from "@tinycloud/sdk-services";
import { formatKeyResource, formatPrefixResource } from "@tinycloud/sdk-services/encryption/resource";
import { isSecretKeyPath } from "../../../sdk-core/src/manifest.js";

const VAULT_PREFIX = "vault/secrets/";

/**
 * The key path of one secret, `secrets/<lower NAME>` or `secrets/scoped/<scope>/<lower NAME>`, or undefined for a
 * name or scope over 64 characters, which has no key of its own and stays on the network key.
 */
export function secretKeyPath(name: string, scope?: string): string | undefined {
  const lower = name.toLowerCase();
  const path = scope === undefined ? `secrets/${lower}` : `secrets/scoped/${scope}/${lower}`;
  return isSecretKeyPath(path) ? path : undefined;
}

/** The exact key resource of the secret at a vault path (`vault/secrets/…`) on `networkId`, when it has one. */
export function secretKeyResourceForVaultPath(networkId: string, vaultPath: string): string | undefined {
  if (!vaultPath.startsWith(VAULT_PREFIX)) return undefined;
  const parsed = parseSecretCatalogKey(vaultPath.slice(VAULT_PREFIX.length));
  if (parsed === undefined) return undefined;
  const path = secretKeyPath(parsed.name, parsed.scope);
  return path === undefined ? undefined : formatKeyResource(networkId, path);
}

/** The owner's whole `secrets/` key prefix on `networkId`: requested only by an owner `tc secrets migrate`. */
export function secretsKeyPrefixResource(networkId: string): string {
  return formatPrefixResource(networkId, "secrets");
}
