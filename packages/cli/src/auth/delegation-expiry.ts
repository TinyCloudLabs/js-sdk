import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
/** A delegation whose signed lifetime has passed: same code and message as the `tinycloud.auth.import` operation. */
export function delegationExpiredError(): CLIError {
  return new CLIError("DELEGATION_EXPIRED", "The delegation has expired.", ExitCode.ERROR);
}

/** Whether validated activation refused a delegation as expired (`RuntimeDelegationRejectedError`, reason `expired`). */
export function isActivationExpiry(error: unknown): boolean {
  return typeof error === "object" && error !== null && "reason" in error && error.reason === "expired";
}
