import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { createEncryptedProfileHistory, profileHistoryFileExists, signShareHistoryBytes } from "./adapters.js";
import { ShareHistoryUnreadableError } from "./errors.js";

export type ShareHistoryKeyDropCheck =
  | { readonly status: "clear" }
  | { readonly status: "unexpired"; readonly shareIds: readonly string[] }
  | { readonly status: "unavailable"; readonly reason: "unreadable" | "unavailable" };

/**
 * Reports whether dropping the profile's session key would leave unexpired
 * recorded shares that can no longer be revoked by ID. Local-owner profiles
 * derive their history key from the stored private key, which survives logout
 * and rotation, so they are always clear.
 */
export async function checkShareHistoryForKeyDrop(profileName: string, now: Date = new Date()): Promise<ShareHistoryKeyDropCheck> {
  const config = await ProfileManager.getProfile(profileName);
  if (typeof config.privateKey === "string" && config.privateKey.length > 0) return { status: "clear" };
  if (!(await profileHistoryFileExists(profileName))) return { status: "clear" };
  let shareIds: string[];
  try {
    const records = await createEncryptedProfileHistory(async () => profileName, signShareHistoryBytes).list();
    shareIds = records
      // An expiry that does not parse is not proof of expiry, so the record stays counted as unexpired.
      .filter((record) => record.revokedAt === undefined && !(Date.parse(record.expiresAt) <= now.getTime()))
      .map((record) => record.shareId);
  } catch (error) {
    return { status: "unavailable", reason: error instanceof ShareHistoryUnreadableError ? "unreadable" : "unavailable" };
  }
  return shareIds.length === 0 ? { status: "clear" } : { status: "unexpired", shareIds };
}

/**
 * Refuses a logout or rotation that would strand unexpired recorded shares.
 * Callers skip this for signed-out profiles and for the explicit bypass flags.
 */
export async function assertShareHistoryAllowsKeyDrop(profileName: string, action: "logout" | "rotate" | "login"): Promise<void> {
  // A login that creates the profile has no recorded shares to strand.
  if (action === "login" && !(await ProfileManager.profileExists(profileName))) return;
  const config = await ProfileManager.getProfile(profileName);
  if (config.authSignedOut === true) return;
  const check = await checkShareHistoryForKeyDrop(profileName);
  if (check.status === "clear") return;
  const bypass = action === "logout" ? "--force (or --revoke)" : "--force";
  if (check.status === "unexpired") {
    throw new CLIError(
      "SHARE_HISTORY_UNEXPIRED",
      `${action} would leave ${check.shareIds.length} unexpired recorded share(s) that cannot be revoked by ID: ${check.shareIds.join(", ")}.`,
      ExitCode.PERMISSION_DENIED,
      { hint: `Revoke them first with \`${CLI_NAME} share revoke <id>\`, or pass ${bypass} to ${action} anyway.` },
    );
  }
  const detail = check.reason === "unreadable"
    ? "The sender share history cannot be read with the current session key."
    : "The sender share history could not be loaded.";
  throw new CLIError(
    "SHARE_HISTORY_UNAVAILABLE",
    `${action} cannot confirm that recorded shares remain revocable. ${detail}`,
    ExitCode.PERMISSION_DENIED,
    {
      hint: check.reason === "unreadable"
        ? `Run \`${CLI_NAME} share history recover\` to move the unreadable file aside, or pass ${bypass} to ${action} anyway.`
        : `Sign in with \`${CLI_NAME} auth login\` and retry, or pass ${bypass} to ${action} anyway.`,
    },
  );
}
