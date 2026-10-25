import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { IncomingMessage } from "node:http";
import { TinyCloudNode, grantAuthRequest, principalDidEquals, REPLICA_LOGOUT_PENDING_FILE, signedCompactUcanExpiry, type AuthDelegationArtifact, type PermissionEntry, type PortableDelegation, type RuntimeDelegationActivator, type TinyCloudSession } from "@tinycloud/node-sdk";
import type { ProfileReplicaApprovalEntry, ProfileReplicaDeferredToken, ProfileReplicaLogoutPending, ProfileReplicaPreflight, ProfileReplicaPurge } from "@tinycloud/sdk-services/kv/replication";
import { composeManifestRequest, extractRecapAttenuations } from "@tinycloud/sdk-core";
import { invokeOperation } from "@tinycloud/operations";
import { namedProfilePath, profilePath } from "@tinycloud/operations/state";
import { principalHashOf, readGateSnapshot, REPLICA_DENY_FLOOR_FILE } from "@tinycloud/replica/profile-gate";
import { isReplicaError, ReplicaErrorCode } from "@tinycloud/replica";
import { REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";
import { ProfileManager } from "../config/profiles.js";
import { logoutInventorySnapshot, planLogoutRevocations, type LogoutRevocationPlan } from "../lib/logout-revocation.js";
import { assertShareHistoryAllowsKeyDrop } from "../share/history-guard.js";
import {
  assertPendingLogoutOwner, assertPendingRemoteLogoutSession, clearProfileCredentials, eraseApprovedLegacyReplicas,
  finishLegacyReplicaCleanup, gateHeldByAnotherAccount, profilePurge, recoverPendingLogout, refuseRestoredGate,
} from "../lib/logout-pending.js";
import {
  outputJson,
  outputWarnings,
  operationWarnings,
  shouldOutputJson,
  formatField,
  formatTable,
  isInteractive,
  withSpinner,
} from "../output/formatter.js";
import { handleError, CLIError, cliErrorFromService } from "../output/errors.js";
import { ExitCode, DEFAULT_CHAIN_ID, DEFAULT_OPENKEY_HOST, DEFAULT_SHARE_ORIGIN } from "../config/constants.js";
import {
  resolveProfileOperatorType,
  resolveProfilePosture,
  type AuthMethod,
  type CLIContext,
  type ProfileConfig,
} from "../config/types.js";

/**
 * Resolve the OpenKey base URL for a profile.
 * Order: TC_OPENKEY_HOST env override → profile.openkeyHost → default.
 *
 * No prompts, no migration. To use a self-hosted OpenKey for a profile,
 * edit `~/.tinycloud/profiles/<profile>/profile.json` and add an
 * "openkeyHost": "https://openkey.localhost" field.
 */
function resolveOpenKeyHost(profile: ProfileConfig): string {
  return process.env.TC_OPENKEY_HOST ?? profile.openkeyHost ?? DEFAULT_OPENKEY_HOST;
}
import { startAuthFlow } from "../auth/browser-auth.js";
import {
  acquireDeviceDelegation,
  loginWithDeviceAuthorization,
  resolveDeviceApiHost,
} from "../auth/device-auth.js";
import { ensureSpaceSetup } from "../auth/space-setup.js";
import {
  expectedOwnerFor,
  declinedPermissions,
  parseRequestedExpiry,
  pinnedOwner,
  grantRequestPermissions,
  scopedLoginPermissions,
  validateLoginPermissions,
  verifyScopedLogin,
  type VerifiedScopedSession,
  isRawCidRevocationPermission,
  verifySignedSession,
  type RequestedExpiry,
  openKeyExpiryParam,
  withVerifiedAuthority,
  ownerSpaceId,
  sessionStateIsUsable,
  storedSessionState,
  type StoredSessionState,
} from "../auth/scoped-login.js";
import { assertNoCaveatLimits } from "../lib/caveat-refusal.js";
import { isRawEncryptionPermission, isVerifiedRawEncryptionPermission } from "../lib/raw-encryption.js";
import { canonicalOwnerDid } from "../lib/owner-did.js";
import { assertNotLocalOwner, assertSessionReplaceable, commitLogin, readProfileSnapshot } from "../auth/login-commit.js";
import { ownerIdentitySigner, startPreparedOpenKeyHandoff, type PreparedOpenKeyHandoff } from "../auth/prepared-openkey.js";
import { announceFirstOwner, openKeyPrimaryFlag, ownerLoginPermissions, warnIfNotPrimaryKey, withOwnerKeyPrimary } from "../auth/owner-key.js";
import { SHARE_PUBLISHING_MANIFEST_REF } from "../share/publishing-manifest.js";
import {
  generateLocalIdentity,
  deriveAddress,
  addressToDID,
  localKeySignIn,
  generateKey,
  keyToDID,
} from "../auth/local-key.js";
import { createCliReplicationConfig } from "../lib/replication-config.js";
import { theme } from "../output/theme.js";
import { registerAuthGrantsCommand } from "./auth-grants.js";
import { bootstrapDelegatedSession, ensureAuthenticated, type DelegatedSessionBootstrap } from "../lib/sdk.js";
import { signInAgainHint, withSignInHint } from "../auth/session-expired.js";
import { delegationExpiredError, isActivationExpiry } from "../auth/delegation-expiry.js";
import { normalizePkhIdentifier } from "../lib/space.js";
import {
  appendLocalGrantArtifact,
  appendAdditionalDelegation,
  appendAdditionalDelegationIfUnexpired,
  appendAdditionalDelegations,
  appendPermissionRequestArtifact,
  createPermissionRequestArtifact,
  getLastPermissionRequestArtifact,
  getPermissionRequestArtifact,
  isCompatiblePermissionRequestArtifact,
  isPermissionRequestArtifact,
  appendGrantHistory,
  cliGrantRecord,
  compactPermission,
  loadAdditionalDelegations,
  loadManifestPermissions,
  loadPermissionRequest,
  parseCapSpec,
  permissionsFromDelegation,
  readGrantHistory,
  resolvePermissionSpaces,
  storedAdditionalDelegation,
  type PermissionRequestArtifact,
} from "../lib/permissions.js";
import { approvalNotices } from "../lib/approval-notices.js";
import {
  APPS_AGENT_EXPIRY,
  APPS_AGENT_EXPIRY_DAYS,
  APPS_AGENT_MAX_APPS,
  APPS_AGENT_PRESET,
  APPS_AGENT_SPACE,
  appsAgentPermissions,
  appsAgentScopeNotice,
  assertRequestFields,
  describeGrantScope,
  entriesForSigning,
  finalizeSigningEntries,
  resolveAppsAgentRequest,
} from "../lib/apps-agent-preset.js";
import { permissionConsentLine, signExtrasQuestion } from "../lib/consent-text.js";
import { assertNodeSupportsNamedKeys, keyAbilitiesFor, parseKeysPrefix, partialKeysGrantError, type ProfileNamedKeys } from "../lib/named-keys.js";
import { buildReplicationLoginRequest, type ReplicationLoginOptions } from "../auth/replication-login.js";

/** The one function dependency used by owner OpenKey permission acquisition. */
export type OpenKeyAcquisition = typeof startAuthFlow;

/**
 * Prompt user to choose an auth method interactively.
 * Returns "local" for non-interactive (CI/headless) environments.
 */
async function promptAuthMethod(): Promise<AuthMethod> {
  if (!isInteractive()) {
    return "openkey";
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise<AuthMethod>((resolve) => {
    process.stderr.write("\n" + theme.heading("Choose authentication method:") + "\n");
    process.stderr.write(`  ${theme.accent("1)")} OpenKey ${theme.muted("(browser-based, for interactive use)")}\n`);
    process.stderr.write(`  ${theme.accent("2)")} Local key ${theme.muted("(Ethereum private key, for agents/CI)")}\n\n`);

    rl.question("Enter choice [1]: ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === "2" || trimmed.toLowerCase() === "local") {
        resolve("local");
      } else {
        resolve("openkey");
      }
    });
  });
}


/** A keep request is safe only when no flag-owned partition or durable gate can exist. */
async function hasGatedReplicaState(profile: ProfileConfig, name: string, replicationEnabled: boolean): Promise<boolean> {
  if (replicationEnabled || profile.replication !== undefined) return true;
  const root = profilePath(name);
  for (const path of [join(root, REPLICA_GATE_FILE), join(root, REPLICA_LOGOUT_PENDING_FILE), join(root, "replication")]) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      throw new CLIError("INVALID_ARGUMENT",
        "Cannot prove this profile has no gated replica state; --keep-replicas refused without changing session or files.",
        ExitCode.USAGE_ERROR);
    }
  }
  return false;
}

/** A markerless logout is safe only when no on-disk replica root survives. */
async function existingReplicaRoots(profile: string): Promise<string[]> {
  const roots: string[] = [];
  for (const name of ["replicas", "replication"]) {
    try {
      await lstat(join(profilePath(profile), name));
      roots.push(name);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return roots;
}

function displayLogoutInventory(approval: ProfileReplicaPreflight, discardLocalChanges: boolean): void {
  if (approval.unknownPaths.length === 0 && !discardLocalChanges) return;
  process.stderr.write(`Local replica paths requiring explicit discard approval: ${JSON.stringify({
    paths: approval.unknownPaths,
    unknownEntries: approval.unknownEntries,
    knownRoots: approval.knownRoots.map(({ path, dev, ino }) => ({ path, kind: "directory", dev, ino })),
    knownEntries: approval.knownEntries,
    missingDatabases: approval.missingDatabases.map((path) => ({ path, kind: "missing", dev: "", ino: "" })),
  })}\n`);
}

async function preflightLogout(
  purge: ProfileReplicaPurge, principal: string, discardLocalChanges: boolean,
): Promise<ProfileReplicaPreflight> {
  // The permissive pass is only an inventory, never deletion authority. Show
  // identities before the strict check or a marker/online request.
  const approval = await purge.preflightLogout({ principal, discardLocalChanges: true });
  displayLogoutInventory(approval, discardLocalChanges);
  if (!discardLocalChanges) await purge.preflightLogout({ principal });
  return approval;
}

/** Gate and deny-floor bytes and inodes plus the replica roots, read without interpreting them. */
async function logoutGateSnapshot(profile: string): Promise<string> {
  const files = await Promise.all([REPLICA_GATE_FILE, REPLICA_DENY_FLOOR_FILE].map(async (name) => {
    const path = join(profilePath(profile), name);
    try {
      const file = await lstat(path, { bigint: true });
      return { bytes: await readFile(path, "utf8"), dev: String(file.dev), ino: String(file.ino) };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }));
  return JSON.stringify({ files, roots: await existingReplicaRoots(profile) });
}

export interface PreparedRemoteLogout {
  readonly profile: ProfileConfig;
  readonly ownerDid: string;
  readonly sessionCid: string;
  readonly sessionSnapshot: string;
  readonly profileSnapshot: string;
  readonly inventorySnapshot: string;
  readonly gateSnapshot?: string;
  readonly token?: ProfileReplicaDeferredToken;
  readonly marker: ProfileReplicaLogoutPending | null;
  /** The inventory displayed before the online requests; another account's logout erases its legacy part. */
  readonly approval: ProfileReplicaPreflight;
  readonly node: TinyCloudNode;
}

interface CompletedOnlineLogout extends PreparedRemoteLogout {
  readonly plan: LogoutRevocationPlan;
}

/** Fsync the exact approved inventory, then deny local reads before any CID request. */
export async function prepareProfileRemoteLogout(
  ctx: CLIContext, expectedSessionCid?: string, discardLocalChanges = false,
): Promise<PreparedRemoteLogout> {
  const selected = await ProfileManager.withLock(ctx.profile, async () => {
    const profile = await ProfileManager.getProfile(ctx.profile);
    const session = await ProfileManager.getSession(ctx.profile);
    const ownerDid = session && "ownerDid" in session && typeof session.ownerDid === "string"
      ? session.ownerDid : undefined;
    const sessionCid = session && "delegationCid" in session && typeof session.delegationCid === "string"
      ? session.delegationCid : undefined;
    if (!session || !ownerDid || !sessionCid) {
      throw new CLIError("AUTH_REQUIRED", "Online revocation needs a stored owner session and delegation CID; no local files were deleted.", ExitCode.AUTH_REQUIRED);
    }
    if (expectedSessionCid !== undefined && sessionCid !== expectedSessionCid) {
      throw new CLIError("PROFILE_CHANGED_DURING_REVOKE",
        "The current sign-in session changed before node revocation; no replica denial or online request was attempted.",
        ExitCode.ERROR);
    }
    const purge = profilePurge(ctx.profile);
    const approval = await preflightLogout(purge, ownerDid, discardLocalChanges);
    const prepare = () => purge.prepareLogoutPending({
      principal: ownerDid, approval, discardLocalChanges, remotePending: true,
    });
    let marker = await prepare();
    let token: ProfileReplicaDeferredToken | undefined;
    if (marker?.v === 1) {
      // The v1 pre-remote fence is this marker's own deferred denial, bound to it by epoch.
      if (marker.deniedEpoch === undefined) {
        const denied = await purge.deny({ reason: "sign_out", principal: ownerDid }, { deferErase: true });
        if (denied.status !== "denied") {
          throw new CLIError("REPLICA_GATED",
            `Durable deferred denial failed (${denied.status}); no online revoke or local erase was attempted.`,
            ExitCode.ERROR);
        }
        marker = await prepare();
        if (marker?.v !== 1 || marker.deniedEpoch !== denied.lifecycleEpoch) {
          throw new CLIError("REPLICA_GATED",
            "The deferred denial was not recorded on the logout marker; no online revoke or local erase was attempted.",
            ExitCode.ERROR);
        }
        token = denied.resumeToken;
      } else {
        const current = await purge.deferredErase();
        if (!current || current.deniedEpoch !== marker.deniedEpoch || current.principalHash !== marker.principalHash) {
          throw new CLIError("REPLICA_GATED",
            "The pending revocation belongs to a different session; no online revoke or local erase was attempted.",
            ExitCode.ERROR);
        }
        token = current;
      }
    }
    return {
      profile, ownerDid, sessionCid,
      sessionSnapshot: JSON.stringify(session),
      profileSnapshot: JSON.stringify(profile),
      inventorySnapshot: await logoutInventorySnapshot(ctx.profile),
      marker, token, approval,
      ...(marker === null ? { gateSnapshot: await logoutGateSnapshot(ctx.profile) } : {}),
    };
  });
  if (selected.profile.authMethod !== "local" || !selected.profile.privateKey) {
    throw new CLIError("REVOCATION_AUTHORITY_UNAVAILABLE",
      "OpenKey owner CID revocation requires a verified signed revoke-control grant or wallet proof. No CID was revoked; session, key and replica files remain for retry, while local replica reads stay denied.",
      ExitCode.AUTH_REQUIRED, { hint: "Obtain verified owner revoke authority before retrying `auth logout --revoke`, or use plain `auth logout` to end this local session without node revocation." });
  }
  const signerDid = addressToDID(
    await deriveAddress(selected.profile.privateKey),
    selected.profile.chainId ?? DEFAULT_CHAIN_ID,
  );
  if (!principalDidEquals(signerDid, selected.ownerDid)) {
    throw new CLIError("REVOCATION_AUTHORITY_UNAVAILABLE",
      "The local owner key does not match the signed session owner. No CID was revoked; session, key and replica files remain for retry, while local replica reads stay denied.",
      ExitCode.AUTH_REQUIRED);
  }
  const node = await ensureAuthenticated(
    { ...ctx, replication: false },
    selected.marker
      ? { pendingRemoteLogout: { marker: selected.marker, ownerDid: selected.ownerDid, sessionCid: selected.sessionCid } }
      : undefined,
  );
  return { ...selected, node };
}

async function revokeForLogout(ctx: CLIContext, discardLocalChanges: boolean): Promise<CompletedOnlineLogout> {
  const selected = await prepareProfileRemoteLogout(ctx, undefined, discardLocalChanges);
  try {
    // No profile lock spans node requests; the durable marker denies local
    // reads. Revalidate the exact retained authority before each CID.
    const plan = await planLogoutRevocations({
      profileName: ctx.profile, profile: selected.profile,
      session: { ownerDid: selected.ownerDid, delegationCid: selected.sessionCid },
      host: ctx.host, node: selected.node,
    });
    for (const cid of plan.cids) {
      if (selected.marker) {
        await assertPendingRemoteLogoutSession(ctx.profile, {
          marker: selected.marker, ownerDid: selected.ownerDid, sessionCid: selected.sessionCid,
        });
      }
      const result = await selected.node.revokeDelegation(cid);
      if (!result.ok) {
        throw new CLIError("REVOCATION_FAILED",
          `Revocation failed for ${cid}: ${result.error.message}. Session, key, and replica files are retained for retry; local reads stay denied.`,
          ExitCode.ERROR, { cid, hint: `Retry \`${CLI_NAME} auth logout --revoke\` when the node is available.` });
      }
      if (result.data.cid !== cid || result.data.revoked !== true) {
        throw new CLIError("REVOCATION_FAILED",
          `Revocation failed for ${cid}: the node did not confirm that exact CID. Session, key, and replica files are retained for retry.`,
          ExitCode.ERROR, { cid });
      }
    }
    return { ...selected, plan };
  } catch (error) {
    if (error instanceof CLIError && (error.code === "REVOCATION_FAILED" || error.code === "REVOKE_INVENTORY_UNVERIFIED")) throw error;
    throw new CLIError("REVOCATION_FAILED",
      `Revocation failed before local logout: ${error instanceof Error ? error.message : String(error)}. Session, key, and replica files are retained for retry; local reads stay denied.`,
      ExitCode.ERROR, { hint: `Retry \`${CLI_NAME} auth logout --revoke\` when online authority is available.` });
  }
}
/** Complete the same durable local logout after plain logout or an exact-CID node receipt. */
export async function finishProfileLogout(
  ctx: CLIContext,
  options: { keepReplicas?: boolean; discardLocalChanges?: boolean; approveInventory?: string; online?: PreparedRemoteLogout; expectedSessionCid?: string } = {},
): Promise<string[]> {
  const { online } = options;
  let replicasRemoved: string[] = [];
  let cleanupError: unknown;
  await ProfileManager.withLock(ctx.profile, async () => {
    // Refuse a profile that does not exist rather than report it logged out.
    const profile = await ProfileManager.getProfile(ctx.profile);
    if (options.keepReplicas && await hasGatedReplicaState(profile, ctx.profile, ctx.replication)) {
      throw new CLIError("INVALID_ARGUMENT",
        "--keep-replicas is only available for legacy-only profiles without a replica gate or flag-owned state. Run plain `auth logout` to deny and erase local replicas.",
        ExitCode.USAGE_ERROR);
    }
    const session = await ProfileManager.getSession(ctx.profile);
    if (options.expectedSessionCid !== undefined &&
        (!session || !("delegationCid" in session) || session.delegationCid !== options.expectedSessionCid)) {
      throw new CLIError("PROFILE_CHANGED_DURING_REVOKE",
        "The signed-in session changed during node revocation; the new local session and replica files were not erased.",
        ExitCode.ERROR);
    }
    const sessionOwner = session && "ownerDid" in session && typeof session.ownerDid === "string"
      ? session.ownerDid : undefined;
    const principal = sessionOwner ?? profile.ownerDid ?? profile.did;
    const purge = profilePurge(ctx.profile);
    if (online) {
      // A gate removed or rolled back behind its deny floor refuses to read; that is a change too.
      let gateRefusal = "";
      let tokenUnchanged: boolean;
      try {
        if (online.marker === null) {
          // No marker (nothing of ours to fence, or another account's gate): every gate,
          // floor and replica root must be exactly as before the online requests.
          tokenUnchanged = online.gateSnapshot === await logoutGateSnapshot(ctx.profile);
        } else {
          const currentToken = await purge.deferredErase();
          tokenUnchanged = online.token
            ? currentToken?.deniedEpoch === online.token.deniedEpoch &&
              currentToken.principalHash === online.token.principalHash
            : currentToken === null;
        }
      } catch (error) {
        if (!isReplicaError(error, ReplicaErrorCode.GATED)) throw error;
        tokenUnchanged = false;
        gateRefusal = ` ${error.message}`;
      }
      if (!session || JSON.stringify(session) !== online.sessionSnapshot ||
          JSON.stringify(profile) !== online.profileSnapshot ||
          await logoutInventorySnapshot(ctx.profile) !== online.inventorySnapshot ||
          !tokenUnchanged) {
        throw new CLIError("PROFILE_CHANGED_DURING_REVOKE",
          `The profile session, stored grants, or denied gate changed during online revocation; the new session and local files were not erased.${gateRefusal}`,
          ExitCode.ERROR);
      }
    }
    try {
      if (options.keepReplicas) {
        // Only legacy-only profiles reach this branch; the signed-out
        // fence makes retained files inaccessible after credential shred.
        await clearProfileCredentials(ctx.profile, true);
      } else {
        const roots = await existingReplicaRoots(ctx.profile);
        // A successful exact-CID receipt first durably releases the remote
        // hold; a changed local inventory then fails during recovery AFTER
        // credential shred, leaving the marker for explicit reapproval.
        let marker: ProfileReplicaLogoutPending | null;
        let approval: ProfileReplicaPreflight | undefined;
        if (online) {
          approval = online.approval;
          marker = online.marker ? await purge.completeRemoteLogout({ principal }) : null;
        } else {
          let pendingMarker: ProfileReplicaLogoutPending | null = null;
          let remotePending = false;
          try {
            const pending = JSON.parse(await readFile(
              join(profilePath(ctx.profile), REPLICA_LOGOUT_PENDING_FILE), "utf8",
            )) as ProfileReplicaLogoutPending;
            pendingMarker = pending;
            remotePending = pending.remotePending === true;
          } catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
              // No durable logout was started.
            } else {
              throw new CLIError("REPLICA_GATED",
                "The durable replica logout marker is unreadable; credentials and replica files remain for recovery.",
                ExitCode.ERROR);
            }
          }
          // Plain retries of a remote-abandoned marker whose credentials
          // survived are rechecked against the approved inventory before
          // recovery shreds them; other plain retries recover below.
          if (pendingMarker?.remoteAbandoned === true && !remotePending &&
              profile.authSignedOut !== true && options.approveInventory === undefined) {
            // A crash after the plain override leaves credentials intact. Recheck
            // the complete approved inventory before the facade's guarded
            // owner/version validation and credential shred.
            const approval = await preflightLogout(purge, principal, pendingMarker.discardLocalChanges === true);
            if (JSON.stringify(pendingMarker.approvedUnknown) !== JSON.stringify(approval.unknownEntries) ||
                JSON.stringify(pendingMarker.knownRoots) !== JSON.stringify(approval.knownRoots) ||
                JSON.stringify(pendingMarker.knownEntries) !== JSON.stringify(approval.knownEntries) ||
                JSON.stringify(pendingMarker.missingDatabases) !== JSON.stringify(approval.missingDatabases)) {
              throw new CLIError("REPLICA_GATED",
                "Replica inventory changed after plain logout was committed; credentials and files remain, and the durable marker still denies local reads.",
                ExitCode.ERROR);
            }
            marker = pendingMarker;
          } else if (pendingMarker && !remotePending &&
              options.approveInventory === undefined && options.discardLocalChanges !== true) {
            // A committed local marker is the durable approval whether or not
            // credential shred finished; strict preflight would mistake our own
            // denied gate for orphaned data. Intended, as in startup recovery:
            // recovery shreds credentials BEFORE its inventory check, so a
            // changed inventory exits REPLICA_PURGE_FAILED signed out, with the
            // marker still denying reads (CONTRACT §2), pending explicit
            // reapproval. The remoteAbandoned branch above differs: it rechecks
            // inventory first and keeps credentials on a mismatch.
            if (session) assertPendingLogoutOwner(ctx.profile, pendingMarker.principalDigest, principal);
            marker = pendingMarker;
          } else {
            // A changed pending inventory must issue its two-command challenge
            // before an unapproved unknown path triggers the ordinary preflight
            // refusal. The facade still refuses any deletion without consent.
            approval = await preflightLogout(
              purge, principal, remotePending || options.discardLocalChanges === true,
            );
            if (options.approveInventory !== undefined && !remotePending) {
              throw new CLIError("INVALID_ARGUMENT",
                "--approve-inventory requires a pending remote logout with changed local files.",
                ExitCode.USAGE_ERROR);
            }
            if (remotePending) {
              try {
                marker = options.approveInventory !== undefined
                  ? await purge.approveChangedPlainLogout({
                      principal, approval, discardLocalChanges: true,
                      inventoryApprovalToken: options.approveInventory,
                    })
                  : await purge.abandonRemoteLogout({
                      principal, approval, discardLocalChanges: options.discardLocalChanges === true,
                    });
              } catch (error) {
                if (error instanceof Error && "inventoryApprovalToken" in error &&
                    "inventoryApprovalEntries" in error && Array.isArray(error.inventoryApprovalEntries)) {
                  // These entries are the locked snapshot hashed into the SDK's
                  // challenge, not the earlier read-only CLI preflight.
                  process.stderr.write(`Inventory approval entries: ${JSON.stringify(
                    error.inventoryApprovalEntries as ProfileReplicaApprovalEntry[],
                  )}\n`);
                  throw new CLIError("REPLICA_GATED", error.message, ExitCode.ERROR);
                }
                throw error;
              }
            } else {
              try {
                marker = pendingMarker && profile.authSignedOut === true && options.discardLocalChanges
                  ? await purge.reapproveLogoutPending({ principal, approval })
                  : await purge.prepareLogoutPending({
                      principal, approval, discardLocalChanges: options.discardLocalChanges === true,
                    });
              } catch (error) {
                if (pendingMarker?.v === 2 && typeof error === "object" && error !== null &&
                    "code" in error && error.code === "REPLICA_GATED" &&
                    "gate" in error && error.gate === "gate_unavailable") {
                  const gatePath = join(namedProfilePath(ctx.profile), REPLICA_GATE_FILE);
                  throw new CLIError("REPLICA_GATED",
                    `A damaged lock file from an interrupted logout; move it aside and re-run \`tc auth logout\`: ${gatePath}. ` +
                    "Inspect it first to ensure it is not a valid replacement. " +
                    (profile.authSignedOut === true
                      ? "The profile is already signed out; credentials remain removed, while replica data and the marker stay intact."
                      : "Credentials and data stay intact; the marker remains and cleanup did not proceed."),
                    ExitCode.ERROR);
                }
                throw error;
              }
            }
          }
        }
        if (marker) {
          const legacyRemoved: string[] = [];
          const report = await purge.recoverLogoutPending({
            signal: new AbortController().signal,
            clearCredentials: () => clearProfileCredentials(ctx.profile),
            eraseLegacyReplicas: async (inventory) => {
              legacyRemoved.push(...await eraseApprovedLegacyReplicas(ctx.profile, inventory));
            },
          });
          refuseRestoredGate(report);
          if (report.failed.length || report.remaining) {
            const signedOut = (await ProfileManager.getProfile(ctx.profile)).authSignedOut === true;
            throw new CLIError("REPLICA_PURGE_FAILED",
              `Cleanup incomplete (${report.failed.map(({ code }) => code).join(", ") || `${report.remaining} intents remaining`}); ` +
              (signedOut
                ? "the profile is signed out and the durable marker denies local reads. Re-run `auth logout --discard-local-changes` to review any changed paths and finish cleanup without repeating node revocation."
                : "the durable marker denies local reads; credentials remain for retry. Re-run `auth logout` after fixing the failure."),
              ExitCode.ERROR, { failed: report.failed, remaining: report.remaining });
          }
          replicasRemoved = marker.v === 2 ? roots : [...legacyRemoved, ...report.erased];
        } else if (profile.legacyReplicaCleanup === true || await gateHeldByAnotherAccount(ctx.profile, principal)) {
          // "Logout by another account": no marker, and the active account's gate, floor,
          // partitions and pending state are untouched. The signed-out flag commits first,
          // then both credential files go, then the profile's legacy mirror.
          await clearProfileCredentials(ctx.profile, true, true);
          replicasRemoved = await finishLegacyReplicaCleanup(
            ctx.profile, approval, options.discardLocalChanges === true,
          );
        } else {
          const gate = await readGateSnapshot(profilePath(ctx.profile));
          if (roots.length || (gate && (gate.principalHash !== null || gate.intents.length))) {
            throw new CLIError("REPLICA_GATED",
              "Replica files or pending intents survived without a durable logout marker; credentials remain for retry.",
              ExitCode.ERROR);
          }
          await clearProfileCredentials(ctx.profile, true);
        }
      }
    } catch (error) {
      cleanupError = error instanceof Error && "code" in error && error.code === "REPLICA_GATED"
        ? new CLIError("REPLICA_GATED", error.message, ExitCode.ERROR)
        : error;
    }
  });
  if (cleanupError) throw cleanupError;
  return replicasRemoved;
}

export function registerAuthCommand(program: Command, options?: { openKeyAcquisition?: OpenKeyAcquisition }): void {
  const auth = program.command("auth").description("Authentication management");
  registerAuthGrantsCommand(auth, { openKeyAcquisition: options?.openKeyAcquisition });

  auth
    .command("login")
    .description("Authenticate with TinyCloud")
    .option("--device", "Approve on another device (e.g. a phone) through OpenKey device authorization; requires a KV-scoped --manifest (SQL and secret decrypt need browser or --paste login)")
    .option("--paste", "Wait up to 5 minutes for a signed code from OpenKey on stdin instead of a browser callback (Safari may require paste)")
    .option("--no-popup", "Print the OpenKey URL without opening a browser")
    .option("--method <method>", "Authentication method: local or openkey")
    .option("--manifest <fileOrBase64>", `Request only this manifest's permissions (one space, plus raw encryption network entries such as a secrets decrypt grant); ${SHARE_PUBLISHING_MANIFEST_REF} covers \`${CLI_NAME} share publish\``)
    .option("--expiry <duration>", "OpenKey session lifetime, e.g. 1h or 7d (device login: at most 30d, default 30d)")
    .option("--owner <did>", "Sign in as this owner (did:pkh:eip155:CHAIN:ADDRESS): OpenKey preselects that key, e.g. one that is not the account's primary key, and an approval by any other identity is refused. With --manifest, also names the secrets owner for a manifest's `secrets` on a profile with no recorded owner")
    .option("--replace-session", "Scoped or device login: replace this profile's live session even though the new scope would narrow, change or shorten it (prefer a new profile)")
    .option("--force", "Replica-enabled OpenKey login: replace the stored session key even when recorded shares could not be checked or hold unexpired shares that need the current key")
    .option("--keys <folder>", "Also let this sign-in create and use encryption keys in this folder (for example `qa`). The node must support named keys. With OpenKey, the first time on a profile also needs `--owner`.")
    .option("--replication-prefix <prefix>", "Add replication get+sync authority for a folder prefix ending in /, or root (repeatable)", (prefix: string, values: string[] = []) => [...values, prefix])
    .option("--replication-allow-secrets", "Allow replication of secret material (network-wide decrypt warning)")
    .action(async (options, cmd) => {
      try {
        if (options.device && options.paste) {
          throw new CLIError("INVALID_ARGUMENT", "--device and --paste are mutually exclusive.", ExitCode.USAGE_ERROR);
        }
        const scoped = options.device || options.manifest || options.expiry || options.owner;
        if (scoped && options.method === "local") {
          throw new CLIError("INVALID_ARGUMENT", "--device, --manifest, --expiry and --owner require OpenKey login.", ExitCode.USAGE_ERROR);
        }
        if (options.device && !options.manifest) {
          throw new CLIError(
            "MANIFEST_REQUIRED",
            `Device login requests an explicit scope. Pass --manifest FILE, or --manifest ${SHARE_PUBLISHING_MANIFEST_REF} for Share publishing.`,
            ExitCode.USAGE_ERROR,
          );
        }
        if (options.keys !== undefined && (options.device || options.manifest)) {
          throw new CLIError("INVALID_ARGUMENT", "`--keys` can't be used with `--device` or `--manifest`.", ExitCode.USAGE_ERROR);
        }
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts, { storedSession: "unused" });
        await recoverPendingLogout(ctx.profile);
        const owner = options.owner === undefined ? undefined : canonicalOwnerDid(options.owner);
        const permissions = options.manifest
          ? await loadManifestPermissions(options.manifest, ctx.profile, { allowLogicalSpaces: true, ownerDid: owner, device: options.device === true })
          : undefined;
        const profileConfig = await ProfileManager.getProfile(ctx.profile).catch((error: unknown) => {
          if (error instanceof CLIError && error.code === "PROFILE_NOT_FOUND") return undefined;
          throw error;
        });
        const replicationOptions: ReplicationLoginOptions = {
          prefixes: options.replicationPrefix ?? profileConfig?.replication?.prefixes ?? [],
          ...(options.replicationAllowSecrets === true || profileConfig?.replication?.allowSecrets === true ? { allowSecrets: true } : {}),
          ...(owner === undefined ? {} : { ownerDid: owner }),
        };
        const loginPermissions = permissions === undefined
          ? undefined
          : buildReplicationLoginRequest(permissions, {
            ...replicationOptions,
            ownerOpenKey: options.device !== true && resolveProfilePosture(profileConfig ?? {}) === "owner-openkey",
          });

        // Only an explicit --host becomes the profile's host; TC_HOST and a
        // discovered local node stay one-off.
        const persistHost = globalOpts.host !== undefined;

        if (options.device) {
          const { profile, result } = await loginWithDeviceAuthorization({
            profileName: ctx.profile,
            nodeOrigin: ctx.host,
            shareOrigin: DEFAULT_SHARE_ORIGIN,
            permissions: loginPermissions!,
            ...(options.expiry === undefined ? {} : { expiry: parseRequestedExpiry(parseExpiryOption(options.expiry)!) }),
            reason: "Allow this TinyCloud CLI profile to use the permissions in the requested manifest.",
            expectedOwner: owner,
            replaceSession: options.replaceSession === true,
            persistHost,
          });
          await persistReplicationLogin(ctx.profile, replicationOptions);
          if (replicationOptions.allowSecrets) writeReplicationSecretsWarning();
          reportDeclined(result.declined);
          // OpenKey hosts the space after the approval: wait for it before the first storage call can fail.
          await ensureSpaceSetup({ profile: ctx.profile, host: ctx.host }, result.session, result.session.permissions);
          outputJson({
            authenticated: true,
            profile: ctx.profile,
            did: profile.did,
            ownerDid: result.ownerDid,
            spaceId: result.spaceId,
            host: ctx.host,
            authMethod: "openkey",
            mode: "device",
            scoped: true,
            permissions: result.approved,
            declined: result.declined,
            expiresAt: result.expiresAt,
          });
          return;
        }

        // Determine auth method
        let method: AuthMethod;
        if (options.method) {
          if (options.method !== "local" && options.method !== "openkey") {
            throw new CLIError(
              "INVALID_METHOD",
              `Invalid auth method "${options.method}". Use "local" or "openkey".`,
              ExitCode.USAGE_ERROR,
            );
          }
          method = options.method;
        } else if (options.keys !== undefined) {
          method = (profileConfig?.authMethod === "openkey" || options.paste || options.owner) ? "openkey" : "local";
        } else {
          method = scoped ? "openkey" : await promptAuthMethod();
        }
        if (method === "openkey" && !options.paste && options.popup !== false &&
          !process.stdin.isTTY && !process.stderr.isTTY) {
          throw new CLIError(
            "INTERACTIVE_LOGIN_REQUIRED",
            "Browser login needs a visible approval URL and would wait silently here. Use `--paste` to print the URL and provide the owner's code on stdin.",
            ExitCode.USAGE_ERROR,
          );
        }

        if (method === "local") {
          buildReplicationLoginRequest(undefined, replicationOptions);
          await handleLocalAuth(ctx.profile, ctx.host, { replication: replicationOptions, keys: options.keys });
          await persistReplicationLogin(ctx.profile, replicationOptions);
          if (replicationOptions.allowSecrets) writeReplicationSecretsWarning();
        } else {
          const preparedCommitted = await handleOpenKeyAuth(ctx.profile, ctx.host, {
            paste: options.paste,
            noPopup: options.popup === false,
            permissions: loginPermissions,
            replication: replicationOptions,
            expiry: parseExpiryOption(options.expiry),
            expectedOwner: owner,
            replaceSession: options.replaceSession === true,
            persistHost,
            force: options.force === true,
            keys: options.keys,
          });
          if (!preparedCommitted) await persistReplicationLogin(ctx.profile, replicationOptions);
          if (replicationOptions.allowSecrets) writeReplicationSecretsWarning();
        }
      } catch (error) {
        return handleError(error);
      }
    });

  auth
    .command("logout")
    .description(`Clear the local session and remove local replicas. With --revoke, revoke owner-controlled node grants and the session CID before deleting local files.`)
    .option("--keep-replicas", "Keep legacy replicas only when this profile has no replica gate or flag-owned state")
    .option("--revoke", "Revoke owner-controlled grants and the session CID on the node before local logout")
    .option("--discard-local-changes", "Approve deletion of the exact local replica paths and identities listed before logout; with --revoke, deletion waits for every node receipt")
    .option("--approve-inventory <token>", "After a refused pending remote logout, confirm the exact changed paths printed by the previous command; requires --discard-local-changes")
    .option("--force", "Log out even when recorded shares could not be checked or hold unexpired shares that need the current session key")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts, { storedSession: "unused" });
        if (options.revoke && options.keepReplicas) {
          throw new CLIError("INVALID_ARGUMENT", "--revoke cannot be combined with --keep-replicas.", ExitCode.USAGE_ERROR);
        }
        if (options.discardLocalChanges && options.keepReplicas) {
          throw new CLIError("INVALID_ARGUMENT",
            "--discard-local-changes cannot be combined with --keep-replicas.", ExitCode.USAGE_ERROR);
        }
        if (options.approveInventory !== undefined && !options.discardLocalChanges) {
          throw new CLIError("INVALID_ARGUMENT",
            "--approve-inventory requires --discard-local-changes.", ExitCode.USAGE_ERROR);
        }
        if (options.approveInventory !== undefined && (options.revoke || options.keepReplicas)) {
          throw new CLIError("INVALID_ARGUMENT",
            "--approve-inventory only applies to a separate plain logout after a refused pending remote revocation.",
            ExitCode.USAGE_ERROR);
        }
        if (!options.revoke && !options.force) await assertShareHistoryAllowsKeyDrop(ctx.profile, "logout");
        const online = options.revoke ? await revokeForLogout(ctx, options.discardLocalChanges === true) : undefined;
        const replicasRemoved = await finishProfileLogout(ctx, {
          keepReplicas: options.keepReplicas,
          discardLocalChanges: options.discardLocalChanges,
          approveInventory: options.approveInventory,
          online,
        });
        outputJson({
          profile: ctx.profile,
          authenticated: false,
          replicasRemoved,
          replicasKept: options.keepReplicas === true,
          warning: online
            ? "The node confirmed revocation of the listed CIDs before local logout."
            : options.keepReplicas
              ? "Legacy replica files remain on disk; this local logout clears the session but does not revoke node grants. Purge the files before a future sign-in if they must not be reused."
              : `Logout is local; delegations and grants on the node stay valid until they expire. Use \`${CLI_NAME} delegation revoke <cid>\` to end access now.`,
          ...(online === undefined ? {} : {
            revokedCids: online.plan.cids,
            revocationExcluded: online.plan.excluded,
          }),
        });
      } catch (error) {
        return handleError(error);
      }
    });

  auth
    .command("rotate")
    .description("Rotate the active profile session key")
    .option("--paste", "Use manual paste mode instead of browser callback")
    .option("--no-popup", "Print the OpenKey URL without opening a browser")
    .option("--force", "Rotate even when recorded shares could not be checked or hold unexpired shares that need the current session key")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts, { storedSession: "unused" });
        await rotateAuthKey(ctx.profile, ctx.host, {
          paste: options.paste,
          noPopup: options.popup === false,
          force: options.force === true,
        });
      } catch (error) {
        return handleError(error);
      }
    });

  auth
    .command("status")
    .description("Show current authentication state")
    .action(async (_options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts, { storedSession: "unused" });
        await recoverPendingLogout(ctx.profile);

        const hasKey = await ProfileManager.getKey(ctx.profile);
        const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
        let profile;
        try {
          profile = await ProfileManager.getProfile(ctx.profile);
        } catch {
          profile = null;
        }
        const posture = profile ? resolveProfilePosture(profile) : null;
        const operatorType = profile ? resolveProfileOperatorType(profile) : null;

        const { state: sessionState, expiresAt } = storedSessionState(session, profile);
        const authenticated = sessionStateIsUsable(sessionState);

        if (shouldOutputJson()) {
          outputJson({
            authenticated,
            session: { state: sessionState, expiresAt },
            did: profile?.did ?? null,
            sessionDid: profile?.sessionDid ?? null,
            ownerDid: profile?.ownerDid ?? null,
            ownerKeyPrimary: profile?.ownerKeyPrimary ?? null,
            spaceId: profile?.spaceId ?? null,
            host: ctx.host,
            profile: ctx.profile,
            hasKey: hasKey !== null,
            authMethod: profile?.authMethod ?? null,
            posture,
            operatorType,
            address: profile?.address ?? null,
          });
        } else {
          process.stdout.write(theme.heading("Authentication Status") + "\n");
          process.stdout.write(formatField("Profile", ctx.profile) + "\n");
          process.stdout.write(formatField("Authenticated", authenticated) + "\n");
          process.stdout.write(formatField("Session", describeSession(sessionState, expiresAt)) + "\n");
          process.stdout.write(formatField("Auth Method", profile?.authMethod ?? null) + "\n");
          process.stdout.write(formatField("Posture", posture) + "\n");
          process.stdout.write(formatField("Operator", operatorType) + "\n");
          process.stdout.write(formatField("Host", ctx.host) + "\n");
          process.stdout.write(formatField("DID", profile?.did ?? null) + "\n");
          process.stdout.write(formatField("Session DID", profile?.sessionDid ?? null) + "\n");
          process.stdout.write(formatField("Owner DID", profile?.ownerDid ?? null) + "\n");
          process.stdout.write(formatField("Primary Key", profile?.ownerKeyPrimary ?? "unknown") + "\n");
          process.stdout.write(formatField("Address", profile?.address ?? null) + "\n");
          process.stdout.write(formatField("Space ID", profile?.spaceId ?? null) + "\n");
          process.stdout.write(formatField("Has Key", hasKey !== null) + "\n");
          if (sessionState === "expired" || sessionState === "unverified") {
            process.stdout.write(`\n${signInAgainHint(ctx.profile, posture ?? undefined)}\n`);
          }
        }
      } catch (error) {
        return handleError(error);
      }
    });

  auth
    .command("request")
    .description("Create a TinyCloud permission request artifact")
    .option(
      "--cap <spec>",
      "Capability spec: tinycloud.<service>:<space>:<path>:<actions-csv> (repeatable)",
      (value, previous: string[]) => [...previous, value],
      [],
    )
    .option("--permission <file>", "JSON permission request: { \"permissions\": PermissionEntry[] }")
    .option("--manifest <fileOrBase64>", "Manifest file, base64:<json>, or raw base64 JSON")
    .option(
      "--expiry <duration>",
      "Lifetime of the granted delegation. ms-format string (e.g. \"7d\", \"30m\") or raw milliseconds. Defaults to 7d, capped by the active session's expiry.",
    )
    .option("--emit [file]", "Emit the request artifact to stdout, or write it to file when provided")
    .option("--grant", "Grant the requested permissions immediately with this owner profile")
    .option("--yes", "Skip local-key TTY confirmation", false)
    .option("--no-popup", "Print the OpenKey URL without opening a browser when granting with OpenKey")
    .option("--device", "With --grant: approve on another device (e.g. a phone) through OpenKey device authorization (KV-scoped; SQL needs browser login)")
    .option(
      "--preset <name>",
      `Request a named permission set instead of --cap: ${APPS_AGENT_PRESET} is READ-ONLY on the applications space (kv get/list + sql read, ${APPS_AGENT_EXPIRY_DAYS} days); add --write --app <app_id> to also let the agent change that app's data (see --write)`,
    )
    .option(
      "--app <app_id>",
      `With --preset ${APPS_AGENT_PRESET}: limit the grant to this app's <app_id>/ prefix (recommended); repeat for up to ${APPS_AGENT_MAX_APPS} apps`,
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--write", `With --preset ${APPS_AGENT_PRESET}: also let the agent add and change the named --app apps' data: write their knowledge/ and prefs/ files (kv put) and add, change or delete their table rows (sql write). Their code, manifest and install record stay read-only. Creating, changing or dropping tables is granted only for an app's catalog database (today Health Log's healthlog)`)
    .option("--paste", "With --grant on an OpenKey profile: wait up to 5 minutes for a signed code from OpenKey on stdin instead of a browser callback (use when the browser cannot reach this CLI)")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        // Without --grant, the request records the host it is for and no session is restored.
        const ctx = await ProfileManager.resolveContext(globalOpts, options.grant ? {} : { storedSession: "unused" });
        const profile = await ProfileManager.getProfile(ctx.profile);
        if (options.paste && (!options.grant || options.device || resolveProfilePosture(profile) !== "owner-openkey")) {
          throw new CLIError("INVALID_ARGUMENT", "--paste requires --grant on an OpenKey owner profile and cannot be combined with --device.", ExitCode.USAGE_ERROR);
        }
        if (options.device && (!options.grant || resolveProfilePosture(profile) !== "owner-openkey")) {
          throw new CLIError("INVALID_ARGUMENT", "--device requires --grant on an OpenKey owner profile.", ExitCode.USAGE_ERROR);
        }
        const preset = resolveAppsAgentRequest(options);
        const requested = preset === undefined
          ? await collectRequestedPermissions(options, ctx.profile)
          : await resolvePermissionSpaces(appsAgentPermissions(preset.mode, preset.appIds), ctx.profile);
        const expiryOption = preset === undefined ? parseExpiryOption(options.expiry) : APPS_AGENT_EXPIRY;
        // Before any approval link is printed: the plain-words scope of the grant.
        if (preset !== undefined) process.stderr.write(`\n${appsAgentScopeNotice(preset.mode, preset.appIds)}\n\n`);

        if (requested.length === 0) {
          throw new CLIError(
            "NO_CAPS_REQUESTED",
            "Provide at least one --cap, --permission, or --manifest.",
            ExitCode.USAGE_ERROR,
          );
        }

        if (!options.grant) {
          const artifact = createPermissionRequestArtifact({
            profileName: ctx.profile,
            profile,
            host: ctx.host,
            requested,
            requestedExpiry: expiryOption,
          });
          await appendPermissionRequestArtifact(ctx.profile, artifact);
          await emitPermissionRequestArtifact(artifact, options.emit);
          return;
        }

        if (profile.authMethod === "openkey" || options.device) assertNoCaveatLimits(requested);
        const node = await ensureAuthenticated(ctx);

        // Fast path: master's grantRuntimePermissions / hasRuntimePermissions
        // already does the diff against the live session + existing runtime
        // grants; no need to compute it ourselves.
        if (node.hasRuntimePermissions(requested)) {
          outputJson({ changed: false, missing: [], added: [] });
          return;
        }

        if (profile.authMethod === "openkey" || options.device) {
          const key = await ProfileManager.getKey(ctx.profile);
          if (!key) {
            throw new CLIError("NO_KEY", `No key found for profile "${ctx.profile}". Run \`${CLI_NAME} --profile ${ctx.profile} auth rotate\` to create a new key and sign in.`, ExitCode.AUTH_REQUIRED);
          }
          const openkeyHost = resolveOpenKeyHost(profile);
          const grants: StagedOpenKeyGrant[] = [];
          const expiryCap = expiryOption === undefined ? undefined : parseRequestedExpiry(expiryOption);
          const proof: PortableGrantProof = {
            key,
            sessionDid: profile.sessionDid ?? profile.did,
            expectedOwner: pinnedOwner(profile),
            expiry: expiryCap,
          };
          const declined: PermissionEntry[] = [];
          const groups = groupPermissionsBySpace(requested);
          // OpenKey signs one space per approval; say so before the prompts stall a user at the second.
          const notices = approvalNotices(groups);
          if (notices) process.stderr.write(`${notices.intro}\n`);
          for (const [index, group] of groups.entries()) {
            if (notices) process.stderr.write(`${notices.prompts[index]}\n`);
            const reason = permissionGrantReason(
              `Grant requested TinyCloud permissions from \`${CLI_NAME} auth request --grant\`.`,
              group,
            );
            const request = grantRequestPermissions(group, profile.spaceId ?? profile.spaceName);
            let delegationData: Record<string, unknown>;
            if (options.device) {
              const approval = await acquireDeviceDelegation({
                sessionDid: keyToDID(key),
                jwk: key,
                nodeOrigin: ctx.host,
                shareOrigin: DEFAULT_SHARE_ORIGIN,
                permissions: request,
                expiry: parseRequestedExpiry(expiryOption ?? "7d"),
                reason,
                expectedOwner: pinnedOwner(profile),
                openkeyHost: resolveDeviceApiHost(profile),
              });
              declined.push(...approval.declined);
              delegationData = approval.session;
            } else {
              delegationData = await startAuthFlow(profile.did, {
                jwk: key,
                host: ctx.host,
                permissions: request,
                reason,
                openkeyHost,
                expiry: expiryCap === undefined ? undefined : openKeyExpiryParam(expiryCap),
                noPopup: options.popup === false,
                paste: options.paste,
              });
            }
            const delegation = portableFromOpenKeyDelegation(delegationData, request, ctx.host, proof);
            grants.push({ delegation, effective: permissionsFromDelegation(delegation) });
          }
          await activateAndStoreOpenKeyGrants(ctx.profile, ctx.host, node, grants, options.manifest ? "manifest" : "cli");
          const delegationCids = grants.map(({ delegation }) => delegation.cid);
          const expiry = grants.at(-1)?.delegation.expiry.toISOString();
          reportDeclined(declined);
          outputJson({
            changed: delegationCids.length > 0,
            added: grants.flatMap(({ effective }) => effective),
            delegationCid: delegationCids[0],
            delegationCids,
            expiry,
            ...(options.device ? { declined } : {}),
          });
          return;
        }

        if (isInteractive()) {
          if (!options.yes) {
            await confirmPermissionRequest(requested);
          }
        } else if (!options.yes) {
          throw new CLIError(
            "CONFIRMATION_REQUIRED",
            "Local-key permission requests in non-interactive mode require --yes.",
            ExitCode.USAGE_ERROR,
          );
        }

        // Local-key flow: master's grantRuntimePermissions handles signing
        // through the SDK's wallet-mode signer, groups by space, and skips
        // anything already covered by the session or an existing grant.
        const delegations = await node.grantRuntimePermissions(
          requested,
          expiryOption !== undefined ? { expiry: expiryOption } : undefined,
        );
        await persistCurrentLocalSession(ctx.profile, profile, node.restorableSession, node.replicaStamp);
        const delegationCids: string[] = [];
        let expiry: string | undefined;
        // Sol MAJOR-9: accumulate EFFECTIVE grants across every signed
        // local delegation so the CLI's `added` output matches what was
        // actually granted, never the originally-requested set.
        const localEffective: typeof requested = [];
        for (const delegation of delegations) {
          const covering = permissionsFromDelegation(delegation);
          localEffective.push(...covering);
          await appendAdditionalDelegation(ctx.profile, await cliGrantRecord(node, delegation, covering, ctx.host));
          delegationCids.push(delegation.cid);
          expiry = delegation.expiry.toISOString();
          await appendGrantHistory(ctx.profile, {
            addedCaps: covering,
            source: options.manifest ? "manifest" : "cli",
            delegationCid: delegation.cid,
            expiry,
          });
        }

        if (delegationCids.length === 0) {
          outputJson({ changed: false, missing: [], added: [] });
          return;
        }

        outputJson({
          changed: true,
          added: localEffective,
          delegationCid: delegationCids[0],
          delegationCids,
          expiry,
        });
      } catch (error) {
        return handleError(error);
      }
    });

  auth
    .command("import [source]")
    .description("Import a TinyCloud delegation or permission request artifact")
    .option("--stdin", "Read the JSON artifact from stdin")
    .option("--paste", "Read the JSON artifact from stdin")
    .action(async (source: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const raw = await readAuthArtifactSource(source, {
          stdin: options.stdin === true || options.paste === true,
        });
        const parsed = JSON.parse(raw) as unknown;

        if (isCompatiblePermissionRequestArtifact(parsed)) {
          await appendPermissionRequestArtifact(ctx.profile, parsed);
          outputJson({
            imported: true,
            kind: parsed.kind,
            requestId: parsed.requestId,
            requested: parsed.requested,
            next: `${CLI_NAME} auth retry ${parsed.requestId}`,
          });
          return;
        }

        if (isRequestBoundDelegationEnvelope(parsed)) {
          await importRequestBoundDelegationWithBootstrap(ctx, parsed);
          return;
        }

        const imported = normalizeDelegationImport(parsed);
        // Loaded on use: a static import would evaluate the operations
        // delegation-binding bundle in every command that registers `auth`.
        const { activateUnboundImport, storedDelegationKind, verifiedCompactAudience, STORED_GRANT_SKIP_REASONS } = await import(
          "@tinycloud/operations/delegation-binding"
        );
        const kind = storedDelegationKind({ delegation: imported.delegation });
        if (kind === "refused") {
          throw new CLIError(
            "INVALID_AUTH_IMPORT",
            "Imported delegation must carry exactly one string Authorization header.",
            ExitCode.USAGE_ERROR,
          );
        }
        // Neither a session grant nor a cross-user wallet-mode grant can be
        // imported without verifiable signed bytes. Reject before restoring a
        // session, writing a row, or recording grant history.
        if (kind === "other") {
          throw new CLIError(
            "INVALID_AUTH_IMPORT",
            "Imported delegation must carry verifiable signed proof.",
            ExitCode.USAGE_ERROR,
          );
        }
        // Identify the persisted profile before a session restore can replay
        // old grants, or first-session bootstrap can modify local profile data.
        const profile = await ProfileManager.getProfile(ctx.profile);
        let bootstrap: DelegatedSessionBootstrap | undefined;
        let node;
        try {
          node = await ensureAuthenticated(ctx);
        } catch (error) {
          const session = await ProfileManager.getSession(ctx.profile);
          if (session || resolveProfilePosture(profile) !== "delegate-session") throw error;
          bootstrap = await bootstrapDelegatedSession(ctx, imported.delegation);
          node = bootstrap.node;
        }
        // Only signed compact bytes can classify an import as cross-user.
        // Transport metadata cannot turn a damaged session grant into a silent
        // wallet-mode import. Signed-login proofs are validated by activation.
        const signedAudience = kind === "compact"
          ? verifiedCompactAudience(node as unknown as RuntimeDelegationActivator, imported.delegation)
          : undefined;
        let transportMatchesAudience = false;
        if (signedAudience !== undefined) {
          try {
            transportMatchesAudience = principalDidEquals(imported.delegation.delegateDID, signedAudience);
          } catch {
            // Malformed transport DIDs never qualify as a foreign grant.
          }
        }
        if (kind === "compact" && (signedAudience === undefined || !transportMatchesAudience)) {
          const reason = signedAudience === undefined ? "proof_invalid" : "audience_mismatch";
          const refusal = new CLIError(
            "DELEGATION_REJECTED",
            `Imported delegation was rejected (${reason}). No grant was stored.`,
            ExitCode.ERROR,
          );
          if (bootstrap) await bootstrap.abandon(refusal);
          throw refusal;
        }
        const targetsSessionKey = kind === "signed-login" || (
          signedAudience !== undefined && principalDidEquals(signedAudience, node.sessionDid)
        );
        let importExpiry = imported.delegation.expiry;
        let signedExpiry: Date | undefined;
        if (!targetsSessionKey && kind === "compact") {
          signedExpiry = signedCompactUcanExpiry(imported.delegation.delegationHeader.Authorization);
          if (signedExpiry === undefined || importExpiry.getTime() !== signedExpiry.getTime()) {
            throw new CLIError(
              "DELEGATION_REJECTED",
              "Imported delegation was rejected (authority_invalid). No grant was stored.",
              ExitCode.ERROR,
            );
          }
          if (signedExpiry.getTime() <= Date.now()) throw delegationExpiredError();
          importExpiry = signedExpiry;
        }
        let activated = false;
        let permissions = imported.permissions;
        if (targetsSessionKey) {
          let record;
          try {
            // Activation validates the signed authority before any store write.
            record = await activateUnboundImport(
              node as unknown as RuntimeDelegationActivator,
              imported.delegation,
              ctx.host,
            );
          } catch (error) {
            const candidate = error !== null && typeof error === "object" && "reason" in error
              ? error.reason : undefined;
            const reason = typeof candidate === "string" &&
              (STORED_GRANT_SKIP_REASONS as readonly string[]).includes(candidate)
              ? candidate : "invalid";
            const refusal = isActivationExpiry(error)
              ? delegationExpiredError()
              : new CLIError(
                "DELEGATION_REJECTED",
                `Imported delegation was rejected (${reason}). No grant was stored.`,
                ExitCode.ERROR,
              );
            if (bootstrap) await bootstrap.abandon(refusal);
            throw refusal;
          }
          await appendAdditionalDelegation(ctx.profile, record);
          importExpiry = record.delegation.expiry;
          permissions = record.permissions;
          activated = true;
        } else {
          const record = storedAdditionalDelegation(
            { ...imported.delegation, expiry: importExpiry },
            imported.permissions,
          );
          if (!targetsSessionKey && kind === "compact") {
            if (!await appendAdditionalDelegationIfUnexpired(ctx.profile, record, signedExpiry)) {
              throw delegationExpiredError();
            }
          } else {
            await appendAdditionalDelegation(ctx.profile, record);
          }
        }
        await appendGrantHistory(ctx.profile, {
          addedCaps: permissions,
          source: "cli",
          delegationCid: imported.delegation.cid,
          expiry: importExpiry.toISOString(),
        });

        outputJson({
          imported: true,
          activated,
          kind: "tinycloud.auth.delegation",
          requestId: imported.requestId ?? null,
          delegationCid: imported.delegation.cid,
          permissions,
          expiry: importExpiry.toISOString(),
        });
      } catch (error) {
        return handleError(error);
      }
    });

  auth
    .command("grant [request]")
    .description("Grant a TinyCloud permission request artifact to its requester")
    .option("--stdin", "Read the JSON request artifact from stdin")
    .option("--paste", "Read the JSON request artifact from stdin")
    .option("--yes", "Skip local-key TTY confirmation", false)
    .action(async (source: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const profile = await ProfileManager.getProfile(ctx.profile);
        const raw = await readAuthArtifactSource(source, {
          stdin: options.stdin === true || options.paste === true,
        });
        // The parser's own message quotes the offending text from the file, so it is not passed on.
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new CLIError("INVALID_AUTH_REQUEST", "The request file is not valid JSON.", ExitCode.USAGE_ERROR);
        }

        if (!isCompatiblePermissionRequestArtifact(parsed)) {
          throw new CLIError(
            "INVALID_AUTH_REQUEST",
            "Auth grant requires a tinycloud.auth.request artifact.",
            ExitCode.USAGE_ERROR,
          );
        }
        assertRequestFields(parsed);

        // One resolved list is described, gated and signed. The signer's own defaults (an entry with
        // no space is in the owner's `applications` space) and the profile's name resolution are
        // applied once, here, and the signer then consumes this list rather than re-reading the file.
        const requested = finalizeSigningEntries(
          await resolvePermissionSpaces(entriesForSigning(parsed.requested as PermissionEntry[]), ctx.profile),
        );
        // Before the scope is printed, the session is checked or any prompt is shown.
        if (profile.authMethod === "openkey") assertNoCaveatLimits(requested);
        const [applications] = await resolvePermissionSpaces(
          [{ service: "tinycloud.kv", space: APPS_AGENT_SPACE, path: "", actions: ["tinycloud.kv/get"] }],
          ctx.profile,
        );
        const scope = describeGrantScope(
          requested,
          parsed.requestedExpiry,
          applications!.space ?? APPS_AGENT_SPACE,
          profile.authMethod === "openkey" ? OPENKEY_AGENT_MAX_LIFETIME_MS : undefined,
        );
        process.stderr.write(`\n${scope.text}\n\n`);
        // The request file comes from the agent: anything the apps-agent preset could never grant
        // is signed only after an explicit --yes or an interactive confirmation of the list above.
        // The question is written to stderr and answered on stdin, so those two must be a terminal;
        // stdout may be a file (scripts capture the grant artifact there) without losing the prompt.
        let confirmedExtras = false;
        if (scope.extras.length > 0 && options.yes !== true) {
          if (!process.stdin.isTTY || !process.stderr.isTTY) {
            throw new CLIError(
              "CONFIRMATION_REQUIRED",
              `This request asks for more than the apps-agent preset (${scope.extras.length} entr${scope.extras.length === 1 ? "y" : "ies"} marked ! in the list above). Nothing was signed. Read the list, then re-run with --yes to sign it.`,
              ExitCode.USAGE_ERROR,
            );
          }
          await askYesNo(signExtrasQuestion(scope.extras.length), "Grant cancelled. Nothing was signed.");
          confirmedExtras = true;
        }
        const resolvedRequest = { ...parsed, requested };
        const node = await ensureAuthenticated(ctx);
        let grant: AuthDelegationArtifact;
        if (profile.authMethod === "openkey") {
          assertOpenKeyAgentRequest(requested);
          // The owner approves each agent request in OpenKey, requested fresh for this command:
          // existing runtime or persisted authority and --yes do not skip it. The approval lasts the
          // request's lifetime, capped at the apps-agent default, and the grant lasts as long as it.
          const approval = await acquireOpenKeyApproval({
            ctx,
            profile,
            requested,
            expiryOption: Math.min(
              parseRequestedExpiry(parsed.requestedExpiry ?? APPS_AGENT_EXPIRY).durationMs,
              OPENKEY_AGENT_MAX_LIFETIME_MS,
            ),
            reason: "Grant permissions requested by a TinyCloud auth request artifact.",
            exactApproval: true,
            noPopup: !(process.stdin.isTTY || process.stderr.isTTY),
          });
          // Sign from the approval's own session, so the grant is bounded by that approval
          // and never takes the owner's stored authority.
          const approvalNode = await nodeFromOpenKeyApproval(ctx.host, approval.session);
          grant = {
            ...(await grantAuthRequest(approvalNode, resolvedRequest, {
              expiry: approval.delegation.expiry.getTime() - Date.now(),
            })),
            // The owner approved this grant on the OpenKey approval screen, so it was prompted.
            prompted: true,
          };
          process.stderr.write(`Grant lasts until ${grant.expiry}, the lifetime of the OpenKey approval.\n`);
        } else {
          await ensureDelegationAuthority({
            ctx,
            profile,
            node,
            requested,
            expiryOption: parsed.requestedExpiry,
            reason: "Grant permissions requested by a TinyCloud auth request artifact.",
            yes: options.yes === true || confirmedExtras,
          });

          // The grant logic lives in the SDK (grantAuthRequest) so it is callable
          // programmatically; this command is a thin wrapper. The CLI request
          // artifact is a structural superset of AuthRequestArtifact.
          grant = await grantAuthRequest(node, resolvedRequest);
        }
        await appendLocalGrantArtifact(ctx.profile, grant.delegation);
        await appendGrantHistory(ctx.profile, {
          addedCaps: grant.permissions,
          source: "cli",
          delegationCid: grant.delegationCid,
          expiry: grant.expiry,
        });
        outputJson(grant);
      } catch (error) {
        return handleError(error);
      }
    });

  auth
    .command("retry [requestId]")
    .description("Check whether a stored permission request is now satisfied")
    .option("--last", "Use the latest stored permission request for this profile")
    .option("--exec", "Run the captured command when the request is covered")
    .action(async (requestId: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const artifact = options.last
          ? await getLastPermissionRequestArtifact(ctx.profile)
          : requestId
            ? await getPermissionRequestArtifact(ctx.profile, requestId)
            : null;

        if (!artifact) {
          throw new CLIError(
            "REQUEST_NOT_FOUND",
            options.last
              ? `No stored permission requests exist for profile "${ctx.profile}".`
              : "Provide a requestId or use --last.",
            ExitCode.NOT_FOUND,
          );
        }

        const node = await ensureAuthenticated(ctx);
        const covered = node.hasRuntimePermissions(artifact.requested);
        if (options.exec) {
          if (!covered) {
            throw new CLIError(
              "PERMISSIONS_MISSING",
              `Request ${artifact.requestId} is not covered yet. Import a delegation, then retry with --exec.`,
              ExitCode.PERMISSION_DENIED,
            );
          }
          const command = isPermissionRequestArtifact(artifact) ? artifact.command : undefined;
          if (!command?.argv?.length) {
            throw new CLIError(
              "COMMAND_NOT_CAPTURED",
              `Request ${artifact.requestId} does not include a captured command.`,
              ExitCode.USAGE_ERROR,
            );
          }
          await execCapturedCommand(command);
          return;
        }

        outputJson({
          requestId: artifact.requestId,
          covered,
          missing: covered ? [] : artifact.requested,
          command: isPermissionRequestArtifact(artifact) ? artifact.command ?? null : null,
        });
      } catch (error) {
        return handleError(error);
      }
    });

  auth
    .command("caps")
    .description("Show granted capabilities for the active session")
    .option("--diff <spec>", "Show missing capabilities for a spec")
    .option("--history", "Show recent permission grants")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);

        if (options.history) {
          const history = (await readGrantHistory(ctx.profile)).slice(-20);
          if (shouldOutputJson()) {
            outputJson({ grants: history });
          } else if (history.length === 0) {
            process.stdout.write(theme.muted("No grant history.") + "\n");
          } else {
            process.stdout.write(formatTable(
              ["time", "source", "delegation", "caps"],
              history.map((entry) => [
                entry.ts,
                entry.source,
                entry.delegationCid ?? "",
                entry.addedCaps.map(compactPermission).join("; "),
              ]),
            ) + "\n");
          }
          return;
        }

        const node = await ensureAuthenticated(ctx);
        const runtimeDelegations = node.getRuntimePermissionDelegations();
        // Granted view = permissions covered by appended runtime delegations.
        // The base-session SIWE recap isn't enumerated here because the
        // node-sdk doesn't expose it as a list — `hasRuntimePermissions()`
        // is the trusted answer for "is this covered?".
        const granted = runtimeDelegations.flatMap(permissionsFromDelegation);

        if (options.diff) {
          const requested = [await parseCapSpec(options.diff, ctx.profile)];
          const covered = node.hasRuntimePermissions(requested);
          outputJson({
            requested,
            changed: !covered,
            covered,
            // `missing` retained for backwards-compatible callers.
            missing: covered ? [] : requested,
          });
          return;
        }

        const appended = await loadAdditionalDelegations(ctx.profile);
        if (shouldOutputJson()) {
          outputJson({ granted, appendedDelegations: appended.length });
        } else if (granted.length === 0) {
          process.stdout.write(theme.muted("No appended runtime delegations on this profile.") + "\n");
        } else {
          process.stdout.write(formatTable(
            ["service", "space", "path", "actions"],
            granted.map((entry) => [
              entry.service,
              entry.space,
              entry.path,
              entry.actions.join(", "),
            ]),
          ) + "\n");
        }
      } catch (error) {
        return handleError(error);
      }
    });

  auth
    .command("whoami")
    .description("Show identity information")
    .action(async (_options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts, { storedSession: "unused" });

        const profile = await ProfileManager.getProfile(ctx.profile);
        const session = await ProfileManager.getSession(ctx.profile) as Record<string, unknown> | null;
        const posture = resolveProfilePosture(profile);
        const { state: sessionState, expiresAt } = storedSessionState(session, profile);
        const authenticated = sessionStateIsUsable(sessionState);
        const operatorType = resolveProfileOperatorType(profile);

        if (shouldOutputJson()) {
          outputJson({
            profile: ctx.profile,
            did: profile.did,
            sessionDid: profile.sessionDid ?? null,
            ownerDid: profile.ownerDid ?? null,
            spaceId: profile.spaceId ?? null,
            host: profile.host,
            authenticated,
            session: { state: sessionState, expiresAt },
            authMethod: profile.authMethod ?? null,
            posture,
            operatorType,
            address: profile.address ?? null,
          });
        } else {
          process.stdout.write(theme.heading("Identity") + "\n");
          process.stdout.write(formatField("Profile", ctx.profile) + "\n");
          process.stdout.write(formatField("DID", profile.did) + "\n");
          process.stdout.write(formatField("Session DID", profile.sessionDid ?? null) + "\n");
          process.stdout.write(formatField("Owner DID", profile.ownerDid ?? null) + "\n");
          process.stdout.write(formatField("Auth Method", profile.authMethod ?? null) + "\n");
          process.stdout.write(formatField("Posture", posture) + "\n");
          process.stdout.write(formatField("Operator", operatorType) + "\n");
          process.stdout.write(formatField("Address", profile.address ?? null) + "\n");
          process.stdout.write(formatField("Space ID", profile.spaceId ?? null) + "\n");
          process.stdout.write(formatField("Host", profile.host) + "\n");
          process.stdout.write(formatField("Authenticated", authenticated) + "\n");
          process.stdout.write(formatField("Session", describeSession(sessionState, expiresAt)) + "\n");
        }
      } catch (error) {
        return handleError(error);
      }
    });
}

function describeSession(state: StoredSessionState, expiresAt: string | null): string {
  switch (state) {
    case "missing": return "none";
    case "expired": return `expired ${expiresAt}`;
    case "present": return `active until ${expiresAt}`;
    case "unknown-expiry": return "active (no recorded expiry)";
    case "unverified": return "not usable (no signed OpenKey proof)";
  }
}

async function emitPermissionRequestArtifact(
  artifact: PermissionRequestArtifact,
  emitOption: unknown,
): Promise<void> {
  if (typeof emitOption === "string" && emitOption.length > 0) {
    await mkdir(dirname(emitOption), { recursive: true });
    await writeFile(emitOption, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    outputJson({
      emitted: true,
      path: emitOption,
      requestId: artifact.requestId,
      requested: artifact.requested,
    });
    return;
  }
  outputJson(artifact);
}

export async function readAuthArtifactSource(
  source: string | undefined,
  options: { stdin: boolean },
): Promise<string> {
  if (options.stdin || source === "-" || (!source && !isInteractive())) {
    return readStdin();
  }

  if (!source) {
    throw new CLIError(
      "IMPORT_SOURCE_REQUIRED",
      "Provide an artifact file, URL, or use --stdin.",
      ExitCode.USAGE_ERROR,
    );
  }

  if (source.startsWith("http://") || source.startsWith("https://")) {
    return readUrl(source);
  }

  return readFile(source, "utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readUrl(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const getter = source.startsWith("https://") ? httpsGet : httpGet;
    const request = getter(source, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        readUrl(new URL(response.headers.location, source).toString()).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new CLIError(
          "IMPORT_FETCH_FAILED",
          `Failed to fetch ${source}: HTTP ${status}.`,
          ExitCode.ERROR,
        ));
        return;
      }

      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
  });
}

function normalizeDelegationImport(value: unknown): {
  requestId?: string;
  delegation: PortableDelegation;
  permissions: PermissionEntry[];
} {
  if (isLegacyDelegationImportArtifact(value)) {
    const delegation = normalizePortableDelegation(value.delegation);
    return {
      requestId: value.requestId,
      delegation,
      permissions: Array.isArray(value.permissions) && value.permissions.length > 0
        ? value.permissions
        : permissionsFromDelegation(delegation),
    };
  }

  if (isStoredDelegationLike(value)) {
    const delegation = normalizePortableDelegation(value.delegation);
    return {
      delegation,
      permissions: Array.isArray(value.permissions) && value.permissions.length > 0
        ? value.permissions
        : permissionsFromDelegation(delegation),
    };
  }

  if (isPortableDelegationLike(value)) {
    const delegation = normalizePortableDelegation(value);
    return {
      delegation,
      permissions: permissionsFromDelegation(delegation),
    };
  }

  throw new CLIError(
    "INVALID_AUTH_IMPORT",
    "Auth import must be a tinycloud.auth.delegation artifact, a portable delegation, or a tinycloud.auth.request artifact.",
    ExitCode.USAGE_ERROR,
  );
}

function isLegacyDelegationImportArtifact(value: unknown): value is {
  requestId?: string;
  delegation: PortableDelegation;
  permissions?: PermissionEntry[];
} {
  // A legacy envelope is genuinely unbound only when it has no requestId
  // member. Request-bound v1 shape always belongs to the canonical route,
  // even when its request is stale or unknown locally.
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; version?: unknown; requestId?: unknown; delegation?: unknown };
  return candidate.kind === "tinycloud.auth.delegation" &&
    candidate.version === 1 &&
    !Object.hasOwn(candidate, "requestId") &&
    candidate.delegation !== null &&
    typeof candidate.delegation === "object";
}

function isRequestBoundDelegationEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; version?: unknown; requestId?: unknown; delegation?: unknown };
  return candidate.kind === "tinycloud.auth.delegation" &&
    candidate.version === 1 &&
    Object.hasOwn(candidate, "requestId");
}

type AuthImportOutput = {
  cid: string;
  effectivePermissions: PermissionEntry[];
  expiry: string;
  activated: true;
};

async function importRequestBoundDelegationWithBootstrap(
  ctx: CLIContext,
  artifact: unknown,
): Promise<void> {
  const session = await ProfileManager.getSession(ctx.profile);
  if (session !== null) {
    await importRequestBoundDelegation(ctx, artifact);
    return;
  }

  const profile = await ProfileManager.getProfile(ctx.profile);
  if (resolveProfilePosture(profile) !== "delegate-session") {
    await importRequestBoundDelegation(ctx, artifact);
    return;
  }

  const candidate = artifact as { delegation: PortableDelegation };
  const delegation = normalizePortableDelegation(candidate.delegation);
  const bootstrap = await bootstrapDelegatedSession(ctx, delegation);
  try {
    await importRequestBoundDelegation(ctx, artifact);
  } catch (error) {
    await bootstrap.abandon(error);
  }
}

async function importRequestBoundDelegation(
  ctx: { profile: string; host: string },
  artifact: unknown,
): Promise<void> {
  const result = await invokeOperation(
    "tinycloud.auth.import",
    1,
    // `tc auth import` is a direct human CLI invocation. This explicit opt-in
    // preserves owner-profile imports under the operations owner posture gate;
    // it has no effect on delegate-session execution.
    { profile: ctx.profile, host: ctx.host, allowOwnerProfile: true },
    artifact,
  );

  const warnings = operationWarnings(result.warnings);
  const metadata = warnings.length === 0 ? undefined : { warnings };
  switch (result.status) {
    case "ok": {
      const output = result.output as AuthImportOutput;
      // Diagnostics follow the command's output, never precede a failure of it.
      outputJson({
        imported: true,
        activated: output.activated,
        kind: "tinycloud.auth.delegation",
        requestId: typeof artifact === "object" && artifact !== null &&
          typeof (artifact as { requestId?: unknown }).requestId === "string"
          ? (artifact as { requestId: string }).requestId
          : null,
        delegationCid: output.cid,
        permissions: output.effectivePermissions,
        expiry: output.expiry,
      });
      outputWarnings(warnings);
      return;
    }
    case "authority_required":
      throw new CLIError(
        "AUTHORITY_REQUIRED",
        "The active session requires additional authority before importing this delegation.",
        ExitCode.PERMISSION_DENIED,
        metadata,
      );
    case "setup_required":
      throw new CLIError(
        "SETUP_REQUIRED",
        "The active profile requires setup before importing this delegation.",
        ExitCode.ERROR,
        metadata,
      );
    case "error":
      throw withSignInHint(cliErrorFromService({ ...result.error, meta: metadata }), ctx.profile, result.context.posture);
  }
}

function isStoredDelegationLike(value: unknown): value is {
  delegation: PortableDelegation;
  permissions?: PermissionEntry[];
} {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { delegation?: unknown };
  return isPortableDelegationLike(candidate.delegation);
}

function isPortableDelegationLike(value: unknown): value is PortableDelegation {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<PortableDelegation>;
  return (
    typeof candidate.cid === "string" &&
    typeof candidate.spaceId === "string" &&
    typeof candidate.path === "string" &&
    Array.isArray(candidate.actions) &&
    candidate.delegationHeader !== undefined &&
    typeof candidate.delegationHeader === "object"
  );
}

function normalizePortableDelegation(delegation: PortableDelegation): PortableDelegation {
  const rawExpiry = (delegation as PortableDelegation & { expiry: unknown }).expiry;
  const expiry = rawExpiry instanceof Date ? rawExpiry : new Date(String(rawExpiry));
  if (Number.isNaN(expiry.getTime())) {
    throw new CLIError(
      "INVALID_AUTH_IMPORT",
      "Imported delegation must include a valid expiry.",
      ExitCode.USAGE_ERROR,
    );
  }
  return { ...delegation, expiry };
}

interface StagedOpenKeyGrant {
  delegation: PortableDelegation;
  effective: PermissionEntry[];
}

/** Validate and activate the complete batch before committing any stored authority. */
async function activateAndStoreOpenKeyGrants(
  profileName: string,
  host: string,
  node: TinyCloudNode,
  grants: StagedOpenKeyGrant[],
  source: "cli" | "manifest",
): Promise<void> {
  if (grants.length === 0) return;
  // Bound before anything is activated: a grant whose signed authority the
  // replay rule cannot read fails the batch rather than be stored unusable.
  const records = await Promise.all(grants.map(({ delegation, effective }) =>
    cliGrantRecord(node, delegation, effective, host)));
  for (const { delegation } of grants) await node.useRuntimeDelegation(delegation);
  await ProfileManager.withLock(profileName, async () => {
    for (const { delegation, effective } of grants) {
      await appendGrantHistory(profileName, {
        addedCaps: effective,
        source,
        delegationCid: delegation.cid,
        expiry: delegation.expiry.toISOString(),
      });
    }
    // A stored record for the same CID that carries a request binding is kept.
    await appendAdditionalDelegations(profileName, records);
  });
}

/**
 * One OpenKey approval for an agent request, verified. Nothing is stored here;
 * the caller decides what the approved session authorizes.
 */
export async function acquireOpenKeyApproval(params: {
  ctx: { profile: string; host: string };
  profile: ProfileConfig;
  requested: PermissionEntry[];
  expiryOption: string | number | undefined;
  reason: string;
  anchorSpace?: string;
  /** The approval must cover every requested action, or none is returned. */
  exactApproval?: boolean;
  /** Print the OpenKey approval URL and wait for the callback instead of opening a browser. */
  noPopup?: boolean;
  /** Test seam for the browser acquisition boundary; production uses startAuthFlow. */
  openKeyAcquisition?: OpenKeyAcquisition;
}): Promise<OpenKeyApproval> {
  assertNoCaveatLimits(params.requested);
  if (params.requested.some(isRawCidRevocationPermission)) {
    throw new CLIError(
      "RAW_RECAP_RESOURCE_UNSUPPORTED",
      "OpenKey cannot sign raw urn:cid revocation authority.",
      ExitCode.PERMISSION_DENIED,
    );
  }
  const key = await ProfileManager.getKey(params.ctx.profile);
  if (!key) {
    throw new CLIError(
      "NO_KEY",
      `No key found for profile "${params.ctx.profile}". Run \`${CLI_NAME} --profile ${params.ctx.profile} auth rotate\` to create a new key and sign in.`,
      ExitCode.AUTH_REQUIRED,
    );
  }
  const expiryCap = params.expiryOption === undefined ? undefined : parseRequestedExpiry(params.expiryOption);
  const anchorSpace = params.anchorSpace ?? params.profile.spaceId ?? params.profile.spaceName;
  const request = grantRequestPermissions(params.requested, anchorSpace);
  const acquireOpenKey = params.openKeyAcquisition ?? startAuthFlow;
  const delegationData = await acquireOpenKey(params.profile.did, {
    jwk: key,
    host: params.ctx.host,
    permissions: request,
    reason: permissionGrantReason(params.reason, request),
    openkeyHost: resolveOpenKeyHost(params.profile),
    expiry: expiryCap === undefined ? undefined : openKeyExpiryParam(expiryCap),
    noPopup: params.noPopup,
  });
  return verifyOpenKeyApproval(delegationData, request, params.ctx.host, {
    key,
    sessionDid: params.profile.sessionDid ?? params.profile.did,
    expectedOwner: pinnedOwner(params.profile),
    expiry: expiryCap,
    exactApproval: params.exactApproval === true,
  });
}

/**
 * A node restored from one verified OpenKey approval. It holds that approval's
 * authority and expiry, not the owner's stored session.
 */
async function nodeFromOpenKeyApproval(host: string, session: VerifiedScopedSession): Promise<TinyCloudNode> {
  const ownerParts = session.ownerDid.split(":");
  const node = new TinyCloudNode({ host });
  await node.restoreSession({
    delegationHeader: session.delegationHeader as { Authorization: string },
    delegationCid: session.delegationCid as string,
    spaceId: session.spaceId as string,
    jwk: session.jwk as object,
    verificationMethod: session.verificationMethod as string,
    address: ownerParts[4]!,
    chainId: Number(ownerParts[3]),
    siwe: session.siwe as string,
    signature: session.signature as string,
    expiresAt: session.expiresAt,
    tinycloudHosts: [host],
  });
  return node;
}

export async function ensureDelegationAuthority(params: {
  ctx: { profile: string; host: string };
  profile: ProfileConfig;
  node: TinyCloudNode;
  requested: PermissionEntry[];
  expiryOption: string | number | undefined;
  reason: string;
  yes: boolean;
  /** Keep command-scoped authority out of profile grant/history storage. */
  persist?: boolean;
  force?: boolean;
  /** The command already prompted before doing its target lookup. */
  consentAlreadyGiven?: boolean;
  /**
   * Space a decrypt-only grant is requested in. OpenKey signs only a request
   * with one space; defaults to the profile's primary space.
   */
  anchorSpace?: string;
  /** Test seam for the browser acquisition boundary; production uses startAuthFlow. */
  openKeyAcquisition?: OpenKeyAcquisition;
  /** Print the OpenKey approval URL and wait for the callback instead of opening a browser. */
  noPopup?: boolean;
  /** Agent request: the approval must cover every requested action, or no grant is stored. */
  exactApproval?: boolean;
}): Promise<PortableDelegation | undefined> {
  if (!params.force && params.node.hasRuntimePermissions(params.requested)) return undefined;
  if (params.profile.authMethod === "openkey") assertNoCaveatLimits(params.requested);

  if (
    !params.consentAlreadyGiven &&
    (params.persist === false || params.profile.authMethod !== "openkey")
  ) {
    await requirePermissionConsent(params.requested, params.yes);
  }

  if (params.profile.authMethod === "openkey") {
    if (params.persist === false) {
      if (params.expiryOption === undefined) {
        throw new CLIError(
          "AUTHORITY_EXPIRY_REQUIRED",
          "One-use command authority needs an explicit lifetime; none was given, so no approval was requested.",
          ExitCode.ERROR,
        );
      }
      const { delegation } = await acquireOpenKeyApproval(params);
      await params.node.useRuntimeDelegation(delegation);
      return delegation;
    }
    if (params.requested.some(isRawCidRevocationPermission)) {
      throw new CLIError(
        "RAW_RECAP_RESOURCE_UNSUPPORTED",
        "OpenKey cannot sign raw urn:cid revocation authority.",
        ExitCode.PERMISSION_DENIED,
      );
    }
    const key = await ProfileManager.getKey(params.ctx.profile);
    if (!key) {
      throw new CLIError(
        "NO_KEY",
        `No key found for profile "${params.ctx.profile}". Run \`${CLI_NAME} --profile ${params.ctx.profile} auth rotate\` to create a new key and sign in.`,
        ExitCode.AUTH_REQUIRED,
      );
    }
    const openkeyHost = resolveOpenKeyHost(params.profile);
    const acquireOpenKey = params.openKeyAcquisition ?? startAuthFlow;
    const expiryCap = params.expiryOption === undefined ? undefined : parseRequestedExpiry(params.expiryOption);
    const proof: PortableGrantProof = {
      key,
      sessionDid: params.profile.sessionDid ?? params.profile.did,
      expectedOwner: pinnedOwner(params.profile),
      expiry: expiryCap,
      exactApproval: params.exactApproval === true,
    };
    const anchorSpace = params.anchorSpace ?? params.profile.spaceId ?? params.profile.spaceName;
    const grants: StagedOpenKeyGrant[] = [];
    for (const group of groupPermissionsBySpace(params.requested)) {
      // capabilities/read is part of the request, so the signed proof may
      // carry it without broadening the grant.
      const request = grantRequestPermissions(group, anchorSpace);
      const delegationData = await acquireOpenKey(params.profile.did, {
        jwk: key,
        host: params.ctx.host,
        permissions: request,
        reason: permissionGrantReason(params.reason, group),
        openkeyHost,
        expiry: expiryCap === undefined ? undefined : openKeyExpiryParam(expiryCap),
        noPopup: params.noPopup,
      });
      const delegation = portableFromOpenKeyDelegation(delegationData, request, params.ctx.host, proof);
      grants.push({ delegation, effective: permissionsFromDelegation(delegation) });
    }
    await activateAndStoreOpenKeyGrants(params.ctx.profile, params.ctx.host, params.node, grants, "cli");
    return;
  }

  const delegations = await params.node.grantRuntimePermissions(
    params.requested,
    params.expiryOption !== undefined ? { expiry: params.expiryOption } : undefined,
  );
  if (params.persist === false) return delegations[0];
  for (const delegation of delegations) {
    const covering = permissionsFromDelegation(delegation);
    await appendAdditionalDelegation(
      params.ctx.profile,
      await cliGrantRecord(params.node, delegation, covering, params.ctx.host),
    );
    await appendGrantHistory(params.ctx.profile, {
      addedCaps: covering,
      source: "cli",
      delegationCid: delegation.cid,
      expiry: delegation.expiry.toISOString(),
    });
  }
}

/** OpenKey lifetime cap for an agent grant: the apps-agent default. */
const OPENKEY_AGENT_MAX_LIFETIME_MS = parseRequestedExpiry(APPS_AGENT_EXPIRY).durationMs;

/** An agent request is approved in OpenKey only if it covers one space and no raw authority. */
function assertOpenKeyAgentRequest(requested: PermissionEntry[]): void {
  if (requested.some((permission) => isRawEncryptionPermission(permission) || isRawCidRevocationPermission(permission))) {
    throw new CLIError(
      "RAW_RECAP_RESOURCE_UNSUPPORTED",
      "OpenKey cannot approve raw urn:cid or raw encryption authority for an agent request.",
      ExitCode.PERMISSION_DENIED,
    );
  }
  if (groupPermissionsBySpace(requested).length !== 1) {
    throw new CLIError(
      "AGENT_GRANT_MULTIPLE_SPACES",
      "An agent grant must cover exactly one space. Request one space per auth request.",
      ExitCode.PERMISSION_DENIED,
    );
  }
}

function permissionGrantReason(context: string, permissions: PermissionEntry[]): string {
  const first = permissions[0];
  const summary = first ? compactPermission(first) : "no permissions";
  const more = permissions.length > 1
    ? ` and ${permissions.length - 1} more permission${permissions.length === 2 ? "" : "s"}`
    : "";
  return `${context} Requested: ${summary}${more}.`;
}

function execCapturedCommand(command: { argv: string[]; cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1], ...command.argv], {
      cwd: command.cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new CLIError(
          "COMMAND_SIGNAL",
          `Captured command exited from signal ${signal}.`,
          ExitCode.ERROR,
        ));
        return;
      }
      if (code && code !== 0) {
        process.exitCode = code;
      }
      resolve();
    });
  });
}

async function collectRequestedPermissions(
  options: {
    cap?: string[];
    permission?: string;
    manifest?: string;
    device?: boolean;
  },
  profile: string,
): Promise<PermissionEntry[]> {
  const permissions: PermissionEntry[] = [];
  for (const spec of options.cap ?? []) {
    permissions.push(await parseCapSpec(spec, profile));
  }
  if (options.permission) {
    permissions.push(...await loadPermissionRequest(options.permission, profile));
  }
  if (options.manifest) {
    permissions.push(...await loadManifestPermissions(options.manifest, profile, { device: options.device === true }));
  }
  return permissions;
}

async function askYesNo(question: string, cancelMessage: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
  rl.close();

  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CLIError("REQUEST_CANCELLED", cancelMessage, ExitCode.ERROR);
  }
}

async function confirmPermissionRequest(permissions: PermissionEntry[]): Promise<void> {
  process.stderr.write("\n" + theme.heading("Additional Permissions") + "\n");
  for (const permission of permissions) {
    const dangerous = isDangerousPermission(permission);
    const line = `  ${permissionConsentLine(permission)}`;
    process.stderr.write((dangerous ? theme.warn(line) : theme.value(line)) + "\n");
  }
  process.stderr.write("\n");
  await askYesNo("Approve local-key delegation? [y/N] ", "Permission request cancelled.");
}

export async function requirePermissionConsent(
  permissions: PermissionEntry[],
  yes: boolean,
): Promise<void> {
  if (isInteractive()) {
    if (!yes) await confirmPermissionRequest(permissions);
  } else if (!yes) {
    throw new CLIError(
      "CONFIRMATION_REQUIRED",
      "Permission grants in non-interactive mode require --yes.",
      ExitCode.USAGE_ERROR,
    );
  }
}

function isDangerousPermission(permission: PermissionEntry): boolean {
  if (permission.path === "" || permission.path === "/") return true;
  return permission.actions.some((action) =>
    action.includes("*") ||
    action.endsWith("/write") ||
    action.endsWith("/admin") ||
    action.endsWith("/schema") ||
    action.endsWith("/del"),
  );
}

/**
 * Parse the `--expiry` flag into either a ms-format string ("7d", "30m") or
 * raw milliseconds. Returns undefined for missing input so the caller falls
 * back to the SDK's DEFAULT_DELEGATION_EXPIRY_MS.
 *
 * Pure-numeric strings are coerced to numbers so a shell-quoted ms count
 * (`--expiry 86400000`) works, but anything that contains a unit suffix
 * (`"7d"`, `"30m"`) is forwarded as-is to parseExpiry which understands
 * the ms-format vocabulary.
 */
function parseExpiryOption(raw: unknown): string | number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new CLIError(
      "INVALID_EXPIRY",
      `--expiry must be a string (e.g. "7d", "30m") or a millisecond integer.`,
      ExitCode.USAGE_ERROR,
    );
  }
  if (/^\d+$/.test(raw.trim())) {
    const ms = Number(raw.trim());
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new CLIError("INVALID_EXPIRY", `--expiry must be a positive integer when numeric.`, ExitCode.USAGE_ERROR);
    }
    return ms;
  }
  return raw;
}

export function groupPermissionsBySpace(permissions: PermissionEntry[]): PermissionEntry[][] {
  const groups = new Map<string, PermissionEntry[]>();
  const rawEntries: PermissionEntry[] = [];
  for (const permission of permissions) {
    if (isRawEncryptionPermission(permission) || isRawCidRevocationPermission(permission)) {
      rawEntries.push(permission);
      continue;
    }
    // Key by address-normalized space so multiple caps on the same space batch
    // into one OpenKey round-trip even when one cap's address is checksummed and
    // another is lowercase. The space NAME stays case-sensitive, so genuinely
    // different names are NOT merged. Entries keep their original space string.
    const key = normalizePkhIdentifier(permission.space ?? "");
    const group = groups.get(key) ?? [];
    group.push(permission);
    groups.set(key, group);
  }
  const grouped = Array.from(groups.values());
  if (grouped.length === 0) {
    return rawEntries.length > 0 ? [rawEntries] : [];
  }
  grouped[0].push(...rawEntries);
  return grouped;
}

export interface PortableGrantProof {
  key: object;
  sessionDid: string;
  expectedOwner?: string;
  expiry?: RequestedExpiry;
  /** Agent request: the approval must cover every requested action, or no grant is stored. */
  exactApproval?: boolean;
}

/** A verified OpenKey approval: the portable grant, and the signed session it was verified from. */
export interface OpenKeyApproval {
  delegation: PortableDelegation;
  session: VerifiedScopedSession;
}

/** A portable grant contains only authority from the owner-signed ReCap. */
export function portableFromOpenKeyDelegation(
  data: Record<string, unknown>,
  requested: PermissionEntry[],
  host: string,
  proof: PortableGrantProof,
): PortableDelegation {
  return verifyOpenKeyApproval(data, requested, host, proof).delegation;
}

/** Verify an OpenKey approval against the request; returns the grant and the session that restores it. */
export function verifyOpenKeyApproval(
  data: Record<string, unknown>,
  requested: PermissionEntry[],
  host: string,
  proof: PortableGrantProof,
): OpenKeyApproval {
  const { session, legacyNested } = verifyScopedLogin(data, proof.key, proof.sessionDid, requested, {
    expectedOwner: proof.expectedOwner,
    expiry: proof.expiry,
    purpose: "grant",
    exactApproval: proof.exactApproval,
  });
  if (legacyNested.length > 0) {
    throw new CLIError(
      "OPENKEY_GRANT_BROADENED",
      "OpenKey signed decrypt inside the space instead of on the raw network. The OpenKey deployment is too old for agent secret reads.",
      ExitCode.PERMISSION_DENIED,
    );
  }
  const returnedSpace = data.spaceId as string; // Bound to the signed proof by verifyScopedLogin.
  const effective = session.permissions;
  // The headline resource is a requested data entry, not the
  // capabilities/read every OpenKey grant carries or a raw network.
  const spaced = effective.filter((permission) =>
    !isRawEncryptionPermission(permission) && !isRawCidRevocationPermission(permission)
  );
  const primary = spaced.find((permission) => permission.service !== "tinycloud.capabilities") ?? spaced[0] ?? effective[0]!;
  const resources = effective.map((permission) => ({
    service: permission.service.slice("tinycloud.".length),
    space: isRawCidRevocationPermission(permission)
      ? permission.space!
      : isVerifiedRawEncryptionPermission(permission) ? "encryption" : returnedSpace,
    path: permission.path,
    actions: [...permission.actions],
    ...(permission.caveats === undefined ? {} : { caveats: structuredClone(permission.caveats) }),
  }));
  const ownerParts = session.ownerDid.split(":");
  const delegation: PortableDelegation = {
    cid: data.delegationCid as string,
    delegationHeader: data.delegationHeader as { Authorization: string },
    spaceId: returnedSpace,
    path: primary.path,
    actions: [...primary.actions],
    resources,
    expiry: new Date(session.expiresAt),
    delegateDID: data.verificationMethod as string,
    ownerAddress: ownerParts[4]!,
    chainId: Number(ownerParts[3]),
    host,
    // Verified above; replay rebuilds the CACAO from it before trusting the grant.
    siweProof: { siwe: data.siwe as string, signature: data.signature as string },
  };
  return { delegation, session };
}

async function rotateAuthKey(
  profileName: string,
  host: string,
  options: { paste?: boolean; noPopup?: boolean; force?: boolean } = {},
): Promise<void> {
  await recoverPendingLogout(profileName);
  const profile = await ProfileManager.getProfile(profileName);
  const posture = resolveProfilePosture(profile);
  const oldDid = profile.sessionDid ?? profile.did;

  if (posture === "delegate-session") {
    throw new CLIError(
      "ROTATE_DELEGATE_SESSION_UNSUPPORTED",
      `Profile "${profileName}" is a delegated session. Request or import a new owner delegation instead of rotating it locally.`,
      ExitCode.PERMISSION_DENIED,
    );
  }

  if (profile.authMethod === "local" || posture === "local-owner-key") {
    if (!profile.privateKey) {
      throw new CLIError(
        "LOCAL_OWNER_KEY_REQUIRED",
        `Profile "${profileName}" does not have a local owner private key. Run \`${CLI_NAME} auth login --method local\` first.`,
        ExitCode.AUTH_REQUIRED,
      );
    }

    // The new session replaces the old one in local login's compare-and-commit;
    // if the profile changed meanwhile, the commit refuses and keeps it.
    const result = await handleLocalAuth(profileName, host, {
      emitOutput: false,
      keys: profile.namedKeys?.prefix,
    });
    outputRotationResult(result.profile, profileName, oldDid, "local");
    return;
  }

  if (profile.replication?.prefixes.length) {
    throw new CLIError("V2_REQUIRED",
      "Replica-enabled OpenKey rotation requires an SDK-prepared SIWE v2 handoff; the existing key and session were not changed.",
      ExitCode.AUTH_REQUIRED);
  }

  if (!options.force) await assertShareHistoryAllowsKeyDrop(profileName, "rotate");
  const { jwk, did } = await withSpinner("Generating session key...", async () => {
    return generateKey();
  });

  // One transaction: a concurrent login commit either lands before (and this
  // rotation then discards its session) or sees the new key and refuses.
  let permissions: PermissionEntry[] | undefined;
  await ProfileManager.withLock(profileName, async () => {
    const current = await ProfileManager.getProfile(profileName);
    if (current.replication?.prefixes.length) {
      const previousSession = await ProfileManager.getSession(profileName) as Record<string, unknown> | null;
      if (Array.isArray(previousSession?.permissions)) permissions = previousSession.permissions as PermissionEntry[];
    }
    await ProfileManager.setKey(profileName, jwk);
    await ProfileManager.clearSession(profileName);
    await ProfileManager.setProfile(profileName, {
      ...current,
      host,
      did,
      sessionDid: did,
      posture: current.posture ?? "owner-openkey",
      operatorType: current.operatorType ?? "human",
      authMethod: "openkey",
    });
  });

  const result = await refreshOpenKeySession(profileName, host, {
    paste: options.paste,
    noPopup: options.noPopup,
    permissions,
    ...(profile.namedKeys === undefined ? {} : { keys: profile.namedKeys.prefix, expectedOwner: profile.ownerDid }),
  });
  outputRotationResult(result.profile, profileName, oldDid, "openkey");
}

function outputRotationResult(
  profile: ProfileConfig,
  profileName: string,
  oldDid: string,
  authMethod: AuthMethod,
): void {
  outputJson({
    rotated: true,
    profile: profileName,
    oldDid,
    did: profile.did,
    sessionDid: profile.sessionDid ?? null,
    authMethod,
    spaceId: profile.spaceId ?? null,
  });
}

async function persistCurrentLocalSession(
  profileName: string,
  profile: ProfileConfig,
  session: TinyCloudSession | undefined,
  replicaStamp: TinyCloudNode["replicaStamp"],
): Promise<void> {
  if (!session) return;

  await ProfileManager.withLock(profileName, async () => {
    if ((await ProfileManager.getProfile(profileName)).authSignedOut === true) {
      throw new CLIError("PROFILE_CHANGED_DURING_LOGIN",
        "The profile was signed out while the local grant was in flight; its session and key were not restored.",
        ExitCode.ERROR);
    }
    try {
      await lstat(join(profilePath(profileName), REPLICA_LOGOUT_PENDING_FILE));
      throw new CLIError("PROFILE_CHANGED_DURING_LOGIN",
        "A durable logout started while the local grant was in flight; its session and key were not restored.",
        ExitCode.ERROR);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    }
    await ProfileManager.setSession(profileName, {
      authMethod: "local",
      address: session.address,
      chainId: session.chainId,
      ownerDid: profile.ownerDid ?? profile.did,
      spaceId: session.spaceId,
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      jwk: session.jwk,
      verificationMethod: session.verificationMethod,
      siwe: session.siwe,
      signature: session.signature,
      ...(replicaStamp === undefined ? {} : { replicaStamp }),
    });
    if (profile.sessionDid !== session.verificationMethod || profile.spaceId !== session.spaceId) {
      await ProfileManager.updateProfile(profileName, (current) => ({
        ...current,
        sessionDid: session.verificationMethod,
        spaceId: session.spaceId,
      }));
    }
  });
}

type LocalAuthResult = {
  profile: ProfileConfig;
  sessionResult: Awaited<ReturnType<typeof localKeySignIn>>;
};

/**
 * Handle local Ethereum key authentication.
 * Generates or reuses a local private key, creates a did:pkh identity,
 * and signs in to TinyCloud directly (no browser needed).
 */
async function handleLocalAuth(
  profileName: string,
  host: string,
  options: { emitOutput?: boolean; replication?: ReplicationLoginOptions; keys?: string } = {},
): Promise<LocalAuthResult> {
  const snapshot = await readProfileSnapshot(profileName);
  const profile = snapshot.profile;
  const posture = profile ? resolveProfilePosture(profile) : null;

  let privateKey: string;
  let address: string;
  let did: string;

  if (profile && (profile.authMethod === "local" || posture === "local-owner-key") && profile.privateKey) {
    // Reuse existing local key
    privateKey = profile.privateKey;
    address = profile.address ?? await deriveAddress(privateKey);
    did = profile.did.startsWith("did:pkh:")
      ? profile.did
      : addressToDID(address, profile.chainId ?? DEFAULT_CHAIN_ID);

    if (isInteractive()) {
      process.stderr.write(theme.muted("Using existing local key") + "\n");
      process.stderr.write(formatField("Address", address) + "\n");
    }
  } else {
    // Generate new local identity
    const identity = await withSpinner("Generating Ethereum key...", async () => {
      return generateLocalIdentity(DEFAULT_CHAIN_ID);
    });

    privateKey = identity.privateKey;
    address = identity.address;
    did = identity.did;

    if (isInteractive()) {
      process.stderr.write("\n" + theme.heading("Local Key Generated") + "\n");
      process.stderr.write(formatField("Address", address) + "\n");
      process.stderr.write(formatField("DID", did) + "\n\n");
    }
  }

  // Named keys: validate the prefix and the node's support before any signature.
  const namedKeys = options.keys === undefined ? undefined : parseKeysPrefix(options.keys, did);
  if (namedKeys !== undefined) await assertNodeSupportsNamedKeys(host);

  // Sign in using the private key
  const sessionResult = await withSpinner("Signing in...", async () => {
    const replication = options.replication ?? profile?.replication;
    return localKeySignIn({
      privateKey,
      host,
      ...(namedKeys === undefined ? {} : { keyAbilities: keyAbilitiesFor(namedKeys) }),
      ...(replication?.prefixes.length ? { profile: profileName, replication } : {}),
    });
  });
  // TinyCloudNode signs with its own fresh session JWK. Persist that exact
  // key, never an independently generated key that cannot restore the proof.
  const key = sessionResult.jwk;

  const session = {
    authMethod: "local",
    address,
    chainId: DEFAULT_CHAIN_ID,
    ownerDid: did,
    spaceId: sessionResult.spaceId,
    delegationHeader: sessionResult.delegationHeader,
    delegationCid: sessionResult.delegationCid,
    jwk: sessionResult.jwk,
    verificationMethod: sessionResult.verificationMethod,
    siwe: sessionResult.siwe,
    signature: sessionResult.signature,
    ...(sessionResult.replicaStamp === undefined ? {} : { replicaStamp: sessionResult.replicaStamp }),
  };
  const sessionDid = sessionResult.verificationMethod;

  // Update profile
  const updatedProfile = {
    ...profile,
    name: profileName,
    host,
    chainId: DEFAULT_CHAIN_ID,
    spaceName: "default",
    did,
    sessionDid,
    ownerDid: did,
    spaceId: sessionResult.spaceId,
    createdAt: profile?.createdAt ?? new Date().toISOString(),
    posture: profile?.posture ?? "local-owner-key",
    operatorType: profile?.operatorType ?? "human",
    authMethod: "local",
    privateKey,
    address,
    ...(namedKeys === undefined ? {} : { namedKeys }),
  } satisfies ProfileConfig;
  if (namedKeys === undefined) delete (updatedProfile as ProfileConfig).namedKeys;

  await commitLogin(profileName, snapshot, { key, session, profile: updatedProfile });

  if (options.emitOutput ?? true) {
    outputJson({
      authenticated: true,
      profile: profileName,
      did,
      sessionDid,
      address,
      spaceId: sessionResult.spaceId,
      authMethod: "local",
    });
  }

  return { profile: updatedProfile, sessionResult };
}

/**
 * Handle OpenKey (browser-based) authentication. With `permissions`, only the
 * manifest's scope is requested and the signed proof is verified first.
 */
async function handleOpenKeyAuth(
  profileName: string,
  host: string,
  options: OpenKeyLoginOptions = {},
): Promise<boolean> {
  const { profile, delegationData, declined, legacyNested } = await refreshOpenKeySession(profileName, host, options);

  reportDeclined(declined, legacyNested);
  await ensureSpaceSetup({ profile: profileName, host }, delegationData, delegationData.permissions as PermissionEntry[] | undefined);
  outputJson({
    authenticated: true,
    profile: profileName,
    did: profile.did,
    spaceId: delegationData.spaceId,
    ownerDid: profile.ownerDid ?? null,
    authMethod: "openkey",
    ...(options.permissions
      ? {
          scoped: true,
          host,
          permissions: delegationData.permissions,
          declined,
          expiresAt: delegationData.expiresAt,
          activation: delegationData.hostActivated === true ? "confirmed-by-openkey" : "unverified",
        }
      : {}),
  });
  return (options.replication?.prefixes.length ?? 0) > 0;
}

/** Tell the operator which requested capabilities the owner unchecked or OpenKey signed incorrectly. */
function reportDeclined(declined: PermissionEntry[], signed?: PermissionEntry[]): void {
  if (declined.length === 0) return;
  process.stderr.write(
    `${theme.warn("Not granted in this session:")}\n${declined.map((permission) => `  ${compactPermission(permission)}`).join("\n")}\n`,
  );
  if (declined.some((permission) => isRawEncryptionPermission(permission) &&
    signed?.some((entry) => isRawEncryptionPermission(entry) &&
      !isVerifiedRawEncryptionPermission(entry) &&
      normalizePkhIdentifier(entry.path) === normalizePkhIdentifier(permission.path)))) {
    process.stderr.write(`${theme.warn("OpenKey signed decrypt inside the space; the TinyCloud node refuses that. The OpenKey deployment is too old for agent secret reads.")}\n`);
  }
}
async function persistReplicationLogin(profileName: string, settings: ReplicationLoginOptions): Promise<void> {
  await ProfileManager.updateProfile(profileName, (profile) => {
    const { replication: _previous, ...rest } = profile;
    return settings.prefixes.length === 0
      ? rest
      : {
          ...rest,
          replication: {
            prefixes: [...settings.prefixes],
            ...(settings.allowSecrets === true ? { allowSecrets: true } : {}),
          },
        };
  });
}

function writeReplicationSecretsWarning(): void {
  process.stderr.write(`${theme.warn("Warning:")} replication copies encrypted secret material to this device. The allow-secrets option does not grant decrypt.\n`);
}

interface OpenKeyLoginOptions {
  paste?: boolean;
  noPopup?: boolean;
  /** Manifest scope for first login: one space, verified before persistence. */
  permissions?: PermissionEntry[];
  replication?: ReplicationLoginOptions;
  expiry?: string | number;
  expectedOwner?: string;
  /** Scoped login: replace a live session the approved scope would narrow. */
  replaceSession?: boolean;
  /** Record `host` as the profile host (an explicit `--host`). */
  persistHost?: boolean;
  openKeyAcquisition?: OpenKeyAcquisition;
  /** Bypass the share-history check that guards replacing the stored session key. */
  force?: boolean;
  /** `--keys` folder: also ask OpenKey to approve named-key create and decrypt there. */
  keys?: string;
}

/** Only a fresh SDK-prepared, OpenKey-signed owner session may establish replica consent. */
async function refreshPreparedOpenKeySession(params: {
  profileName: string;
  host: string;
  profile: ProfileConfig;
  snapshot: Awaited<ReturnType<typeof readProfileSnapshot>>;
  options: OpenKeyLoginOptions;
  replication: ReplicationLoginOptions;
  permissions: PermissionEntry[] | undefined;
  expectedOwner: string | undefined;
  expiry: RequestedExpiry | undefined;
}): Promise<{ profile: ProfileConfig; delegationData: Record<string, unknown>; declined: PermissionEntry[]; legacyNested: PermissionEntry[] }> {
  const { profileName, host, profile, snapshot, options, replication, permissions, expectedOwner, expiry } = params;
  assertNoCaveatLimits(permissions);
  const storedOwner = snapshot.session && snapshot.key && profile.sessionDid
    ? verifySignedSession(snapshot.session, snapshot.key, profile.sessionDid).ownerDid
    : undefined;
  const owner = options.expectedOwner ? canonicalOwnerDid(options.expectedOwner) : storedOwner;
  if (!owner || !permissions) {
    throw new CLIError("V2_REQUIRED",
      "Replica-enabled OpenKey login needs --owner did:pkh:eip155:CHAIN:ADDRESS or a verified existing owner session; a stored profile owner field alone is not proof. No approval was started.",
      ExitCode.AUTH_REQUIRED);
  }
  if (expectedOwner && normalizePkhIdentifier(owner) !== normalizePkhIdentifier(expectedOwner)) {
    throw new CLIError("OPENKEY_OWNER_MISMATCH", "The verified owner differs from this profile. No approval was started.", ExitCode.PERMISSION_DENIED);
  }
  const namedKeys = options.keys === undefined ? undefined : parseKeysPrefix(options.keys, owner);
  if (namedKeys !== undefined) await assertNodeSupportsNamedKeys(host);
  if (options.force !== true) await assertShareHistoryAllowsKeyDrop(profileName, "login");
  const replicationConfig = createCliReplicationConfig(profileName, replication, { debug: false, quiet: true }, true);
  if (!replicationConfig) throw new CLIError("V2_REQUIRED", "Replica configuration is unavailable; no approval was started.", ExitCode.AUTH_REQUIRED);
  const space = permissions.find((permission) => permission.service === "tinycloud.kv")?.space ?? ownerSpaceId("default", owner);
  const capabilityRequest = composeManifestRequest([{
    app_id: "tc-cli", name: "TinyCloud CLI", space, prefix: "", defaults: false, includePublicSpace: false,
    ...(expiry ? { expiry: `${expiry.durationMs}ms` } : {}),
    permissions,
  }], { includeAccountRegistryPermissions: false });
  const node = new TinyCloudNode({
    host, signer: ownerIdentitySigner(owner), capabilityRequest,
    includeAccountRegistryPermissions: false, autoBootstrapAccount: false,
    replication: replicationConfig,
    ...(namedKeys === undefined ? {} : { additionalRawAbilities: keyAbilitiesFor(namedKeys) }),
  });
  let handoff: PreparedOpenKeyHandoff | undefined;
  let preparedDid: string | undefined;
  // An unreadable gate counts as active: a failed attempt then never denies it.
  const gateWasActive = await readGateSnapshot(profilePath(profileName))
    .then((gate) => gate !== undefined && gate.principalHash !== null, () => true);
  try {
    if (namedKeys !== undefined) process.stderr.write(KEYS_APPROVAL_NOTE(namedKeys.prefix));
    await node.signInWithOpenKey(async (prepared) => {
      preparedDid = prepared.verificationMethod;
      handoff = await startPreparedOpenKeyHandoff({
        prepared, openKeyHost: resolveOpenKeyHost(profile),
        noPopup: options.noPopup, paste: options.paste,
      });
      return handoff.result;
    });
    const active = node.restorableSession;
    if (!active || !preparedDid || node.sessionDid !== preparedDid || active.verificationMethod !== preparedDid) {
      throw new CLIError("OPENKEY_SESSION_MISMATCH", "OpenKey signed a different SDK session key; no profile or session was saved.", ExitCode.PERMISSION_DENIED);
    }
    const key = active.jwk;
    const verified = verifyScopedLogin({ ...active }, key, preparedDid, permissions, {
      expectedOwner: owner, expiry, ...(namedKeys === undefined ? {} : { namedKeyRow: namedKeys }),
    });
    const grant = namedKeys === undefined ? "none" : namedKeysGrantOf(active.siwe, namedKeys);
    if (grant === "partial") throw partialKeysGrantError();
    const session = {
      ...verified.session,
      ...(node.replicaStamp ? { replicaStamp: node.replicaStamp } : {}),
      authMethod: "openkey",
    };
    const updatedProfile: ProfileConfig = {
      ...profile,
      host: options.persistHost === true || !profile.host ? host : profile.host,
      did: preparedDid, sessionDid: preparedDid,
      posture: profile.posture ?? "owner-openkey",
      operatorType: profile.operatorType ?? "human",
      authMethod: "openkey",
      ownerDid: owner,
      spaceId: active.spaceId,
      replication: {
        prefixes: [...replication.prefixes],
        ...(replication.allowSecrets === true ? { allowSecrets: true } : {}),
      },
    };
    if (namedKeys !== undefined) {
      delete updatedProfile.namedKeys;
      if (grant === "both") updatedProfile.namedKeys = namedKeys;
    }
    await commitLogin(profileName, snapshot, {
      key, session, profile: updatedProfile, durable: true,
      approved: { scope: session.permissions as PermissionEntry[], ownerDid: owner, replaceSession: options.replaceSession === true },
    });
    await handoff?.complete(true);
    announceFirstOwner(profileName, expectedOwner, owner);
    if (namedKeys !== undefined) {
      if (grant === "both") await readyNamedKeysNetwork(node);
      else process.stderr.write(keysNotGrantedAfterLogin(profileName));
    }
    return {
      profile: updatedProfile, delegationData: session,
      declined: declinedPermissions(permissions, session.permissions as PermissionEntry[], owner),
      legacyNested: verified.legacyNested,
    };
  } catch (error) {
    await handoff?.complete(false);
    await undoPreparedAttempt(profileName, node, owner, gateWasActive).catch(() => undefined);
    throw namedKeys !== undefined && isNarrowedRecapMismatch(error) ? partialKeysGrantError() : error;
  }
}

/** What the signed ReCap says about the named-key folder that was requested. */
function namedKeysGrantOf(siwe: string | undefined, keys: ProfileNamedKeys): "both" | "none" | "partial" {
  const recap = siwe === undefined ? {} : extractRecapAttenuations(siwe) as Record<string, Record<string, unknown>>;
  const row = recap[keys.resource] ?? {};
  const wanted = keyAbilitiesFor(keys)[keys.resource]!;
  const granted = wanted.filter((ability) => ability in row);
  if (granted.length === 0) return "none";
  return granted.length === wanted.length && Object.keys(row).length === wanted.length ? "both" : "partial";
}

const KEYS_APPROVAL_NOTE = (folder: string): string =>
  `On the OpenKey page, the row that mentions tinycloud.encryption lets this profile create and use keys in the folder "${folder}/". Keep every row ticked. To sign in without keys, untick that whole row and nothing else; any other change makes OpenKey refuse the sign-in.\n`;

const keysNotGrantedAfterLogin = (profileName: string): string =>
  `You're signed in, but without named keys: the tinycloud.encryption permission wasn't approved. To add them, sign in again with \`${CLI_NAME} --profile ${profileName} auth login --keys <folder>\` and leave the row that mentions tinycloud.encryption ticked.\n`;

/** Create the default encryption network when the account has none yet; a failure only means the folder isn't ready. */
async function readyNamedKeysNetwork(node: TinyCloudNode): Promise<void> {
  try {
    await node.ensureEncryptionNetwork();
  } catch {
    process.stderr.write(`You're signed in, but your encryption keys aren't set up yet. Try \`${CLI_NAME} keys ensure <folder>/<name>\` again in a minute.\n`);
  }
}

function isNarrowedRecapMismatch(error: unknown): boolean {
  const text = error instanceof Error ? `${(error as { code?: unknown }).code ?? ""} ${error.message}` : String(error);
  return text.includes("narrowed_recap_mismatch");
}

/**
 * OpenKey sign-in with `--keys <folder>`: the SDK-prepared hand-off carries the folder's key
 * row beside the default session abilities, and the signed ReCap decides what the profile records.
 */
async function refreshPreparedKeysSession(params: {
  profileName: string;
  host: string;
  profile: ProfileConfig;
  snapshot: Awaited<ReturnType<typeof readProfileSnapshot>>;
  options: OpenKeyLoginOptions;
  expectedOwner: string | undefined;
  expiry: RequestedExpiry | undefined;
}): Promise<{ profile: ProfileConfig; delegationData: Record<string, unknown>; declined: PermissionEntry[]; legacyNested: PermissionEntry[] }> {
  const { profileName, host, profile, snapshot, options, expectedOwner, expiry } = params;
  const storedOwner = snapshot.session && snapshot.key && profile.sessionDid
    ? verifySignedSession(snapshot.session, snapshot.key, profile.sessionDid).ownerDid
    : undefined;
  const owner = options.expectedOwner
    ? canonicalOwnerDid(options.expectedOwner)
    : storedOwner ?? (profile.ownerDid ? canonicalOwnerDid(profile.ownerDid) : undefined);
  if (!owner) {
    throw new CLIError("OWNER_REQUIRED",
      "The first OpenKey sign-in with `--keys` needs your account: add `--owner did:pkh:eip155:<chain>:<address>`. Nothing was started.",
      ExitCode.AUTH_REQUIRED);
  }
  if (expectedOwner && normalizePkhIdentifier(owner) !== normalizePkhIdentifier(expectedOwner)) {
    throw new CLIError("OPENKEY_OWNER_MISMATCH", "The verified owner differs from this profile. No approval was started.", ExitCode.PERMISSION_DENIED);
  }
  // Validate the folder and the node before the hand-off opens.
  const namedKeys = parseKeysPrefix(options.keys!, owner);
  await assertNodeSupportsNamedKeys(host);
  if (options.force !== true) await assertShareHistoryAllowsKeyDrop(profileName, "login");
  const node = new TinyCloudNode({
    host, signer: ownerIdentitySigner(owner),
    additionalRawAbilities: keyAbilitiesFor(namedKeys),
    includeAccountRegistryPermissions: false, autoBootstrapAccount: false,
    ...(expiry ? { sessionExpirationMs: expiry.durationMs } : {}),
  });
  let handoff: PreparedOpenKeyHandoff | undefined;
  let preparedDid: string | undefined;
  try {
    process.stderr.write(KEYS_APPROVAL_NOTE(namedKeys.prefix));
    await node.signInWithOpenKey(async (prepared) => {
      preparedDid = prepared.verificationMethod;
      handoff = await startPreparedOpenKeyHandoff({
        prepared, openKeyHost: resolveOpenKeyHost(profile),
        noPopup: options.noPopup, paste: options.paste,
      });
      return handoff.result;
    });
    const active = node.restorableSession;
    if (!active || !preparedDid || node.sessionDid !== preparedDid || active.verificationMethod !== preparedDid) {
      throw new CLIError("OPENKEY_SESSION_MISMATCH", "OpenKey signed a different SDK session key; no profile or session was saved.", ExitCode.PERMISSION_DENIED);
    }
    const key = active.jwk;
    const signed = verifySignedSession({ ...active }, key, preparedDid, { expectedOwner: owner, expiry });
    const grant = namedKeysGrantOf(active.siwe, namedKeys);
    if (grant === "partial") throw partialKeysGrantError();
    const session = { ...withVerifiedAuthority({ ...active, jwk: key }, signed), authMethod: "openkey" };
    const updatedProfile: ProfileConfig = {
      ...profile,
      host: options.persistHost === true || !profile.host ? host : profile.host,
      did: preparedDid, sessionDid: preparedDid,
      posture: profile.posture ?? "owner-openkey",
      operatorType: profile.operatorType ?? "human",
      authMethod: "openkey",
      ownerDid: signed.ownerDid,
      spaceId: active.spaceId,
    };
    delete updatedProfile.namedKeys;
    if (grant === "both") updatedProfile.namedKeys = namedKeys;
    await commitLogin(profileName, snapshot, { key, session, profile: updatedProfile });
    await handoff?.complete(true);
    if (grant === "both") await readyNamedKeysNetwork(node);
    if (grant === "none") {
      process.stderr.write(keysNotGrantedAfterLogin(profileName));
    }
    return { profile: updatedProfile, delegationData: session, declined: [], legacyNested: [] };
  } catch (error) {
    await handoff?.complete(false);
    await node.replication?.close();
    throw isNarrowedRecapMismatch(error) ? partialKeysGrantError() : error;
  }
}

/**
 * A failed prepared login undoes only what that attempt established. It never denies a gate that
 * was already active: that is the session it meant to replace, and a deny there would let the next
 * start erase its unsynced writes. Only when this attempt itself bound an inactive gate to the owner,
 * and no committed session holds it, is that binding denied again. Otherwise it only stops its
 * replica runtime; it saved no key or session.
 */
async function undoPreparedAttempt(
  profileName: string, node: TinyCloudNode, owner: string, gateWasActive: boolean,
): Promise<void> {
  if (!gateWasActive) {
    const undone = await ProfileManager.withLock(profileName, async () => {
      const gate = await readGateSnapshot(profilePath(profileName));
      if (gate === undefined || gate.principalHash !== await principalHashOf(gate.salt, owner)) return false;
      if (await ProfileManager.getSession(profileName) !== null) return false;
      await node.signOut();
      return true;
    }, { requireProfile: true });
    if (undone) return;
  }
  await node.replication?.close();
}

export async function refreshOpenKeySession(
  profileName: string,
  host: string,
  options: OpenKeyLoginOptions = {},
): Promise<{ profile: ProfileConfig; delegationData: Record<string, unknown>; declined: PermissionEntry[]; legacyNested: PermissionEntry[] }> {
  await recoverPendingLogout(profileName);
  const snapshot = await readProfileSnapshot(profileName);
  // A missing profile is PROFILE_NOT_FOUND, not a missing key: `tc init` alone
  // would create the default profile instead of this one.
  const profile = snapshot.profile ?? await ProfileManager.getProfile(profileName);
  // Resolve before consent so an invalid scope, --expiry, owner conflict or
  // live session in use never opens OpenKey.
  const expiry = options.expiry === undefined ? undefined : parseRequestedExpiry(options.expiry);
  const openKeyExpiry = expiry === undefined ? undefined : openKeyExpiryParam(expiry);
  const expectedOwner = expectedOwnerFor(profileName, profile, options.expectedOwner);
  const replication = options.replication ?? profile.replication ?? { prefixes: [] };
  const previousSession = options.replication === undefined && profile.replication?.prefixes.length
    ? await ProfileManager.getSession(profileName) as Record<string, unknown> | null
    : null;
  const rememberedPermissions = Array.isArray(previousSession?.permissions)
    ? previousSession.permissions as PermissionEntry[]
    : undefined;
  const baseRequest = options.permissions ?? rememberedPermissions;
  const requested = buildReplicationLoginRequest(baseRequest, {
    ...replication,
    ownerOpenKey: resolveProfilePosture(profile) === "owner-openkey",
    ...(expectedOwner === undefined ? {} : { ownerDid: expectedOwner }),
  });
  if (requested !== undefined) validateLoginPermissions(requested);
  const permissions = requested === undefined ? undefined : scopedLoginPermissions(requested);
  if (permissions !== undefined) {
    assertNotLocalOwner(profileName, profile, "Scoped browser login");
  }
  if (permissions !== undefined && options.replaceSession !== true) {
    const estimatedExpiry = expiry === undefined ? undefined : new Date(Date.now() + expiry.durationMs).toISOString();
    assertSessionReplaceable(profileName, snapshot, expectedOwner, permissions, estimatedExpiry);
  }
  if (options.keys !== undefined && replication.prefixes.length === 0) {
    return refreshPreparedKeysSession({ profileName, host, profile, snapshot, options, expectedOwner, expiry });
  }
  if (replication.prefixes.length > 0) {
    return refreshPreparedOpenKeySession({
      profileName, host, profile, snapshot, options, replication, permissions, expectedOwner, expiry,
    });
  }

  // A logged-out nonreplica profile has no restorable signer. Keep the
  // candidate private key in memory until the signed OpenKey result verifies
  // and commitLogin atomically writes the key, session and matching DID.
  const fresh = snapshot.key === null ? generateKey() : null;
  const key = snapshot.key ?? fresh!.jwk;
  const sessionDid = fresh?.did ?? profile.sessionDid ?? profile.did;
  const requestDid = fresh && profile.did.startsWith("did:key:") ? fresh.did : profile.did;

  // Start browser auth flow
  const acquireOpenKey = options.openKeyAcquisition ?? startAuthFlow;
  const delegationData = await acquireOpenKey(requestDid, {
    paste: options.paste,
    noPopup: options.noPopup,
    jwk: key,
    host,
    openkeyHost: resolveOpenKeyHost(profile),
    // A plain login sends the default abilities plus delegation/list explicitly. With a pinned
    // owner (or --owner) the space is that owner's, so OpenKey preselects its key; the signed
    // owner is verified below.
    permissions: permissions ?? ownerLoginPermissions(expectedOwner),
    expiry: openKeyExpiry,
    ...(permissions ? { reason: "Allow this TinyCloud CLI profile to use the permissions in the requested manifest." } : {}),
  });

  // Login persists only signed, verified authority: the owner, permissions,
  // expiry and space all come from OpenKey's proof for this profile's key.
  // The saved session always signs with key.json's key, the one the proof was
  // verified against; a JWK the callback echoes is never trusted (TC-1053).
  let sanitizedSession: Record<string, unknown>;
  let verifiedOwner: string | undefined;
  let declined: PermissionEntry[] = [];
  let legacyNested: PermissionEntry[] = [];
  if (permissions) {
    const verified = verifyScopedLogin(delegationData, key, sessionDid, permissions, { expectedOwner, expiry });
    sanitizedSession = verified.session;
    legacyNested = verified.legacyNested;
    verifiedOwner = sanitizedSession.ownerDid as string;
    declined = declinedPermissions(permissions, sanitizedSession.permissions as PermissionEntry[], verifiedOwner);
  } else {
    // A delegation without a verifiable proof for this key is refused, never saved (TC-1053).
    const signed = verifySignedSession(delegationData, key, sessionDid, { expectedOwner, expiry });
    // The session's space must belong to the signing owner, as on the scoped path.
    const spaceId = String(delegationData.spaceId);
    if (normalizePkhIdentifier(ownerSpaceId(spaceId.split(":").at(-1) ?? "", signed.ownerDid)) !== normalizePkhIdentifier(spaceId)) {
      throw new CLIError("OPENKEY_SCOPE_MISMATCH", "The approved session is for a space the signing account doesn't own. No session was saved.", ExitCode.PERMISSION_DENIED);
    }
    verifiedOwner = signed.ownerDid;
    sanitizedSession = withVerifiedAuthority({ ...delegationData, jwk: key }, signed);
  }

  // OpenKey's unsigned `primary` flag describes the key that signed, so it is
  // recorded only beside a verified owner.
  const ownerKeyPrimary = verifiedOwner === undefined ? undefined : openKeyPrimaryFlag(delegationData);
  const updatedProfile: ProfileConfig = withOwnerKeyPrimary({
    ...profile,
    host: options.persistHost === true || !profile.host ? host : profile.host,
    did: requestDid,
    sessionDid,
    posture: profile.posture ?? "owner-openkey",
    operatorType: profile.operatorType ?? "human",
    authMethod: "openkey" as const,
    ...(typeof sanitizedSession.spaceId === "string" ? { spaceId: sanitizedSession.spaceId } : {}),
    ...(verifiedOwner === undefined ? {} : { ownerDid: verifiedOwner }),
  }, ownerKeyPrimary);
  delete updatedProfile.namedKeys;

  await commitLogin(profileName, snapshot, {
    key,
    session: sanitizedSession,
    profile: updatedProfile,
    ...(permissions && verifiedOwner
      ? { approved: { scope: sanitizedSession.permissions as PermissionEntry[], ownerDid: verifiedOwner, replaceSession: options.replaceSession === true } }
      : {}),
  });
  warnIfNotPrimaryKey(verifiedOwner, ownerKeyPrimary);
  announceFirstOwner(profileName, expectedOwner, verifiedOwner);

  return { profile: updatedProfile, delegationData: sanitizedSession, declined, legacyNested };
}
