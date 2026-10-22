import { parseExpiry, type PermissionEntry } from "@tinycloud/node-sdk";

const DECRYPT_ACTION = "tinycloud.encryption/decrypt";

/** A decrypt grant lives at most this long (ms). */
export const DECRYPT_MAX_LIFETIME_MS = 60 * 60 * 1000;

/** DRAFT public wording: printed once when a decrypt grant is shortened. */
export const DECRYPT_CAP_NOTICE = "Decrypt access lasts at most one hour, so this grant expires sooner than requested.";

/** DRAFT public wording: the SDK's DECRYPT_EXPIRY_TOO_LONG refusal as the CLI shows it. */
export const DECRYPT_EXPIRY_TOO_LONG_MESSAGE = "Decrypt access lasts at most one hour; request a shorter lifetime.";

/** Actions that grant decrypt: the exact action and the encryption service wildcard. */
const DECRYPT_GRANTING_ACTIONS: Record<string, true> = { [DECRYPT_ACTION]: true, "tinycloud.encryption/*": true };
/** Short forms count only on an encryption entry. */
const SHORT_DECRYPT_GRANTING_ACTIONS: Record<string, true> = { decrypt: true, "*": true };

export function includesDecrypt(requested: readonly Pick<PermissionEntry, "actions" | "service">[]): boolean {
  return requested.some((entry) => {
    const encryption = entry.service === "tinycloud.encryption" || entry.service === "encryption";
    return entry.actions.some((action) =>
      Object.hasOwn(DECRYPT_GRANTING_ACTIONS, action) || (encryption && Object.hasOwn(SHORT_DECRYPT_GRANTING_ACTIONS, action)));
  });
}

/** DRAFT public wording: `tc auth grant` refuses a decrypt request over one hour. */
export const DECRYPT_REQUEST_TOO_LONG_MESSAGE =
  "This request includes decrypt access, which lasts at most one hour. Nothing was signed. Ask for a new request of one hour or less.";

/** DRAFT public wording: consent line for a decrypt request, after "It lasts up to <N>." */
export const DECRYPT_CONSENT_NOTE = "Decrypt access never lasts longer than one hour;";

/** True when a request's lifetime is absent (the default is longer), unreadable, or over one hour. */
export function exceedsDecryptLifetime(expiry: string | number | undefined): boolean {
  if (expiry === undefined) return true;
  const ms = lifetimeMs(expiry);
  return ms === undefined || ms > DECRYPT_MAX_LIFETIME_MS;
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
  requested: readonly Pick<PermissionEntry, "actions" | "service">[],
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
  requested: readonly Pick<PermissionEntry, "actions" | "service">[],
  expiry: string | number | undefined,
): string | number | undefined {
  const bounded = boundDecryptExpiry(requested, expiry);
  if (bounded.capped) process.stderr.write(`${DECRYPT_CAP_NOTICE}\n`);
  return bounded.expiry;
}
