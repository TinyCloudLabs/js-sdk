import { recapCaveatsEqual } from "@tinycloud/sdk-core";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

export const CAVEATS_UNSUPPORTED_CODE = "CAVEATS_UNSUPPORTED";

const CAVEATS_UNSUPPORTED_MESSAGE =
  "A requested permission carries a limit (caveats), and OpenKey approval does not apply limits. Nothing was requested. Remove the limit from the permission and retry.";

/**
 * True when `caveats` constrains the permission. Uses sdk-core's
 * `recapCaveatsEqual` against "no caveats": absent, `[]` and a lone `[{}]` are
 * unconstrained; any other value, including one the comparison cannot
 * canonicalize, is not.
 */
export function hasCaveatLimit(caveats: unknown): boolean {
  if (caveats === undefined) return false;
  if (!Array.isArray(caveats)) return true;
  try {
    return !recapCaveatsEqual(caveats, undefined);
  } catch {
    return true;
  }
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
