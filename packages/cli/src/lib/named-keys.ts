import {
  EncryptionResourceError,
  KEY_CREATE_ABILITY,
  formatPrefixResource,
  nodeSupportsNamedKeys,
} from "@tinycloud/sdk-services/encryption/resource";
import { DECRYPT_ACTION } from "@tinycloud/sdk-services";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

/** Network that `--keys` grants live in. */
export const NAMED_KEYS_NETWORK = "default";

/** What a profile records about the key prefix its session was signed for. */
export interface ProfileNamedKeys {
  /** Prefix without the trailing `/`. */
  prefix: string;
  /** Exact prefix resource in the session's ReCap. */
  resource: string;
}

/** The owner DID of a local-key profile in the canonical form the node checks. */
export function namedKeysNetworkId(ownerDid: string): string {
  return `urn:tinycloud:encryption:${ownerDid}:${NAMED_KEYS_NETWORK}`;
}

/**
 * Validate a `--keys` prefix before anything is signed. Accepts `qa` or `qa/`.
 * App keys (`apps/…`) are host-bound and are not available from the CLI.
 */
export function parseKeysPrefix(input: string, ownerDid: string): ProfileNamedKeys {
  const prefix = input.endsWith("/") ? input.slice(0, -1) : input;
  const invalid = (reason: string): CLIError =>
    new CLIError("INVALID_KEY_PREFIX", `Invalid \`--keys\` folder "${input}": ${reason}`, ExitCode.USAGE_ERROR);
  if (prefix.length === 0) throw invalid("the folder can't be empty.");
  if (prefix === "apps" || prefix.startsWith("apps/")) {
    throw invalid("folders under `apps/` belong to apps and can't be used from the CLI.");
  }
  try {
    return { prefix, resource: formatPrefixResource(namedKeysNetworkId(ownerDid), prefix) };
  } catch (error) {
    if (error instanceof EncryptionResourceError) throw invalid(error.message);
    throw error;
  }
}

/** The two abilities `--keys` adds to the sign-in ReCap, keyed by the prefix resource. */
export function keyAbilitiesFor(keys: ProfileNamedKeys): Record<string, string[]> {
  return { [keys.resource]: [KEY_CREATE_ABILITY, DECRYPT_ACTION] };
}

/** Whether `path` is strictly below `prefix` (`p/x`, not `p` or `px/…`). */
export function keyPathInPrefix(prefix: string, path: string): boolean {
  return path.startsWith(`${prefix}/`) && path.length > prefix.length + 1;
}

/** Refuse before any signature when the node does not advertise named keys. */
export async function assertNodeSupportsNamedKeys(host: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let info: { features?: unknown } | null = null;
  try {
    const response = await fetchImpl(`${host}/info`);
    if (response.ok) info = (await response.json()) as { features?: unknown };
  } catch {
    info = null;
  }
  if (!nodeSupportsNamedKeys(info)) {
    throw new CLIError(
      "NAMED_KEYS_UNAVAILABLE",
      `${host} doesn't support named keys, so \`--keys\` can't be used there. Nothing was signed.`,
      ExitCode.NODE_ERROR,
    );
  }
}
