import { MAX_APPROVAL_LEASE_SECONDS } from "@tinycloud/share-envelope/links";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

const UNIT_SECONDS: Record<string, number> = { h: 3600, d: 86_400, w: 7 * 86_400, y: 365 * 86_400 };

/**
 * The longest renewal lease a login asks the owner for, from `--renew`: a whole number of hours, days, weeks or
 * years (`90d`, `26w`, `1y`), at most one year. The owner picks the actual length in OpenKey; this is the ceiling.
 */
export function parseRenewLifetimeSeconds(value: string): number {
  const match = /^([1-9]\d{0,5})([hdwy])$/.exec(value);
  const seconds = match === null ? NaN : Number(match[1]) * UNIT_SECONDS[match[2]!]!;
  if (!Number.isSafeInteger(seconds) || seconds > MAX_APPROVAL_LEASE_SECONDS) {
    throw new CLIError(
      "INVALID_RENEW",
      `Invalid --renew "${value}". Use a whole number of hours, days, weeks or years, such as 90d or 1y, and at most 1y.`,
      ExitCode.USAGE_ERROR,
    );
  }
  return seconds;
}

/** The line printed under the approval link when the request asks for a renewal; the owner decides in OpenKey. */
export function renewalLine(leaseLifetimeSeconds: number): string {
  const days = leaseLifetimeSeconds / 86_400;
  const length = Number.isInteger(days) && days >= 1
    ? `${days} ${days === 1 ? "day" : "days"}`
    : `${Math.max(1, Math.round(leaseLifetimeSeconds / 3600))} hours`;
  return `If you approve, this permission can renew itself for up to ${length}. You can shorten or stop that in OpenKey.`;
}
