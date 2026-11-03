import { ProfileManager } from "../config/profiles.js";
import { dropCommittedDelegation } from "./pending-code.js";
import { carriedDelegation, isPermanentRefusal, refusalNotice, wasRefusedAfterApproval, type KeyOutcome } from "./refusal.js";
import { canonicalJson, sessionStateIsUsable, storedSessionState } from "./scoped-login.js";

/** A profile this login created, and the default profile before it did (creating a profile can take over the default). */
export interface CreatedProfile {
  readonly previousDefaultProfile: string;
}

/** What one sign-in or grant knew about its key when it asked OpenKey for the approval. */
export interface RefusalSite {
  readonly profileName: string;
  /** The key the approval was requested for. */
  readonly key: object;
  /** The profile's stored key when the command began; null when there was none. */
  readonly storedKey: object | null;
  /** The profile (and its key) was created by this very command. */
  readonly createdProfile?: CreatedProfile;
  /**
   * `auth rotate`: the staged key lives only in the pending request (the request file, mode 0600, until the approval verifies),
   * and a rotation never resumes a kept request. Any failure after the approval arrived therefore drops that request.
   */
  readonly rotation?: boolean;
}

/**
 * A key THIS sign-in created is one that never was, or only just was, the profile's: held in memory (a first paste sign-in) or
 * only in the pending request's file (a first sign-in or a rotation's staged key on the approval-request path: `key` is not the
 * stored key). Only those, and the key of a profile this command created, are ever deleted. A stored key that already existed is kept, whether or not a session is live now.
 */
const heldOnlyInMemory = (site: RefusalSite): boolean => site.storedKey === null || canonicalJson(site.storedKey) !== canonicalJson(site.key);

/**
 * OpenKey made the delegation BEFORE the CLI verified it, so refusing the signed message alone leaves a live grant. For a
 * PERMANENT refusal (see `isPermanentRefusal`; AUTH_EXPIRED, SESSION_IN_USE and the other resumable ones are not) this makes
 * the grant unusable where the CLI can and says so, once, on stderr:
 *   - the saved copy of the pasted code and the pending approval request it came from are dropped;
 *   - the key is deleted if this command created it (a key held only in memory, or the key of a profile it created, which
 *     is then removed too if nothing else lives in it); a key that already existed, or one another login changed meanwhile, is
 *     kept;
 *   - the notice names the delegation, until when it is live, and where the owner revokes it. The CLI cannot revoke it: a
 *     login's approved set (kv, sql, capabilities read, delegation list) carries no `tinycloud.delegation/revoke` (TC-2308).
 * Never throws: the caller is about to report the refusal itself. Not a refusal: no effect.
 */
export async function discardRefusedApproval(site: RefusalSite, error: unknown, result?: object): Promise<void> {
  if (!isPermanentRefusal(error)) return;
  // Raised before any approval existed (no result in hand, none carried): the owner granted nothing, so there is nothing to clean up or announce.
  if (result === undefined && !wasRefusedAfterApproval(error)) return;
  const delegation = (result as Record<string, unknown> | undefined) ?? carriedDelegation(error);
  let outcome: KeyOutcome = { kind: "kept" };
  try {
    if (delegation !== undefined) {
      await dropCommittedDelegation(site.profileName, delegation);
      const { dropRefusedApproval } = await import("./approval-request.js");
      await dropRefusedApproval(site.profileName, delegation);
    }
    if (heldOnlyInMemory(site)) {
      // A first sign-in's key may also sit in another pending request of the profile: then it still exists.
      const { approvalHoldsKey } = await import("./approval-request.js");
      if (!(await approvalHoldsKey(site.profileName, (site.key as { x?: unknown }).x))) outcome = { kind: "deleted" };
    } else if (site.createdProfile !== undefined) {
      outcome = await deleteCreatedProfileKey(site);
    }
  } catch (cleanupError) {
    outcome = { kind: "failed", reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) };
  }
  process.stderr.write(`${refusalNotice(delegation, outcome)}\n`);
}

/** Delete the key of a profile this command created, and the profile when this command's key was all that lived in it. */
async function deleteCreatedProfileKey(site: RefusalSite): Promise<KeyOutcome> {
  const created = site.createdProfile!;
  return ProfileManager.withLock(site.profileName, async (): Promise<KeyOutcome> => {
    const profile = await ProfileManager.getProfile(site.profileName).catch(() => null);
    const session = await ProfileManager.getSession(site.profileName) as Record<string, unknown> | null;
    // A session that became live meanwhile (another login) uses this profile's key, as does a key another login replaced.
    if (session !== null && sessionStateIsUsable(storedSessionState(session, profile).state)) return { kind: "kept" };
    if (canonicalJson(await ProfileManager.getKey(site.profileName)) !== canonicalJson(site.key)) return { kind: "kept" };
    await ProfileManager.removeKey(site.profileName);
    const onlyThisLogin = session === null && profile !== null &&
      profile.ownerDid === undefined && profile.authMethod === undefined && profile.spaceId === undefined;
    if (onlyThisLogin) {
      await ProfileManager.removeProfileConfig(site.profileName);
      const config = await ProfileManager.getConfig();
      if (config.defaultProfile === site.profileName) await ProfileManager.setConfig({ ...config, defaultProfile: created.previousDefaultProfile });
    }
    return { kind: "deleted" };
  });
}

/**
 * Run one approval-and-verify step. A permanent refusal from it is cleaned up and announced (`discardRefusedApproval`), then
 * rethrown unchanged. `seen.result` is set by the step as soon as OpenKey's result is in hand.
 */
export async function refusing<T>(site: RefusalSite, step: (seen: { result?: object }) => Promise<T>): Promise<T> {
  const seen: { result?: object } = {};
  try {
    return await step(seen);
  } catch (error) {
    if (site.rotation === true && seen.result !== undefined) {
      try {
        const { dropRefusedApproval } = await import("./approval-request.js");
        await dropRefusedApproval(site.profileName, seen.result);
      } catch { /* the request only expires on its own */ }
    }
    await discardRefusedApproval(site, error, seen.result);
    throw error;
  }
}
