import { ProfileManager } from "../config/profiles.js";
import { dropAllPendingDelegations } from "./pending-code.js";
import { canonicalJson, sessionStateIsUsable, storedSessionState } from "./scoped-login.js";
import type { ProfileSnapshot } from "./login-commit.js";

/** A profile this login created, and the default profile before it did (creating a profile can take over the default). */
export interface CreatedProfile {
  readonly previousDefaultProfile: string;
}

/** How the key this sign-in used came to be. Only a key THIS sign-in created is ever deleted. */
export interface KeyOrigin {
  /** The profile (and its key) was created by this login. */
  readonly createdProfile?: CreatedProfile;
  /** `auth rotate` generated the key just before this sign-in. */
  readonly rotatedKey?: boolean;
}

const approvalText = (until: string | undefined): string => `OpenKey granted this approval${until === undefined ? "" : ` until ${until}`}`;
export const keyDeletedLine = (until?: string): string =>
  `${approvalText(until)}, but this CLI did not use it and its key was deleted, so it cannot be used. You can also remove it at account.tinycloud.xyz.`;
export const keyKeptLine = (until?: string): string =>
  `${approvalText(until)} and the key it belongs to still exists on this device (other grants use it). Revoke it at account.tinycloud.xyz.`;
const keyNotDeletedLine = (until: string | undefined, reason: string): string =>
  `${approvalText(until)}, but this CLI did not use it and could not delete its key (${reason}). Revoke it at account.tinycloud.xyz.`;

/**
 * When the grant OpenKey made ends: the `Expiration Time` of the result's own SIWE (the last anchored line, as the saved
 * session reads it). Display only, so an unverified result still says what it claims; no readable line means no date.
 */
function grantedUntil(delegation: Record<string, unknown>): string | undefined {
  const siwe = typeof delegation.siwe === "string" ? delegation.siwe : "";
  const raw = [...siwe.matchAll(/^Expiration Time: (.+)$/gm)].at(-1)?.[1];
  const ms = raw === undefined ? NaN : Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * A paste login's refusal comes AFTER OpenKey granted the approval to the profile's key, so refusing the signed message
 * alone leaves a live grant. Make it unusable where this sign-in can: always delete the saved copy of the pasted code, and
 * delete the key IF THIS SIGN-IN CREATED IT (a profile this login created, a rotation, a key held only in memory), removing
 * a profile this login created if nothing else lives in it. A key that already existed (other grants or sessions may depend
 * on it, whether or not one is live now), or one another login replaced meanwhile, is KEPT. One plain line goes to stderr
 * telling the owner the grant is live until its date and where to revoke it. This never throws: the caller is about to
 * report the refusal itself.
 *
 * The CLI cannot revoke the grant itself: revoking needs `tinycloud.delegation/revoke` on the delegation's CID, which a
 * login's approved set (kv, sql, capabilities read, delegation list) does not carry (TC-2308).
 */
export async function discardRefusedApproval(
  profileName: string,
  snapshot: ProfileSnapshot,
  delegation: Record<string, unknown>,
  origin: KeyOrigin = {},
): Promise<void> {
  const until = grantedUntil(delegation);
  const createdKey = origin.createdProfile !== undefined || origin.rotatedKey === true || snapshot.key === null;
  let line = keyKeptLine(until);
  try {
    await ProfileManager.withLock(profileName, async () => {
      // The saved copy of a refused approval must never be served again, whether or not the key goes.
      await dropAllPendingDelegations(profileName);
      if (!createdKey) return;
      const profile = await ProfileManager.getProfile(profileName).catch(() => null);
      const session = await ProfileManager.getSession(profileName) as Record<string, unknown> | null;
      // Defensive: a session that became live meanwhile (another login) uses this profile's key.
      if (session !== null && sessionStateIsUsable(storedSessionState(session, profile).state)) return;
      if (canonicalJson(await ProfileManager.getKey(profileName)) !== canonicalJson(snapshot.key)) return;
      await ProfileManager.removeKey(profileName);
      line = keyDeletedLine(until);
      const onlyThisLogin = origin.createdProfile !== undefined && session === null && profile !== null &&
        profile.ownerDid === undefined && profile.authMethod === undefined && profile.spaceId === undefined;
      if (!onlyThisLogin) return;
      await ProfileManager.removeProfileConfig(profileName);
      const config = await ProfileManager.getConfig();
      if (config.defaultProfile === profileName) await ProfileManager.setConfig({ ...config, defaultProfile: origin.createdProfile!.previousDefaultProfile });
    });
  } catch (error) {
    line = keyNotDeletedLine(until, error instanceof Error ? error.message : String(error));
  }
  process.stderr.write(`${line}\n`);
}
