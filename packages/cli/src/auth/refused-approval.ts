import { ProfileManager } from "../config/profiles.js";
import { dropAllPendingDelegations } from "./pending-code.js";
import { canonicalJson, sessionStateIsUsable, storedSessionState } from "./scoped-login.js";
import type { ProfileSnapshot } from "./login-commit.js";

/** A profile this login created, and the default profile before it did (creating a profile can take over the default). */
export interface CreatedProfile {
  readonly previousDefaultProfile: string;
}

export const REFUSED_APPROVAL_KEY_DELETED =
  "The approval was not used and its key was deleted, so it cannot be used. You can also remove it at account.tinycloud.xyz.";
export const REFUSED_APPROVAL_KEY_KEPT =
  "The approval was not used, but this profile's key was kept because it is still in use, so the approval stays active until you remove it at account.tinycloud.xyz.";

/**
 * A paste login's refusal comes AFTER OpenKey created the delegation to the profile's key, so refusing the signed message
 * alone leaves a live grant and the key that can use it on disk. Make the approval unusable: delete the saved copy of the
 * redeemed code, and the profile's key; remove a profile this login created if nothing else lives in it. A key that a live
 * session uses (or one another login changed meanwhile) is never deleted: its approval stays active and the line says so.
 * One plain line goes to stderr. This never throws: the caller is about to report the refusal itself.
 *
 * The delegation cannot be revoked from here: revoking needs `tinycloud.delegation/revoke` on the delegation's CID, which a
 * login's approved set (kv, sql, capabilities read, delegation list) does not carry.
 */
export async function discardRefusedApproval(profileName: string, snapshot: ProfileSnapshot, created?: CreatedProfile): Promise<void> {
  let line = REFUSED_APPROVAL_KEY_KEPT;
  try {
    await ProfileManager.withLock(profileName, async () => {
      // The saved copy of a refused approval must never be served again, whether or not the key goes.
      await dropAllPendingDelegations(profileName);
      const profile = await ProfileManager.getProfile(profileName).catch(() => null);
      const session = await ProfileManager.getSession(profileName) as Record<string, unknown> | null;
      if (session !== null && sessionStateIsUsable(storedSessionState(session, profile).state)) return;
      if (canonicalJson(await ProfileManager.getKey(profileName)) !== canonicalJson(snapshot.key)) return;
      await ProfileManager.removeKey(profileName);
      line = REFUSED_APPROVAL_KEY_DELETED;
      const onlyThisLogin = created !== undefined && session === null && profile !== null &&
        profile.ownerDid === undefined && profile.authMethod === undefined && profile.spaceId === undefined;
      if (!onlyThisLogin) return;
      await ProfileManager.removeProfileConfig(profileName);
      const config = await ProfileManager.getConfig();
      if (config.defaultProfile === profileName) await ProfileManager.setConfig({ ...config, defaultProfile: created.previousDefaultProfile });
    });
  } catch (error) {
    line = `The approval was not used, but this profile's key could not be deleted (${error instanceof Error ? error.message : String(error)}), so the approval may still be active: remove it at account.tinycloud.xyz.`;
  }
  process.stderr.write(`${line}\n`);
}
