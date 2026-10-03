import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ProfileLockTimeoutError } from "@tinycloud/operations/state";
import { ExitCode, PROFILE_COMMIT_LOCK_TIMEOUT_MS } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import type { ProfileConfig } from "../config/types.js";
import { CLIError } from "../output/errors.js";
import { normalizePkhIdentifier } from "../lib/space.js";
import { keyToDID } from "./local-key.js";
import { canonicalJson, CLOCK_SKEW_MS, isLegacyNestedDecrypt, isLocalOwnerProfile, scopeCovers, sessionExpiresAt, SIGNED_RECAP } from "./scoped-login.js";

/** Scoped and device logins never turn a local-owner-key profile into a mixed OpenKey profile. */
export function assertNotLocalOwner(profileName: string, profile: ProfileConfig | null, flow: string): void {
  if (profile === null || !isLocalOwnerProfile(profile)) return;
  throw new CLIError(
    "LOCAL_OWNER_PROFILE",
    `Profile "${profileName}" holds a local owner key. ${flow} would turn it into an OpenKey profile while keeping that key. Use a separate profile: \`tc init --name publisher --key-only\`, then \`tc --profile publisher auth login --device --manifest ...\`.`,
    ExitCode.USAGE_ERROR,
  );
}

/**
 * Profile state a login decided on before waiting for consent. Approval can
 * take up to an hour; the commit refuses if any of it changed meanwhile.
 */
export interface ProfileSnapshot {
  readonly profile: ProfileConfig | null;
  readonly key: object | null;
  readonly session: Record<string, unknown> | null;
}

/** Read profile, key and session. Only a missing profile is `null`; an unreadable one is an error. */
export async function readProfileSnapshot(profileName: string): Promise<ProfileSnapshot> {
  const profile = await ProfileManager.getProfile(profileName).catch((error: unknown) => {
    if (error instanceof CLIError && error.code === "PROFILE_NOT_FOUND") return null;
    throw error;
  });
  return {
    profile,
    key: await ProfileManager.getKey(profileName),
    session: await ProfileManager.getSession(profileName) as Record<string, unknown> | null,
  };
}

/**
 * Whether profile, key and session describe one login. A crash between the
 * commit's writes (or an older release) can leave a session beside the wrong
 * key or profile; such state is never silently replaced.
 */
function inconsistency(snapshot: ProfileSnapshot): string | undefined {
  const { profile, key, session } = snapshot;
  if (session === null) return undefined;
  const sessionKeyDid = typeof session.verificationMethod === "string" ? session.verificationMethod.split("#")[0] : undefined;
  if (sessionKeyDid !== undefined && key !== null && keyToDID(key).split("#")[0] !== sessionKeyDid) return "the session belongs to another key";
  if (sessionKeyDid !== undefined && typeof profile?.sessionDid === "string" && profile.sessionDid.split("#")[0] !== sessionKeyDid) {
    return "the session belongs to another session DID than the profile records";
  }
  if (typeof session.spaceId === "string" && typeof profile?.spaceId === "string" &&
    normalizePkhIdentifier(session.spaceId) !== normalizePkhIdentifier(profile.spaceId)) return "the session's space differs from the profile's";
  if (typeof session.ownerDid === "string") {
    // A session records its owner only when a verified login wrote it, and
    // that login also pins the owner on the profile.
    if (typeof profile?.ownerDid !== "string") return "the session names an owner the profile does not record";
    if (normalizePkhIdentifier(session.ownerDid) !== normalizePkhIdentifier(profile.ownerDid)) return "the session's owner differs from the profile's";
  }
  return undefined;
}

/**
 * A live session may be replaced only by a scope that keeps everything it
 * holds, for the same owner, with no added caveat, and lasts at least as long
 * (renewal, or widening a narrowed approval). Only signed-recap permissions
 * are trusted to describe what a session holds; inconsistent state is never
 * replaced implicitly. Callers skip this with --replace-session.
 */
export function assertSessionReplaceable(
  profileName: string,
  snapshot: ProfileSnapshot,
  ownerDid: string | undefined,
  scope: readonly PermissionEntry[],
  newExpiresAt?: string,
): void {
  const problem = inconsistency(snapshot);
  if (problem !== undefined) {
    throw new CLIError(
      "PROFILE_STATE_INCONSISTENT",
      `Profile "${profileName}" is inconsistent (${problem}), possibly from an interrupted write. Nothing was saved. Check \`tc --profile ${profileName} context\`, then pass --replace-session to replace this state, or use a new profile.`,
      ExitCode.ERROR,
    );
  }
  const { session } = snapshot;
  if (session === null) return;
  const expiresAt = sessionExpiresAt(session);
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) return;
  const held = Array.isArray(session.permissions) ? (session.permissions as PermissionEntry[]).filter((permission) =>
    ownerDid === undefined || typeof session.spaceId !== "string" ||
    !isLegacyNestedDecrypt(permission, scope, ownerDid, session.spaceId)) : undefined;
  const keepsScope = ownerDid !== undefined && session.permissionsSource === SIGNED_RECAP && held !== undefined &&
    scopeCovers(scope, held, ownerDid);
  const shortens = newExpiresAt !== undefined && expiresAt !== null && Date.parse(newExpiresAt) < Date.parse(expiresAt) - CLOCK_SKEW_MS;
  if (keepsScope && !shortens) return;
  const space = typeof session.spaceId === "string" ? session.spaceId : "an unknown space";
  throw new CLIError(
    "SESSION_IN_USE",
    `Profile "${profileName}" has a live session for ${space}${expiresAt ? ` until ${expiresAt}` : ""} that this login would ${keepsScope ? "shorten" : "narrow or replace"}, dropping that authority. Nothing was saved. ` +
      "Keep the user's existing profiles: use a new profile name (`tc init --name publisher --key-only`, then `tc --profile publisher auth login --device --manifest ...`), or pass --replace-session to replace this session.",
    ExitCode.USAGE_ERROR,
  );
}

export interface LoginCommit {
  readonly key: object;
  readonly session: Record<string, unknown>;
  readonly profile: ProfileConfig;
  /**
   * For scoped logins: the verified approved scope and its owner, checked
   * against the live session unless `replaceSession` is set.
   */
  readonly approved?: { readonly scope: readonly PermissionEntry[]; readonly ownerDid: string; readonly replaceSession: boolean };
}

/**
 * Put back the state read under the lock; `null` removes the file. Every
 * write is attempted even if an earlier one fails; returns the failures.
 */
async function restore(profileName: string, state: ProfileSnapshot): Promise<unknown[]> {
  const writes = [
    () => state.key === null ? ProfileManager.removeKey(profileName) : ProfileManager.setKey(profileName, state.key),
    () => state.session === null ? ProfileManager.clearSession(profileName) : ProfileManager.setSession(profileName, state.session),
    () => state.profile === null ? ProfileManager.removeProfileConfig(profileName) : ProfileManager.setProfile(profileName, state.profile),
  ];
  const failures: unknown[] = [];
  for (const write of writes) {
    try {
      await write();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compare-and-commit under the profile lock: re-read the profile, key and
 * session, refuse if they changed since `snapshot` (another login, a key
 * rotation, a logout), re-check that the approved scope keeps the live
 * session's authority, then write key, session and profile. If any write
 * fails, the state read under the lock is restored before the lock is
 * released, so no reader sees a new session beside an old profile. If the
 * restore fails too, the error says the profile is inconsistent and names
 * every failure.
 */
export async function commitLogin(profileName: string, snapshot: ProfileSnapshot, commit: LoginCommit): Promise<void> {
  await ProfileManager.withLock(profileName, async () => {
    const current = await readProfileSnapshot(profileName);
    if (
      canonicalJson(current.profile) !== canonicalJson(snapshot.profile) ||
      canonicalJson(current.key) !== canonicalJson(snapshot.key) ||
      canonicalJson(current.session) !== canonicalJson(snapshot.session)
    ) {
      throw new CLIError(
        "PROFILE_CHANGED_DURING_LOGIN",
        `Profile "${profileName}" changed while this login was in progress (another login, key rotation or logout). Nothing was saved; check \`tc --profile ${profileName} context\` and run the login again if it is still needed.`,
        ExitCode.ERROR,
      );
    }
    if (commit.approved && !commit.approved.replaceSession) {
      const newExpiresAt = sessionExpiresAt(commit.session) ?? undefined;
      assertSessionReplaceable(profileName, current, commit.approved.ownerDid, commit.approved.scope, newExpiresAt);
    }
    try {
      await ProfileManager.setKey(profileName, commit.key);
      await ProfileManager.setSession(profileName, commit.session);
      await ProfileManager.setProfile(profileName, commit.profile);
    } catch (error) {
      const failures = await restore(profileName, current);
      if (failures.length === 0) throw error;
      throw new CLIError(
        "PROFILE_STATE_INCONSISTENT",
        `Saving the login for profile "${profileName}" failed (${errorMessage(error)}), and restoring its previous state failed too (${failures.map(errorMessage).join("; ")}). ` +
          `The profile's key, session and settings may not match. Check \`tc --profile ${profileName} context\`, then run the login again with --replace-session, or use a new profile.`,
        ExitCode.ERROR,
      );
    }
  }, { timeoutMs: PROFILE_COMMIT_LOCK_TIMEOUT_MS }).catch((error: unknown) => {
    if (!(error instanceof ProfileLockTimeoutError)) throw error;
    throw new CLIError(
      "PROFILE_LOCK_TIMEOUT",
      `Another tc process kept profile "${profileName}" locked for ${PROFILE_COMMIT_LOCK_TIMEOUT_MS / 1000} s, so the approved login was not saved. Wait for it to finish (a crashed process's lock is reclaimed after 30 s) and run the login again.`,
      ExitCode.ERROR,
    );
  });
}
