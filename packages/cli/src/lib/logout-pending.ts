import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { createProfileReplicaPurge, REPLICA_LOGOUT_PENDING_FILE } from "@tinycloud/node-sdk";
import { profilePath } from "@tinycloud/operations/state";
import { readGateSnapshot } from "@tinycloud/replica/profile-gate";
import { REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";
import { ProfileManager } from "../config/profiles.js";
import { ExitCode } from "../config/constants.js";
import { CLIError } from "../output/errors.js";
import { removeProfileReplicas } from "./profile-replicas.js";

export function profilePurge(name: string) {
  return createProfileReplicaPurge({
    profileDir: profilePath(name),
    guard: (section) => ProfileManager.withLock(name, section, { requireProfile: true }),
  });
}

/** Attempt both unlinks independently; the durable marker remains until both are absent and fsynced. */
export async function clearProfileCredentials(name: string, syncDirectory = false): Promise<void> {
  const profile = await ProfileManager.getProfile(name);
  await ProfileManager.setProfileDurable(name, { ...profile, authSignedOut: true });
  let failed = false;
  let error: unknown;
  try { await ProfileManager.removeKey(name); } catch (cause) { failed = true; error = cause; }
  try { await ProfileManager.clearSession(name); } catch (cause) { if (!failed) error = cause; failed = true; }
  if (failed) throw error;
  if (syncDirectory) {
    const directory = await open(profilePath(name), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
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
    let remaining: number;
    try {
      remaining = (await readGateSnapshot(profilePath(name)))?.intents.length ?? 0;
    } catch {
      throw new CLIError("REPLICA_PURGE_FAILED",
        "The replica gate is unreadable without a logout marker; network restore and local replica reads remain blocked.",
        ExitCode.ERROR, { failed: [{ id: "logout", code: "gate_unavailable" }], remaining: 1 });
    }
    if (remaining) {
      throw new CLIError("REPLICA_PURGE_FAILED",
        `The replica gate has ${remaining} pending purge intents without a logout marker; network restore is blocked.`,
        ExitCode.ERROR, { remaining });
    }
    return;
  }
  const report = await ProfileManager.withLock(name, () => profilePurge(name).recoverLogoutPending({
    signal: new AbortController().signal,
    clearCredentials: () => clearProfileCredentials(name),
    eraseLegacyReplicas: async ({ discardLocalChanges }) => {
      await removeProfileReplicas(name, { discardLocalChanges });
    },
  }), { requireProfile: true });
  if (report.failed.length || report.remaining) {
    throw new CLIError("REPLICA_PURGE_FAILED",
      `A durable logout is pending (${report.failed.map(({ code }) => code).join(", ") || `${report.remaining} intents remaining`}). Network restore and replica reads remain blocked; retry this command to complete credential and replica cleanup.`,
      ExitCode.ERROR, { failed: report.failed, remaining: report.remaining });
  }
}
