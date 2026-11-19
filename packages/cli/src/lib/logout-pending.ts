import { lstat, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createProfileReplicaPurge, logoutPrincipalDigest, REPLICA_LOGOUT_PENDING_FILE, RESTORED_GATE_MESSAGE } from "@tinycloud/node-sdk";
import type {
  ProfileReplicaLogoutPending, ProfileReplicaPreflight, ProfileReplicaRootIdentity, ProfileReplicaUnknownEntry,
  ReplicaEraseReport,
} from "@tinycloud/sdk-services/kv/replication";
import { namedProfilePath, profilePath } from "@tinycloud/operations/state";
import { principalHashOf, readGateSnapshot, readLogoutGate } from "@tinycloud/replica/profile-gate";
import { REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { removeProfileReplicas } from "./profile-replicas.js";
import { REPLICATION_DIAGNOSTIC_FILES } from "./replication-log.js";

export function profilePurge(name: string) {
  return createProfileReplicaPurge({
    profileDir: profilePath(name),
    guard: (section) => ProfileManager.withLock(name, section, { requireProfile: true }),
    diagnosticFiles: REPLICATION_DIAGNOSTIC_FILES,
  });
}

type LegacyEraseInventory = {
  discardLocalChanges: boolean;
  approvedUnknown: readonly ProfileReplicaUnknownEntry[];
  knownRoots: readonly ProfileReplicaRootIdentity[];
  knownEntries: readonly ProfileReplicaUnknownEntry[];
  missingDatabases: readonly string[];
};

/** The facade validates the full marker; only its legacy paths belong to the CLI remover. */
export async function eraseApprovedLegacyReplicas(name: string, inventory: LegacyEraseInventory): Promise<string[]> {
  const isLegacy = (path: string) => path === "replicas" || path.startsWith("replicas/");
  return removeProfileReplicas(name, {
    discardLocalChanges: inventory.discardLocalChanges,
    approvedUnknown: inventory.approvedUnknown.filter((entry) => isLegacy(entry.path)),
    knownRoots: inventory.knownRoots.filter((entry) => isLegacy(entry.path)),
    knownEntries: inventory.knownEntries.filter((entry) => isLegacy(entry.path)),
    missingDatabases: inventory.missingDatabases.filter(isLegacy),
  });
}

/**
 * The legacy mirror belongs to the profile, not an account, so another account's logout
 * erases it after both credentials are gone. With the displayed approval it removes that
 * exact inventory; a replay without one (startup) removes only source-known children. The
 * durable reminder clears only after the erase.
 */
export async function finishLegacyReplicaCleanup(
  name: string, approval?: ProfileReplicaPreflight, discardLocalChanges = false,
): Promise<string[]> {
  const removed = approval
    ? await eraseApprovedLegacyReplicas(name, {
        discardLocalChanges,
        approvedUnknown: discardLocalChanges ? approval.unknownEntries : [],
        knownRoots: approval.knownRoots, knownEntries: approval.knownEntries,
        missingDatabases: approval.missingDatabases,
      })
    : await removeProfileReplicas(name);
  const { legacyReplicaCleanup: _pending, ...profile } = await ProfileManager.getProfile(name);
  await ProfileManager.setProfileDurable(name, profile);
  return removed;
}

/** True when the gate's active (or deferred) account is not `principal`: "Logout by another account". */
export async function gateHeldByAnotherAccount(name: string, principal: string): Promise<boolean> {
  const read = await readLogoutGate(profilePath(name));
  if (read === undefined) return false;
  const { state } = read;
  const hash = await principalHashOf(state.salt, principal);
  return state.principalHash !== null
    ? state.principalHash !== hash
    : state.eraseDeferred && state.deferredPrincipalHash !== hash;
}

/**
 * A logout marker binds the principal that started it. Never let a different
 * signed-in principal finish it: recovery would shred that principal's session.
 */
export function assertPendingLogoutOwner(name: string, principalDigest: string, principal: string): void {
  if (principalDigest === logoutPrincipalDigest(principal)) return;
  throw new CLIError("REPLICA_GATED",
    `The pending logout on profile "${name}" belongs to a different principal than the current session; ` +
    "credentials, replica files and the logout marker were left unchanged, and local replica reads stay blocked. " +
    "Contact support to finish it.",
    ExitCode.ERROR);
}

/**
 * A failed online revoke retains the original session for that retry alone.
 * Revalidate the persisted marker, inventory and exact session under the
 * profile lock; ordinary SDK callers still run recovery and reject the marker.
 */
export async function assertPendingRemoteLogoutSession(
  name: string,
  expected: { marker: ProfileReplicaLogoutPending; ownerDid: string; sessionCid: string },
): Promise<void> {
  if (expected.marker.remotePending !== true) {
    throw new CLIError("REPLICA_GATED", "Remote revocation is not pending for this profile.", ExitCode.ERROR);
  }
  await ProfileManager.withLock(name, async () => {
    const profile = await ProfileManager.getProfile(name);
    const session = await ProfileManager.getSession(name);
    if (profile.authSignedOut === true || !session ||
        !("ownerDid" in session) || session.ownerDid !== expected.ownerDid ||
        !("delegationCid" in session) || session.delegationCid !== expected.sessionCid) {
      throw new CLIError("PROFILE_CHANGED_DURING_REVOKE",
        "The retained revocation session changed; no online request was attempted.", ExitCode.ERROR);
    }
    const purge = profilePurge(name);
    if (!await purge.remotePendingLogout({ principal: expected.ownerDid })) {
      throw new CLIError("REPLICA_GATED",
        "The original denied remote revocation marker is absent; no online request was attempted.",
        ExitCode.ERROR);
    }
    const approval = await purge.preflightLogout({ principal: expected.ownerDid, discardLocalChanges: true });
    const marker = await purge.prepareLogoutPending({
      principal: expected.ownerDid,
      approval,
      discardLocalChanges: expected.marker.discardLocalChanges === true,
      remotePending: true,
    });
    if (marker === null || JSON.stringify(marker) !== JSON.stringify(expected.marker)) {
      throw new CLIError("REPLICA_GATED",
        "The approved remote revocation marker changed; no online request was attempted.", ExitCode.ERROR);
    }
  }, { requireProfile: true });
}


/** Remove request keys before the durable signed-out fence, then attempt both credential unlinks. */
export async function clearProfileCredentials(name: string, syncDirectory = false, legacyCleanup = false): Promise<void> {
  await ProfileManager.withLock(name, async () => {
    const profile = await ProfileManager.getProfile(name);
    const { namedKeys: _namedKeys, ...signedOutProfile } = profile;
    await rm(join(profilePath(name), "approval-pending.json"), { force: true });
    // This durable profile write syncs the pending-key removal before logout can be observed.
    await ProfileManager.setProfileDurable(name, { ...signedOutProfile, authSignedOut: true, ...(legacyCleanup ? { legacyReplicaCleanup: true } : {}) });
    let failed = false;
    let error: unknown;
    try { await ProfileManager.removeKey(name); } catch (cause) { failed = true; error = cause; }
    try { await ProfileManager.clearSession(name); } catch (cause) { if (!failed) error = cause; failed = true; }
    if (failed) throw error;
    if (syncDirectory) {
      const directory = await open(profilePath(name), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }, { requireProfile: true });
}

/** A crash after the durable signed-out flag but before unlink must not strand private keys. */
async function finishSignedOutCredentialRemoval(name: string): Promise<void> {
  const profile = await ProfileManager.getProfile(name).catch((error: unknown) => {
    if (error instanceof CLIError && error.code === "PROFILE_NOT_FOUND") return null;
    throw error;
  });
  if (profile?.authSignedOut !== true) return;
  for (const file of ["session.json", "key.json"]) {
    try {
      await lstat(join(profilePath(name), file));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    await ProfileManager.withLock(name, async () => {
      if ((await ProfileManager.getProfile(name)).authSignedOut === true) {
        await clearProfileCredentials(name, true);
      }
    }, { requireProfile: true });
    return;
  }
}


/** Run before reading or restoring an on-disk session; a surviving marker is never authority. */
export async function recoverPendingLogout(name: string): Promise<void> {
  try {
    await lstat(join(profilePath(name), REPLICA_LOGOUT_PENDING_FILE));
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
    await finishSignedOutCredentialRemoval(name);
    // A headless explicit-key identity may have no stored profile at all.
    try {
      await lstat(profilePath(name));
    } catch (missing) {
      if (typeof missing === "object" && missing !== null && "code" in missing && missing.code === "ENOENT") return;
      throw missing;
    }
    // No marker means no erase is authorized. Inspect only: taking the
    // profile lock here would block unrelated node revocations while another
    // command holds it for a later local grant removal.
    const profile = await ProfileManager.getProfile(name).catch((profileError: unknown) => {
      if (profileError instanceof CLIError && profileError.code === "PROFILE_NOT_FOUND") return null;
      throw profileError;
    });
    if (!profile) {
      // `auth login` can create a fresh profile directory before profile.json.
      // Do not accept a missing profile when orphan replica state survived.
      for (const child of [REPLICA_GATE_FILE, "replicas", "replication"]) {
        try {
          await lstat(join(profilePath(name), child));
        } catch (childError) {
          if (typeof childError === "object" && childError !== null &&
              "code" in childError && childError.code === "ENOENT") continue;
          throw childError;
        }
        throw new CLIError("REPLICA_GATED",
          `Profile "${name}" is missing its settings but retains replica state (${child}); refuse implicit recovery.`,
          ExitCode.ERROR);
      }
      return;
    }
    if (profile.authSignedOut === true && profile.legacyReplicaCleanup === true) {
      // Another account's logout cleared both credentials but was interrupted before the
      // legacy mirror went: replay that erase for source-known children only.
      await ProfileManager.withLock(name, async () => {
        const current = await ProfileManager.getProfile(name);
        if (current.authSignedOut === true && current.legacyReplicaCleanup === true) await finishLegacyReplicaCleanup(name);
      }, { requireProfile: true });
    }
    let remaining: number;
    try {
      remaining = (await readGateSnapshot(profilePath(name)))?.intents.length ?? 0;
    } catch (error) {
      throw new CLIError("REPLICA_PURGE_FAILED",
        `The replica gate is unreadable without a logout marker; network restore and local replica reads remain blocked.${
          error instanceof Error ? ` ${error.message}` : ""}`,
        ExitCode.ERROR, { failed: [{ id: "logout", code: "gate_unavailable" }], remaining: 1 });
    }
    if (remaining) {
      throw new CLIError("REPLICA_PURGE_FAILED",
        `The replica gate has ${remaining} pending purge intents without a logout marker; network restore is blocked.`,
        ExitCode.ERROR, { remaining });
    }
    return;
  }
  const report = await ProfileManager.withLock(name, async () => {
    // An unreadable session cannot be attributed to the marker's principal. The session
    // reader also reads profile.json (its signed-out flag), so name whichever file failed.
    const unreadable = (file: string) => new CLIError("REPLICA_GATED",
      `A logout is pending on profile "${name}", but its ${file === "profile.json" ? "profile" : "session"} file ` +
      `${join(namedProfilePath(name), file)} is unreadable; ` +
      "credentials, replica files and the logout marker were left unchanged, and local replica reads stay blocked.",
      ExitCode.ERROR);
    try {
      await ProfileManager.getProfile(name);
    } catch {
      throw unreadable("profile.json");
    }
    let session: object | null;
    try {
      session = await ProfileManager.getSession(name);
    } catch {
      throw unreadable("session.json");
    }
    if (session) {
      // An unreadable or malformed marker skips this check; the facade then
      // refuses it as a failed recovery without touching anything.
      const marker: unknown = await readFile(join(profilePath(name), REPLICA_LOGOUT_PENDING_FILE), "utf8")
        .then((text): unknown => {
          try { return JSON.parse(text); } catch { return null; }
        }, () => null);
      if (typeof marker === "object" && marker !== null && "principalDigest" in marker &&
          typeof marker.principalDigest === "string") {
        const profile = await ProfileManager.getProfile(name);
        const owner = "ownerDid" in session && typeof session.ownerDid === "string" ? session.ownerDid : undefined;
        assertPendingLogoutOwner(name, marker.principalDigest, owner ?? profile.ownerDid ?? profile.did);
      }
    }
    return profilePurge(name).recoverLogoutPending({
      signal: new AbortController().signal,
      clearCredentials: () => clearProfileCredentials(name),
      eraseLegacyReplicas: async (inventory) => {
        await eraseApprovedLegacyReplicas(name, inventory);
      },
    });
  }, { requireProfile: true });
  refuseRestoredGate(report);
  if (report.failed.length || report.remaining) {
    throw new CLIError("REPLICA_PURGE_FAILED",
      `A durable logout is pending (${report.failed.map(({ code }) => code).join(", ") || `${report.remaining} intents remaining`}). Network restore and replica reads remain blocked; retry this command to complete credential and replica cleanup.`,
      ExitCode.ERROR, { failed: report.failed, remaining: report.remaining });
  }
}

/** A restored older gate cannot complete this logout in place (CONTRACT.md §2 "Restored older gate"). */
export function refuseRestoredGate(report: ReplicaEraseReport): void {
  if (report.failed.some(({ code }) => code === "gate_restored")) {
    throw new CLIError("REPLICA_GATED", RESTORED_GATE_MESSAGE, ExitCode.ERROR, { failed: report.failed });
  }
}
