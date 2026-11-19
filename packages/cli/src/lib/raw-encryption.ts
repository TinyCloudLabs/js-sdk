import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ENCRYPTION_PERMISSION_SERVICE } from "../../../sdk-core/src/manifest.js";
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

/**
 * The first entry OpenKey's device flow refuses: any entry in a secrets space ("secrets"), or any encryption entry
 * other than decrypt on the owner's default network. OpenKey admits exactly that one encryption entry
 * (openkey apps/api/src/services/device-authorization.ts, deviceRequestPermissions).
 */
export function deviceRefusal(entries: readonly PermissionEntry[]): PermissionEntry | "secrets" | undefined {
  for (const entry of entries) {
    if (entry.space === "secrets" || entry.space?.endsWith(":secrets") === true) return "secrets";
    if (entry.service === ENCRYPTION_PERMISSION_SERVICE && !isDeviceDefaultDecrypt(entry)) return entry;
  }
  return undefined;
}

const DEVICE_DECRYPT_ALLOWED = "tinycloud.encryption/decrypt on the default network (space \"default\", path \"\")";

/**
 * The DEVICE_AUTH_UNSUPPORTED_SCOPE message: what was refused, what --device allows, and `next` ("Use … for this
 * manifest."). `subject` ("this manifest", "this request") names who asked for the secrets space. Request text is
 * escaped and clipped.
 */
export function deviceRefusalMessage(refused: PermissionEntry | "secrets", subject: string, next: string): string {
  const allowed = `The only encryption permission --device can ask for is ${DEVICE_DECRYPT_ALLOWED}.`;
  if (refused === "secrets") {
    return `--device can't authorize the secrets space, and ${subject} asks for it. ${allowed} ${next}`;
  }
  const actions = refused.actions.slice(0, 5).map((action) => safeClipped(action)).join(", ") || "no actions";
  return `--device can't ask for ${actions} on space "${safeClipped(refused.space ?? "")}", path "${safeClipped(refused.path)}"` +
    `${refused.caveats?.length ? " with extra limits" : ""}. ${allowed} ${next}`;
}
