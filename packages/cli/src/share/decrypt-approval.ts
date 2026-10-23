import { extractSiweExpiration, type PermissionEntry, type TinyCloudNode } from "@tinycloud/node-sdk";
import { DEVICE_DELEGATION_MAX_SECONDS, resolveDeviceApiHost, runDeviceAuthorization } from "../auth/device-auth.js";
import { keyToDID } from "../auth/local-key.js";
import { CLOCK_SKEW_MS, pinnedOwner } from "../auth/scoped-login.js";
import { activateAndStoreOpenKeyGrants, portableFromOpenKeyDelegation } from "../commands/auth.js";
import { DEFAULT_SHARE_ORIGIN, ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { ProfileManager } from "../config/profiles.js";
import { permissionsFromDelegation } from "../lib/permissions.js";
import { DECRYPT_APPROVAL_MESSAGES } from "./decrypt-approval-messages.js";

/** OpenKey signs no delegation shorter than this. */
const MIN_APPROVAL_LIFETIME_MS = 60_000;

/**
 * The longest this step waits for the owner to approve, within OpenKey's own
 * 10-minute transaction. OpenKey starts the delegation's lifetime when the
 * owner approves, so a slower approval ends the wait here, and no grant is
 * signed past the sign-in's end.
 */
export const DECRYPT_APPROVAL_WINDOW_MS = 10 * 60_000;

/**
 * The approval's lifetime: the time left until the session's stored expiry,
 * less the approval window and the clock-skew allowance, to the second and at
 * most the device route's maximum. With the owner approving no later than the
 * window, the signed grant then ends no later than the session. `notAfterMs` is
 * that end, held as a hard limit on the signed expiry. Undefined when the
 * session has no expiry or the lifetime would be under a minute. An unparseable
 * expiry throws.
 */
function sessionLifetime(node: TinyCloudNode): { readonly durationMs: number; readonly notAfterMs: number } | undefined {
  const siwe = node.restorableSession?.siwe;
  if (siwe === undefined) return undefined;
  const sessionExpiry = extractSiweExpiration(siwe);
  if (sessionExpiry === undefined) return undefined;
  const notAfterMs = Math.floor(sessionExpiry.getTime() / 1000) * 1000;
  const lifetimeMs = Math.floor((notAfterMs - Date.now() - DECRYPT_APPROVAL_WINDOW_MS - CLOCK_SKEW_MS) / 1000) * 1000;
  if (lifetimeMs < MIN_APPROVAL_LIFETIME_MS) return undefined;
  return { durationMs: Math.min(lifetimeMs, DEVICE_DELEGATION_MAX_SECONDS * 1000), notAfterMs };
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
export async function approveShareDecrypt(input: {
  readonly profileName: string;
  readonly node: TinyCloudNode;
  /** Sleep between approval polls; a test seam. */
  readonly wait?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
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
    approvalWindowMs: DECRYPT_APPROVAL_WINDOW_MS,
    ...(input.wait === undefined ? {} : { wait: input.wait }),
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
