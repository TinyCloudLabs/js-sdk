import { extractRecapAttenuations } from "@tinycloud/sdk-core";
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

export function partialKeysGrantError(): CLIError {
  return new CLIError("KEYS_PARTIAL_GRANT",
    "Named keys need both permissions (create and use), but only one was approved, so this sign-in wasn't saved. Sign in again and approve both.",
    ExitCode.PERMISSION_DENIED);
}

/** What a signed ReCap says about a requested key folder: both abilities, neither, or only one. */
export function namedKeysGrantIn(siwe: string | undefined, keys: ProfileNamedKeys): "both" | "none" | "partial" {
  let recap: Record<string, Record<string, unknown>> = {};
  try {
    recap = siwe === undefined ? {} : extractRecapAttenuations(siwe) as Record<string, Record<string, unknown>>;
  } catch {
    return "none";
  }
  const row = recap[keys.resource] ?? {};
  const wanted = keyAbilitiesFor(keys)[keys.resource]!;
  const granted = wanted.filter((ability) => ability in row);
  if (granted.length === 0) return "none";
  return granted.length === wanted.length && Object.keys(row).length === wanted.length ? "both" : "partial";
}

/** The profile with `namedKeys` kept only when the session's signed ReCap carries exactly both abilities. */
export function withVerifiedNamedKeys<T extends { namedKeys?: ProfileNamedKeys }>(profile: T, session: unknown): T {
  if (profile.namedKeys === undefined) return profile;
  const siwe = typeof session === "object" && session !== null ? (session as { siwe?: unknown }).siwe : undefined;
  if (typeof siwe === "string" && namedKeysGrantIn(siwe, profile.namedKeys) === "both") return profile;
  const { namedKeys: _dropped, ...rest } = profile;
  return rest as T;
}
