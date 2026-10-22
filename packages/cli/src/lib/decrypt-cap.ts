import { parseExpiry, type PermissionEntry } from "@tinycloud/node-sdk";

/** A decrypt grant lives at most this long (ms). */
export const DECRYPT_MAX_LIFETIME_MS = 60 * 60 * 1000;

/** DRAFT public wording: printed once when a decrypt grant is shortened. */
export const DECRYPT_CAP_NOTICE = "Decrypt access lasts at most one hour, so this grant expires sooner than requested.";

/** DRAFT public wording: the SDK's DECRYPT_EXPIRY_TOO_LONG refusal as the CLI shows it. */
export const DECRYPT_EXPIRY_TOO_LONG_MESSAGE = "Decrypt access lasts at most one hour; request a shorter lifetime.";

const ENCRYPTION_ACTION_PREFIXES = ["tinycloud.encryption/", "encryption/"];

/** Encryption actions known not to decrypt, as the part after the service prefix. */
const NON_DECRYPT_ENCRYPTION_ACTIONS: Record<string, true> = { "network.create": true, "network.revoke": true };

function actionGrantsDecrypt(action: unknown, encryptionEntry: boolean): boolean {
  if (typeof action !== "string") return false;
  const prefix = ENCRYPTION_ACTION_PREFIXES.find((candidate) => action.startsWith(candidate));
  const base = prefix === undefined ? action : action.slice(prefix.length);
  if (prefix === undefined && !encryptionEntry) return false;
  // Fail closed: on an encryption entry anything not positively known to be non-decrypt counts.
  return !Object.hasOwn(NON_DECRYPT_ENCRYPTION_ACTIONS, base);
}

/**
 * True when any entry grants decrypt: the decrypt action, the encryption wildcard, a short-prefix
 * form, or any other action on an encryption entry. Non-object entries and non-array actions are
 * false here so request validation reports them.
 */
export function includesDecrypt(requested: readonly unknown[]): boolean {
  return requested.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const { service, actions } = entry as { service?: unknown; actions?: unknown };
    if (!Array.isArray(actions)) return false;
    const encryptionEntry = service === "tinycloud.encryption" || service === "encryption";
    return actions.some((action) => actionGrantsDecrypt(action, encryptionEntry));
  });
}

/** DRAFT public wording: `tc auth grant` refuses a decrypt request over one hour. */
export const DECRYPT_REQUEST_TOO_LONG_MESSAGE =
  "This request includes decrypt access, which lasts at most one hour. Nothing was signed. Ask for a new request of one hour or less.";

/** DRAFT public wording: consent line for a decrypt request, after "It lasts up to <N>." */
export const DECRYPT_CONSENT_NOTE = "Decrypt access never lasts longer than one hour;";

/** DRAFT public wording: stderr notice when `auth request --emit` gives a decrypt request the one-hour lifetime. */
export const DECRYPT_EMIT_DEFAULT_NOTICE =
  "This request includes decrypt access, so it asks for one hour instead of the usual 7 days.";

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
