import { MAX_SECRET_SCOPE_LENGTH, parseSecretCatalogKey, SECRET_SCOPE_RE, secretKeyPath } from "@tinycloud/sdk-services";
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

/**
 * Whether the scope a `secrets list` asks for is one stored before the 64-character cap, by the test the SDK's own
 * `list` makes: the trimmed text is already canonical and over the cap. Any other text is canonicalized first (spaces
 * and case fold, so padded or mixed-case input that comes to 64 or fewer characters is an ordinary scope).
 */
export function isOverlongStoredScope(rawScope: string | undefined): boolean {
  const trimmed = rawScope?.trim();
  return trimmed !== undefined && trimmed.length > MAX_SECRET_SCOPE_LENGTH && SECRET_SCOPE_RE.test(trimmed);
}
