import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

export const CAVEATS_UNSUPPORTED_CODE = "CAVEATS_UNSUPPORTED";

const CAVEATS_UNSUPPORTED_MESSAGE =
  "A requested permission carries a limit (caveats), and OpenKey approval does not apply limits. Nothing was requested. Remove the limit from the permission and retry.";

function isEmptyCaveat(caveat: unknown): boolean {
  if (caveat === null || typeof caveat !== "object" || Array.isArray(caveat)) return false;
  const prototype = Object.getPrototypeOf(caveat) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(caveat).length === 0;
}

/**
 * True when `caveats` constrains the permission: absent, `[]` and arrays of
 * plain empty objects (`[{}]`, `[{}, {}]`) are unconstrained; any other value
 * is not.
 */
export function hasCaveatLimit(caveats: unknown): boolean {
  if (caveats === undefined) return false;
  if (!Array.isArray(caveats)) return true;
  return !caveats.every(isEmptyCaveat);
}

/**
 * Refuses a permission list in which any entry carries a limit. Runs before
 * any OpenKey URL, device authorization or prepared session is built.
 */
export function assertNoCaveatLimits(permissions: Iterable<unknown> | undefined): void {
  if (permissions === undefined) return;
  for (const permission of permissions) {
    if (permission === null || typeof permission !== "object" || !("caveats" in permission)) continue;
    if (hasCaveatLimit(permission.caveats)) {
      throw new CLIError(CAVEATS_UNSUPPORTED_CODE, CAVEATS_UNSUPPORTED_MESSAGE, ExitCode.USAGE_ERROR);
    }
  }
}
