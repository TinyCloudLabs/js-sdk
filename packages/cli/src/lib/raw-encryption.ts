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

/**
 * The first entry OpenKey's device flow refuses: any entry in a secrets space ("secrets"), or any encryption entry
 * under its full or short service name, in any case. Device sign-in grants no encryption ability (TC-3204). Other
 * spellings are refused by OpenKey's exact device allowlist (openkey apps/api/src/services/device-flow-abilities.ts).
 */
export function deviceRefusal(entries: readonly PermissionEntry[]): PermissionEntry | "secrets" | undefined {
  for (const entry of entries) {
    if (entry.space === "secrets" || entry.space?.endsWith(":secrets") === true) return "secrets";
    if (/^(?:tinycloud\.)?encryption$/i.test(entry.service)) return entry;
  }
  return undefined;
}

/**
 * The DEVICE_AUTH_UNSUPPORTED_SCOPE message: what was refused and how to approve it instead. `subject` ("this
 * manifest", "this request") names who asked for the secrets space. Request text is escaped and clipped.
 */
export function deviceRefusalMessage(refused: PermissionEntry | "secrets", subject: string): string {
  if (refused === "secrets") {
    return `--device can't authorize the secrets space, and ${subject} asks for it. ` +
      "Run the command without --device to approve in a browser, or use --paste.";
  }
  const actions = refused.actions.slice(0, 5).map((action) => safeClipped(action)).join(", ") || "no actions";
  return `--device can't ask for ${actions} on space "${safeClipped(refused.space ?? "")}", path "${safeClipped(refused.path)}"` +
    `${refused.caveats?.length ? " with extra limits" : ""}, because device sign-in can't decrypt. ` +
    "Run the command without --device to approve in a browser, or remove the tinycloud.encryption entry.";
}
