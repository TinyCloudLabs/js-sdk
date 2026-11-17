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

/** Legacy manifest spelling for an owner's default network root; only a browser or paste sign-in can carry it. */
export function isDefaultNetworkDecrypt(permission: Pick<PermissionEntry, "service" | "space" | "path" | "actions" | "caveats">): boolean {
  return permission.service === ENCRYPTION_PERMISSION_SERVICE && permission.space === "default" && permission.path === "" &&
    permission.actions.length === 1 && permission.actions[0] === "tinycloud.encryption/decrypt" &&
    !permission.caveats?.length;
}

/** Most shared files one device request may ask to decrypt (openkey DEVICE_AUTH_MAX_SHARE_DECRYPTS). */
export const DEVICE_MAX_SHARE_DECRYPTS = 4;

/**
 * Decrypt on one shared file of the owner's default network, as OpenKey's device flow takes it (TC-3204): space
 * `default`, path `share/<id>` with a network-safe share id (share-sdk `NETWORK_SAFE_SHARE_ID`), decrypt only.
 */
export function isDeviceShareDecrypt(permission: Pick<PermissionEntry, "service" | "space" | "path" | "actions" | "caveats">): boolean {
  return permission.service === ENCRYPTION_PERMISSION_SERVICE && permission.space === "default" &&
    /^share\/[a-z0-9][a-z0-9-]{15,35}$/.test(permission.path) &&
    permission.actions.length === 1 && permission.actions[0] === "tinycloud.encryption/decrypt" &&
    !permission.caveats?.length;
}

/**
 * The first entry OpenKey's device flow refuses: any entry in a secrets space ("secrets"), any encryption entry other
 * than decrypt on one shared file, or the shared file past DEVICE_MAX_SHARE_DECRYPTS
 * (openkey apps/api/src/services/device-authorization.ts, deviceRequestPermissions).
 */
export function deviceRefusal(entries: readonly PermissionEntry[]): PermissionEntry | "secrets" | undefined {
  let shareDecrypts = 0;
  for (const entry of entries) {
    if (entry.space === "secrets" || entry.space?.endsWith(":secrets") === true) return "secrets";
    if (entry.service !== ENCRYPTION_PERMISSION_SERVICE) continue;
    if (!isDeviceShareDecrypt(entry)) return entry;
    shareDecrypts += 1;
    if (shareDecrypts > DEVICE_MAX_SHARE_DECRYPTS) return entry;
  }
  return undefined;
}

const DEVICE_DECRYPT_ALLOWED = `tinycloud.encryption/decrypt on one shared file (space "default", path "share/<id>"), at most ${DEVICE_MAX_SHARE_DECRYPTS} per request`;

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
