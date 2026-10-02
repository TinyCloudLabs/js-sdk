import type { PermissionEntry } from "@tinycloud/node-sdk";
import { ExitCode } from "../config/constants.js";
import { ProfileManager } from "../config/profiles.js";
import { resolveProfilePosture, type ProfileConfig } from "../config/types.js";
import { CLIError } from "../output/errors.js";
import { permissionTuples, sessionExpiresAt, SIGNED_RECAP } from "./scoped-login.js";

/** Scoped and device logins never turn a local-owner-key profile into a mixed OpenKey profile. */
export function assertNotLocalOwner(profileName: string, profile: ProfileConfig | null, flow: string): void {
  if (profile === null || resolveProfilePosture(profile) !== "local-owner-key") return;
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
 * A live session may be replaced only by a scope that keeps everything it
 * holds, for the same owner (renewal, or widening a narrowed approval).
 * Only signed-recap permissions are trusted to describe what a session holds.
 */
export function assertSessionReplaceable(
  profileName: string,
  session: Record<string, unknown> | null,
  ownerDid: string | undefined,
  scope: readonly PermissionEntry[],
): void {
  if (session === null) return;
  const expiresAt = sessionExpiresAt(session);
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) return;
  if (ownerDid !== undefined && session.permissionsSource === SIGNED_RECAP && Array.isArray(session.permissions)) {
    const next = permissionTuples(scope, ownerDid);
    if ([...permissionTuples(session.permissions as PermissionEntry[], ownerDid)].every((tuple) => next.has(tuple))) return;
  }
  const space = typeof session.spaceId === "string" ? session.spaceId : "an unknown space";
  throw new CLIError(
    "SESSION_IN_USE",
    `Profile "${profileName}" has a live session for ${space}${expiresAt ? ` until ${expiresAt}` : ""} that this login would narrow or replace, dropping that authority. Nothing was saved. ` +
      "Keep the user's existing profiles: use a new profile name (`tc init --name publisher --key-only`, then `tc --profile publisher auth login --device --manifest ...`), or pass --replace-session to replace this session.",
    ExitCode.USAGE_ERROR,
  );
}

function canonicalJson(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry)
    ? entry.map(canonical)
    : entry && typeof entry === "object"
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([name, inner]) => [name, canonical(inner)]))
      : entry;
  return JSON.stringify(canonical(value) ?? null);
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
 * Compare-and-commit under the profile lock: re-read the profile, key and
 * session, refuse if they changed since `snapshot` (another login, a key
 * rotation, a logout), re-check that the approved scope keeps the live
 * session's authority, then write key, session and profile together.
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
        `Profile "${profileName}" changed while waiting for approval (another login, key rotation or logout). Nothing was saved; check \`tc --profile ${profileName} context\` and run the login again if it is still needed.`,
        ExitCode.ERROR,
      );
    }
    if (commit.approved && !commit.approved.replaceSession) {
      assertSessionReplaceable(profileName, current.session, commit.approved.ownerDid, commit.approved.scope);
    }
    await ProfileManager.setKey(profileName, commit.key);
    await ProfileManager.setSession(profileName, commit.session);
    await ProfileManager.setProfile(profileName, commit.profile);
  });
}
