import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ENCRYPTION_PERMISSION_SERVICE } from "../../../sdk-core/src/manifest.js";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { safeClipped } from "../output/safe-text.js";

/**
 * A raw encryption network entry (`urn:tinycloud:encryption:<owner>:<name>`).
 * It is a top-level ReCap resource in the `encryption` pseudo-space, not a
 * path in a TinyCloud space. OpenKey reports it with the short service name.
 */
export function isRawEncryptionPermission(permission: Pick<PermissionEntry, "service" | "path">): boolean {
  return (permission.service === ENCRYPTION_PERMISSION_SERVICE || permission.service === "encryption") &&
    typeof permission.path === "string" && permission.path.startsWith("urn:tinycloud:encryption:");
}

/** A returned/verified resource is raw only without an explicit owner-space prefix. */
export function isVerifiedRawEncryptionPermission(permission: Pick<PermissionEntry, "service" | "space" | "path">): boolean {
  return isRawEncryptionPermission(permission) &&
    (permission.space === undefined || permission.space === "encryption");
}

/** A raw encryption resource under a network's `secrets/` keys: one secret's key, or (refused everywhere) a prefix. */
export function isSecretsKeyResource(path: string): boolean {
  return /^urn:tinycloud:encryption:did:[^/]+\/secrets(?:\/|$)/.test(path);
}

const EXACT_SECRET_KEY_RESOURCE =
  /^urn:tinycloud:encryption:did:[^/]+:default\/secrets\/[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63}){0,6}$/;

/** TinyChat's reserved bot-history key folder (`secrets/scoped/<scope>`), derived from the SDK's key path. */
const BOT_HISTORY_KEY_FOLDER = BOT_HISTORY_KEY_PATH.slice(0, BOT_HISTORY_KEY_PATH.lastIndexOf("/"));
const BOT_HISTORY_SCOPE = BOT_HISTORY_KEY_FOLDER.slice(BOT_HISTORY_KEY_FOLDER.lastIndexOf("/") + 1);

/**
 * Whether a raw encryption resource names a key in TinyChat's reserved bot-history scope (its key, or the scope as a
 * prefix), on any network and in any letter case.
 */
export function isBotHistoryKeyResource(path: string): boolean {
  const slash = path.indexOf("/");
  if (slash === -1) return false;
  const key = path.slice(slash + 1).toLowerCase();
  const folder = BOT_HISTORY_KEY_FOLDER.toLowerCase();
  return key === folder || key.startsWith(`${folder}/`);
}

/** Refuses a request naming the reserved bot-history key, before anything is signed, asked or stored. */
export function assertNoBotHistoryKey(permissions: readonly Pick<PermissionEntry, "service" | "path">[]): void {
  if (permissions.some((permission) => isRawEncryptionPermission(permission) && isBotHistoryKeyResource(permission.path))) {
    throw new CLIError(
      "INVALID_SECRET_SCOPE",
      `Secret scope ${JSON.stringify(BOT_HISTORY_SCOPE)} is reserved; omit scope for global secrets.`,
      ExitCode.USAGE_ERROR,
    );
  }
}

/**
 * One secret's own key and nothing wider: `<network>/secrets/<name>` (or `secrets/scoped/<scope>/<name>`), never the
 * bare network, a `secrets/` prefix or a trailing `/`, and only decrypt and key creation on it. An owner's wallet
 * signs such an entry for an agent; an OpenKey owner's agent request carries it with decrypt only (TC-3800). The
 * reserved bot-history key is never one of them.
 */
export function isExactSecretKeyPermission(
  permission: Pick<PermissionEntry, "service" | "path" | "actions" | "caveats">,
): boolean {
  return isRawEncryptionPermission(permission) && EXACT_SECRET_KEY_RESOURCE.test(permission.path) &&
    !isBotHistoryKeyResource(permission.path) &&
    permission.actions.length > 0 &&
    permission.actions.every((action) => action === "tinycloud.encryption/decrypt" || action === "tinycloud.encryption/key.create") &&
    !permission.caveats?.length;
}

/** {@link isExactSecretKeyPermission} with decrypt as the only action: the one raw entry OpenKey signs for an agent. */
export function isDecryptOnlyExactSecretKey(
  permission: Pick<PermissionEntry, "service" | "path" | "actions" | "caveats">,
): boolean {
  return isExactSecretKeyPermission(permission) && permission.actions.every((action) => action === "tinycloud.encryption/decrypt");
}

/**
 * The built-in Share publishing decrypt entry names the approving account's
 * `default/share/` encryption prefix before owner resolution.
 */
export function isSharePublishingPrefixDecrypt(permission: Pick<PermissionEntry, "service" | "space" | "path" | "actions" | "caveats">): boolean {
  return permission.service === ENCRYPTION_PERMISSION_SERVICE && permission.space === "default" && permission.path === "share/" &&
    permission.actions.length === 1 && permission.actions[0] === "tinycloud.encryption/decrypt" &&
    !permission.caveats?.length;
}

/** Legacy manifest spelling for an owner's default network root. */
export function isDeviceDefaultDecrypt(permission: Pick<PermissionEntry, "service" | "space" | "path" | "actions" | "caveats">): boolean {
  return permission.service === ENCRYPTION_PERMISSION_SERVICE && permission.space === "default" && permission.path === "" &&
    permission.actions.length === 1 && permission.actions[0] === "tinycloud.encryption/decrypt" &&
    !permission.caveats?.length;
}

/** An entry in a secrets space: the space `secrets`, or a full space id that names it. */
export function isSecretsSpacePermission(permission: Pick<PermissionEntry, "space">): boolean {
  return permission.space === "secrets" || permission.space?.endsWith(":secrets") === true;
}

/**
 * The first entry OpenKey's device flow refuses: any entry in a secrets space ("secrets"), or any encryption entry
 * other than decrypt on the owner's default network. OpenKey admits exactly that one encryption entry
 * (openkey apps/api/src/services/device-authorization.ts, deviceRequestPermissions).
 */
export function deviceRefusal(entries: readonly PermissionEntry[]): PermissionEntry | "secrets" | undefined {
  for (const entry of entries) {
    if (isSecretsSpacePermission(entry)) return "secrets";
    if (entry.service === ENCRYPTION_PERMISSION_SERVICE && !isDeviceDefaultDecrypt(entry)) return entry;
  }
  return undefined;
}

const DEVICE_DECRYPT_ALLOWED = "tinycloud.encryption/decrypt on the default network (space \"default\", path \"\")";

/** The refusal for any request that touches the secrets space; `--paste` login is the route that can read secrets. */
const DEVICE_SECRETS_REFUSAL = "--device can't read secrets yet. Use tinycloud auth login --paste instead.";

/**
 * The DEVICE_AUTH_UNSUPPORTED_SCOPE message: for the secrets space the fixed refusal above; for any other refused
 * entry, what was refused, what --device allows, and `next` ("Use … for this manifest."). Request text is escaped
 * and clipped.
 */
export function deviceRefusalMessage(refused: PermissionEntry | "secrets", next: string): string {
  if (refused === "secrets") return DEVICE_SECRETS_REFUSAL;
  const allowed = `The only encryption permission --device can ask for is ${DEVICE_DECRYPT_ALLOWED}.`;
  const actions = refused.actions.slice(0, 5).map((action) => safeClipped(action)).join(", ") || "no actions";
  return `--device can't ask for ${actions} on space "${safeClipped(refused.space ?? "")}", path "${safeClipped(refused.path)}"` +
    `${refused.caveats?.length ? " with extra limits" : ""}. ${allowed} ${next}`;
}
