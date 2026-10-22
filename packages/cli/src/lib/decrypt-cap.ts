import { parseExpiry, type PermissionEntry } from "@tinycloud/node-sdk";

const DECRYPT_ACTION = "tinycloud.encryption/decrypt";

/** A decrypt grant lives at most this long (ms). */
export const DECRYPT_MAX_LIFETIME_MS = 60 * 60 * 1000;

/** DRAFT public wording: printed once when a decrypt grant is shortened. */
export const DECRYPT_CAP_NOTICE = "Decrypt access lasts at most one hour, so this grant expires sooner than requested.";

/** DRAFT public wording: the SDK's DECRYPT_EXPIRY_TOO_LONG refusal as the CLI shows it. */
export const DECRYPT_EXPIRY_TOO_LONG_MESSAGE = "Decrypt access lasts at most one hour; request a shorter lifetime.";

export function includesDecrypt(requested: readonly Pick<PermissionEntry, "actions">[]): boolean {
  return requested.some((entry) => entry.actions.includes(DECRYPT_ACTION));
}

function lifetimeMs(expiry: string | number): number | undefined {
  if (typeof expiry === "number") return expiry;
  try {
    return parseExpiry(expiry);
  } catch {
    return undefined;
  }
}

/**
 * The lifetime to pass to `grantRuntimePermissions`. A set without decrypt is
 * returned unchanged. A set with decrypt always carries an explicit lifetime of
 * at most one hour; `capped` is true when a longer requested lifetime was cut.
 */
export function boundDecryptExpiry(
  requested: readonly Pick<PermissionEntry, "actions">[],
  expiry: string | number | undefined,
): { expiry: string | number | undefined; capped: boolean } {
  if (!includesDecrypt(requested)) return { expiry, capped: false };
  if (expiry === undefined) return { expiry: DECRYPT_MAX_LIFETIME_MS, capped: false };
  const ms = lifetimeMs(expiry);
  if (ms === undefined || ms <= DECRYPT_MAX_LIFETIME_MS) return { expiry, capped: false };
  return { expiry: DECRYPT_MAX_LIFETIME_MS, capped: true };
}

/** Bound the lifetime and print the notice once when it was shortened. */
export function boundDecryptExpiryWithNotice(
  requested: readonly Pick<PermissionEntry, "actions">[],
  expiry: string | number | undefined,
): string | number | undefined {
  const bounded = boundDecryptExpiry(requested, expiry);
  if (bounded.capped) process.stderr.write(`${DECRYPT_CAP_NOTICE}\n`);
  return bounded.expiry;
}
