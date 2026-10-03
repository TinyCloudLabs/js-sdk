import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ENCRYPTION_PERMISSION_SERVICE } from "../../../sdk-core/src/manifest.js";
import { normalizePkhIdentifier } from "./space.js";

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

/** A decrypt network can only be granted by the owner encoded in its URN. */
export function rawEncryptionOwnerMatches(path: string, ownerDid: string): boolean {
  const match = /^urn:tinycloud:encryption:(did:pkh:eip155:[1-9]\d*:0x[0-9a-fA-F]{40}):[a-z0-9][a-z0-9-]*$/.exec(path);
  return match !== null && normalizePkhIdentifier(match[1]!) === normalizePkhIdentifier(ownerDid);
}
