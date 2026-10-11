import { signInRecovery } from "@tinycloud/operations/recovery";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";

/** Marks errors from {@link sessionExpiredError}; never output. */
const SESSION_EXPIRED_REASON = "session_expired";

/**
 * How a profile of this posture gets a new session: the persistent login from
 * operations' recovery table. A profile name that is unsafe in a command gets
 * the instruction without a command.
 */
export function signInAgainHint(profileName: string, posture: string | undefined): string {
  const delegate = posture === "delegate-session";
  const { command } = signInRecovery(
    profileName,
    delegate ? "delegate-session" : posture === "local-owner-key" ? "local-owner-key" : "owner-openkey",
  );
  if (command === undefined) {
    return delegate
      ? `Have the owner approve a new scoped login for profile ${JSON.stringify(profileName)} with tc auth login --method openkey --paste --manifest <manifest.json>.`
      : `Sign in again to profile ${JSON.stringify(profileName)} with tc auth login.`;
  }
  return delegate
    ? `Have the owner approve a new scoped login: ${command}. Pass the owner's code on stdin, newline-terminated.`
    : `Sign in again with: ${command}`;
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
    { hint: signInAgainHint(profileName, posture), reason: SESSION_EXPIRED_REASON },
  );
}

/**
 * An `AUTH_REQUIRED` decision with this profile kind's sign-in hint; any other
 * error unchanged. For operation results, whose code alone says a new sign-in
 * is needed.
 */
export function withSignInHint(error: CLIError, profileName: string, posture: string | undefined): CLIError {
  if (error.code !== "AUTH_REQUIRED") return error;
  return new CLIError(error.code, error.message, error.exitCode, {
    ...error.metadata,
    hint: signInAgainHint(profileName, posture),
  });
}

/** Whether `error` came from {@link sessionExpiredError}, so a command can give its own sign-in guidance. */
export function isSessionExpiredError(error: unknown): boolean {
  return error instanceof CLIError && error.metadata?.reason === SESSION_EXPIRED_REASON;
}
