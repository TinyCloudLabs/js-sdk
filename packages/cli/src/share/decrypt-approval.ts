import { extractSiweExpiration, type PermissionEntry, type TinyCloudNode } from "@tinycloud/node-sdk";
import { resolveDeviceApiHost, runDeviceAuthorization } from "../auth/device-auth.js";
import { keyToDID } from "../auth/local-key.js";
import { pinnedOwner } from "../auth/scoped-login.js";
import { activateAndStoreOpenKeyGrants, portableFromOpenKeyDelegation } from "../commands/auth.js";
import { DEFAULT_SHARE_ORIGIN, ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { ProfileManager } from "../config/profiles.js";
import { permissionsFromDelegation } from "../lib/permissions.js";
import { DECRYPT_APPROVAL_MESSAGES } from "./decrypt-approval-messages.js";

/** OpenKey signs no delegation shorter than this. */
const MIN_APPROVAL_LIFETIME_MS = 60_000;

/**
 * The approval's lifetime: what remains of the session's stored expiry, to
 * the second, with that expiry as the latest the signed grant may carry.
 * Undefined when the session has no readable expiry or too little left.
 */
function sessionLifetime(node: TinyCloudNode): { readonly durationMs: number; readonly notAfterMs: number } | undefined {
  const siwe = node.restorableSession?.siwe;
  if (siwe === undefined) return undefined;
  let notAfterMs: number;
  try {
    notAfterMs = Math.floor(extractSiweExpiration(siwe).getTime() / 1000) * 1000;
  } catch {
    return undefined;
  }
  const durationMs = Math.floor((notAfterMs - Date.now()) / 1000) * 1000;
  return durationMs < MIN_APPROVAL_LIFETIME_MS ? undefined : { durationMs, notAfterMs };
}

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
  // The approval must name one owner. Without a pinned owner, OpenKey's signer would go unchecked.
  const owner = pinnedOwner(profile);
  if (owner === undefined) {
    throw new CLIError("DECRYPT_APPROVAL_OWNER_UNPINNED", DECRYPT_APPROVAL_MESSAGES.ownerUnpinned, ExitCode.PERMISSION_DENIED);
  }
  const expiry = sessionLifetime(input.node);
  if (expiry === undefined) {
    throw new CLIError("DECRYPT_APPROVAL_SESSION_UNUSABLE", DECRYPT_APPROVAL_MESSAGES.sessionUnusable, ExitCode.PERMISSION_DENIED);
  }
  const permissions = shareDecryptApprovalPermissions();
  process.stderr.write(`${DECRYPT_APPROVAL_MESSAGES.notice}\n`);
  const approval = await runDeviceAuthorization({
    sessionDid: keyToDID(key),
    jwk: key,
    nodeOrigin: profile.host,
    shareOrigin: DEFAULT_SHARE_ORIGIN,
    permissions,
    expiry,
    reason: DECRYPT_APPROVAL_MESSAGES.reason,
    expectedOwner: owner,
    openkeyHost: resolveDeviceApiHost(profile),
    decryptOnly: true,
  });
  const delegation = portableFromOpenKeyDelegation(approval.session, permissions, profile.host, {
    key,
    sessionDid: profile.sessionDid ?? profile.did,
    expectedOwner: owner,
    expiry,
    exactApproval: true,
    decryptOnly: true,
  });
  await activateAndStoreOpenKeyGrants(
    input.profileName,
    profile.host,
    input.node,
    [{ delegation, effective: permissionsFromDelegation(delegation) }],
    "cli",
  );
}
