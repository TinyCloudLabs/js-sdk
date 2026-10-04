import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

const SESSION_EXPIRED = "SESSION_EXPIRED";

/** How a profile of this posture gets a new session. */
export function signInAgainHint(profileName: string, posture: string | undefined): string {
  if (posture === "local-owner-key") {
    return `Sign in again with: tc --profile ${profileName} auth login --method local`;
  }
  if (posture === "delegate-session") {
    return `Have the owner approve a new scoped login: tc --profile ${profileName} auth login --method openkey --paste --manifest <manifest.json>. Pass the owner's code on stdin, newline-terminated.`;
  }
  return `Sign in again with: tc --profile ${profileName} auth login --method openkey`;
}

/**
 * The stored session failed local verification (expired, or no longer valid
 * for the profile's key). Only a new sign-in fixes it, and nothing has been
 * sent to the node.
 */
export function sessionExpiredError(profileName: string, posture: string | undefined): CLIError {
  return new CLIError(
    "AUTH_REQUIRED",
    `The session for profile "${profileName}" has expired or is no longer valid.`,
    ExitCode.AUTH_REQUIRED,
    { hint: signInAgainHint(profileName, posture), reason: SESSION_EXPIRED },
  );
}

/** Whether `error` came from {@link sessionExpiredError}, so a command can give its own sign-in guidance. */
export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof CLIError && error.metadata?.reason === SESSION_EXPIRED;
}
