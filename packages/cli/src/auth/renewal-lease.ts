import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ENCRYPTION_PERMISSION_SERVICE } from "../../../sdk-core/src/manifest.js";
import { ExitCode } from "../config/constants.js";
import { isSecretsSpacePermission } from "../lib/raw-encryption.js";
import { CLIError } from "../output/errors.js";
import { parseRequestedExpiry } from "./scoped-login.js";

/**
 * The renewal lease an OpenKey approval request asks for when the caller names none. A lease counts from the owner's
 * approval, so it adds time only past the end of the grant it renews.
 */
export const DEFAULT_RENEWAL_LEASE_SECONDS = 30 * 86_400;

/** The longest lease `--renew` may name: 90 days (Sam, 2026-11-22: "up to 90 days"), below OpenKey's one-year limit. */
export const MAX_RENEWAL_LEASE_SECONDS = 90 * 86_400;

/**
 * A request with any encryption entry (decrypt included) or any entry in a secrets space is never renewed by default;
 * only a named `--renew` asks for a lease beside it.
 */
export function withoutDefaultRenewal(permissions: readonly PermissionEntry[]): boolean {
  return permissions.some((entry) =>
    entry.service === ENCRYPTION_PERMISSION_SERVICE || entry.service === "encryption" || isSecretsSpacePermission(entry));
}

/** `--renew <duration>`: whole seconds, at most MAX_RENEWAL_LEASE_SECONDS. */
export function parseRenewOption(value: string): number {
  let durationMs: number;
  try { durationMs = parseRequestedExpiry(value).durationMs; } catch {
    throw new CLIError("INVALID_RENEW", `Invalid --renew "${value}". Use a duration such as 30d or 12w.`, ExitCode.USAGE_ERROR);
  }
  const seconds = Math.floor(durationMs / 1000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_RENEWAL_LEASE_SECONDS) {
    throw new CLIError("INVALID_RENEW", `--renew must be a duration of at most ${MAX_RENEWAL_LEASE_SECONDS / 86_400} days (${MAX_RENEWAL_LEASE_SECONDS / 86_400}d).`, ExitCode.USAGE_ERROR);
  }
  return seconds;
}

/**
 * The lease to ask for beside a grant of `grantSeconds`. `false` asks for none (`--no-renew`); `undefined` asks for
 * the default lease when it outlasts the grant, and for none otherwise. A named lease that ends no later than the
 * grant is refused.
 */
export function renewalLeaseFor(choice: number | false | undefined, grantSeconds: number): number | undefined {
  if (choice === false) return undefined;
  if (choice === undefined) return grantSeconds < DEFAULT_RENEWAL_LEASE_SECONDS ? DEFAULT_RENEWAL_LEASE_SECONDS : undefined;
  if (choice <= grantSeconds) {
    throw new CLIError("INVALID_RENEW", "--renew must be longer than the sign-in's --expiry: a renewal counts from the approval, so a shorter one adds no time.", ExitCode.USAGE_ERROR);
  }
  return choice;
}
