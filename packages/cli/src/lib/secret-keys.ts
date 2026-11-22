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

/**
 * The last CLI release that can still read or delete a secret whose name or scope is over 64 characters (TC-3801 caps
 * both). Shown in the list note below. MUST equal the last published CLI before the release that carries the cap:
 * re-check it at publish.
 */
export const LAST_CLI_WITHOUT_NAME_CAP = "1.8.0";

/** Monica's S1l lines, for a listed secret this version can't read or delete. */
export function unreadableSecretNote(flags: { nameTooLong: boolean; scopeTooLong: boolean }): string | undefined {
  const cli = `CLI version ${LAST_CLI_WITHOUT_NAME_CAP} or earlier.`;
  const cannot = "so this version can't read or delete it.";
  if (flags.nameTooLong && flags.scopeTooLong) {
    return `Name and scope are longer than 64 characters, ${cannot} Rename it and move it to a shorter scope with ${cli}`;
  }
  if (flags.nameTooLong) return `Name is longer than 64 characters, ${cannot} Rename it with ${cli}`;
  if (flags.scopeTooLong) return `Scope is longer than 64 characters, ${cannot} Move it to a shorter scope with ${cli}`;
  return undefined;
}
