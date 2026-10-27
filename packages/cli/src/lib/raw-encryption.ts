import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ENCRYPTION_PERMISSION_SERVICE } from "../../../sdk-core/src/manifest.js";

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
 * The one encryption entry OpenKey's device sign-in accepts: the approving
 * account's own `default` network, named as space `default`, empty path and
 * only decrypt. OpenKey resolves it to the owner's network when it signs.
 */
export function isDeviceDefaultDecrypt(permission: Pick<PermissionEntry, "service" | "space" | "path" | "actions" | "caveats">): boolean {
  return permission.service === ENCRYPTION_PERMISSION_SERVICE && permission.space === "default" && permission.path === "" &&
    permission.actions.length === 1 && permission.actions[0] === "tinycloud.encryption/decrypt" &&
    !permission.caveats?.length;
}
