import type { PermissionEntry, TinyCloudNode } from "@tinycloud/node-sdk";
import { resolveDeviceApiHost, runDeviceAuthorization } from "../auth/device-auth.js";
import { keyToDID } from "../auth/local-key.js";
import { pinnedOwner } from "../auth/scoped-login.js";
import { activateAndStoreOpenKeyGrants, portableFromOpenKeyDelegation } from "../commands/auth.js";
import { DEFAULT_SHARE_ORIGIN } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import { permissionsFromDelegation } from "../lib/permissions.js";
import { DECRYPT_APPROVAL_MESSAGES } from "./decrypt-approval-messages.js";

/** Lifetime of the one-hour decrypt approval; OpenKey caps decrypt-only device requests at 3600 s. */
export const DECRYPT_APPROVAL_TTL_SECONDS = 3540;

/** The single entry OpenKey admits in a decrypt-only device request. */
export function shareDecryptApprovalPermissions(): PermissionEntry[] {
  return [{ service: "tinycloud.encryption", space: "default", path: "", actions: ["tinycloud.encryption/decrypt"] }];
}

/**
 * Ask the owner for one decrypt-only approval, verify it, and store it as a
 * runtime grant. The existing session is not replaced. Throws when the
 * approval is refused, expires, or does not cover the whole request.
 */
export async function approveShareDecrypt(input: { readonly profileName: string; readonly node: TinyCloudNode }): Promise<void> {
  const profile = await ProfileManager.getProfile(input.profileName);
  const key = await ProfileManager.getKey(input.profileName);
  if (!profile || !key) throw new Error(`No signed-in key for profile "${input.profileName}".`);
  const permissions = shareDecryptApprovalPermissions();
  const expiry = { durationMs: DECRYPT_APPROVAL_TTL_SECONDS * 1000 };
  const approval = await runDeviceAuthorization({
    sessionDid: keyToDID(key),
    jwk: key,
    nodeOrigin: profile.host,
    shareOrigin: DEFAULT_SHARE_ORIGIN,
    permissions,
    expiry,
    reason: DECRYPT_APPROVAL_MESSAGES.reason,
    expectedOwner: pinnedOwner(profile),
    openkeyHost: resolveDeviceApiHost(profile),
  });
  const delegation = portableFromOpenKeyDelegation(approval.session, permissions, profile.host, {
    key,
    sessionDid: profile.sessionDid ?? profile.did,
    expectedOwner: pinnedOwner(profile),
    expiry,
    exactApproval: true,
  });
  await activateAndStoreOpenKeyGrants(
    input.profileName,
    profile.host,
    input.node,
    [{ delegation, effective: permissionsFromDelegation(delegation) }],
    "cli",
  );
}
