import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ENCRYPTION_PERMISSION_SERVICE } from "../../../sdk-core/src/manifest.js";
import { SECRET_NAME_RE } from "@tinycloud/sdk-services";
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

const DEVICE_SECRET_ACTIONS: ReadonlySet<string> = new Set(["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list"]);

/**
 * One named secret OpenKey's device flow admits in a secrets space: KV get/put/list on exactly
 * `vault/secrets/<NAME>` (one secret name of at most 64 characters, no prefix, no scope, no limits). A whole-space
 * request is not one.
 */
export function isDeviceNamedSecret(entry: Pick<PermissionEntry, "service" | "space" | "path" | "actions" | "caveats">): boolean {
  const name = entry.path.startsWith("vault/secrets/") ? entry.path.slice("vault/secrets/".length) : undefined;
  return entry.service === "tinycloud.kv" && name !== undefined && name.length <= 64 && SECRET_NAME_RE.test(name) &&
    entry.actions.length > 0 && entry.actions.every((action) => DEVICE_SECRET_ACTIONS.has(action)) &&
    !entry.caveats?.length;
}

/** The capability read on a space root that every OpenKey login carries (it signs no delegation without it). */
function isCapabilitiesRead(entry: Pick<PermissionEntry, "service" | "path" | "actions" | "caveats">): boolean {
  return entry.service === "tinycloud.capabilities" && entry.path === "" &&
    entry.actions.length === 1 && entry.actions[0] === "tinycloud.capabilities/read" && !entry.caveats?.length;
}

/** The device list-only grant on the whole secrets prefix: names only, never with get or put on the prefix. */
export const DEVICE_SECRETS_LIST_PATH = "vault/secrets/";

export function isDeviceSecretsList(entry: Pick<PermissionEntry, "service" | "path" | "actions" | "caveats">): boolean {
  return entry.service === "tinycloud.kv" && entry.path === DEVICE_SECRETS_LIST_PATH &&
    entry.actions.length === 1 && entry.actions[0] === "tinycloud.kv/list" && !entry.caveats?.length;
}

/**
 * `entries` without a repeated default-network decrypt: OpenKey's device flow takes exactly one, so an identical
 * second one (a hand-written manifest) is dropped.
 */
export function dedupeDeviceDecrypt<T extends Pick<PermissionEntry, "service" | "space" | "path" | "actions" | "caveats">>(entries: readonly T[]): T[] {
  let seen = false;
  return entries.filter((entry) => {
    if (!isDeviceDefaultDecrypt({ ...entry, space: entry.space ?? "" })) return true;
    const repeat = seen;
    seen = true;
    return !repeat;
  });
}

/**
 * The first entry OpenKey's device flow refuses: any entry in a secrets space ("secrets") other than one named
 * secret (`isDeviceNamedSecret`), the whole-prefix list (`isDeviceSecretsList`) or the space's capability read, or
 * any encryption entry other than decrypt on the owner's default network. OpenKey admits exactly that one
 * encryption entry (openkey apps/api/src/services/device-authorization.ts, deviceRequestPermissions).
 */
export function deviceRefusal(entries: readonly PermissionEntry[]): PermissionEntry | "secrets" | undefined {
  for (const entry of entries) {
    if (
      (entry.space === "secrets" || entry.space?.endsWith(":secrets") === true) &&
      !isDeviceNamedSecret(entry) && !isDeviceSecretsList(entry) && !isCapabilitiesRead(entry)
    ) return "secrets";
    if (entry.service === ENCRYPTION_PERMISSION_SERVICE && !isDeviceDefaultDecrypt(entry)) return entry;
  }
  return undefined;
}

const DEVICE_DECRYPT_ALLOWED = "tinycloud.encryption/decrypt on the default network (space \"default\", path \"\")";

/**
 * The DEVICE_AUTH_UNSUPPORTED_SCOPE message: what was refused, what --device allows, and `next` ("Use … for this
 * manifest."). `subject` ("this manifest", "this request") names who asked for it. Request text is escaped and
 * clipped.
 */
export function deviceRefusalMessage(refused: PermissionEntry | "secrets", subject: string, next: string): string {
  const allowed = `The only encryption permission --device can ask for is ${DEVICE_DECRYPT_ALLOWED}.`;
  if (refused === "secrets") {
    return `--device can ask only for named secrets (get, put or list on each) and decrypt on the default network. ${subject[0]!.toUpperCase()}${subject.slice(1)} asks for more than that. ${next}`;
  }
  const actions = refused.actions.slice(0, 5).map((action) => safeClipped(action)).join(", ") || "no actions";
  return `--device can't ask for ${actions} on space "${safeClipped(refused.space ?? "")}", path "${safeClipped(refused.path)}"` +
    `${refused.caveats?.length ? " with extra limits" : ""}. ${allowed} ${next}`;
}
