import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { safeClipped } from "../output/safe-text.js";
import { APP_ID_RULE, isAppId } from "./apps-agent-preset.js";

function usage(message: string): CLIError {
  return new CLIError("INVALID_ARGUMENT", message, ExitCode.USAGE_ERROR);
}

/** An app id for `knowledge list --app` / `knowledge read`, or a usage error that says what is expected. */
export function assertKnowledgeAppId(value: string): string {
  if (!isAppId(value)) throw usage(`Invalid app id "${safeClipped(value)}": ${APP_ID_RULE}.`);
  return value;
}

/**
 * A concept path inside one app's bundle. The same rules the operation
 * enforces, checked first so a mistake gets a reason instead of a generic
 * invalid-input error.
 */
export function assertKnowledgeConcept(value: string): string {
  const reason = value.length > 300
    ? "it is longer than 300 characters"
    : value.startsWith("/")
    ? "it starts with a slash"
    : /[*\\]/.test(value)
    ? "it contains a wildcard or backslash"
    : /%(?:2e|2f|5c)/i.test(value)
    ? "it contains an encoded dot, slash or backslash"
    : value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ? "it has an empty, `.` or `..` segment"
    : undefined;
  if (reason !== undefined) {
    throw usage(
      `Invalid concept "${safeClipped(value)}": ${reason}. Use a path inside the app's knowledge folder, such as app or tables/meal.md.`,
    );
  }
  return value;
}
