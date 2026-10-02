import { join } from "node:path";
import { profilePath, profileConfigPath, sessionPath, readJson, readStoreMetadata, updateProfileStore, withProfileLock } from "@tinycloud/operations/state";
import { authStateDigest, AuthStateError, writePrivateAuthJson } from "./private-storage.js";

/** A protected write-ahead install lets the same approved response repair a partial session/profile write. */
export async function installVerifiedSession(
  profile: string,
  expectedProfile: object,
  expectedKey: object,
  nextProfile: object,
  session: object,
  signal?: AbortSignal,
): Promise<void> {
  await withProfileLock(profile, async () => {
    if (signal?.aborted) throw new AuthStateError("AUTH_CANCELLED", "Consent was cancelled.");
    await readStoreMetadata(profile, "session");
    const [currentProfile, currentKey] = await Promise.all([
      readJson(profileConfigPath(profile)), readJson(join(profilePath(profile), "key.json")),
    ]);
    if (authStateDigest(currentKey) !== authStateDigest(expectedKey) ||
      (authStateDigest(currentProfile) !== authStateDigest(expectedProfile) && authStateDigest(currentProfile) !== authStateDigest(nextProfile))) {
      throw new AuthStateError("AUTH_CONTEXT_CHANGED", "The selected profile or session key changed during consent.");
    }
    const installPath = join(profilePath(profile), "auth-install.json");
    const previous = await readJson<{ completed: boolean; sessionDigest: string; expectedProfileDigest: string }>(installPath);
    const sessionDigest = authStateDigest(session);
    if (previous && !previous.completed && previous.sessionDigest !== sessionDigest) {
      throw new AuthStateError("AUTH_CONTEXT_CHANGED", "A different session installation requires recovery first.");
    }
    const intent = { formatVersion: 1, expectedProfileDigest: authStateDigest(expectedProfile), expectedKeyDigest: authStateDigest(expectedKey), sessionDigest, profile: nextProfile, session };
    await writePrivateAuthJson(installPath, { ...intent, completed: false });
    await writePrivateAuthJson(sessionPath(profile), session);
    await writePrivateAuthJson(profileConfigPath(profile), nextProfile);
    await writePrivateAuthJson(installPath, { ...intent, completed: true });
  });
}

/** Finish a proof already verified and retained privately before a process interruption. */
export async function recoverVerifiedSessionInstall(profile: string): Promise<void> {
  await withProfileLock(profile, async () => {
    const path = join(profilePath(profile), "auth-install.json");
    const intent = await readJson<{ formatVersion: number; completed: boolean; expectedProfileDigest: string; expectedKeyDigest: string; sessionDigest: string; profile: object; session: object }>(path);
    if (!intent || intent.completed) return;
    const [currentProfile, currentKey] = await Promise.all([
      readJson(profileConfigPath(profile)), readJson(join(profilePath(profile), "key.json")),
    ]);
    if (intent.formatVersion !== 1 || authStateDigest(currentKey) !== intent.expectedKeyDigest ||
      authStateDigest(intent.session) !== intent.sessionDigest ||
      ![intent.expectedProfileDigest, authStateDigest(intent.profile)].includes(authStateDigest(currentProfile))) {
      throw new AuthStateError("AUTH_CONTEXT_CHANGED", "The interrupted authentication install cannot be recovered into a changed context.");
    }
    await readStoreMetadata(profile, "session");
    await writePrivateAuthJson(sessionPath(profile), intent.session);
    await writePrivateAuthJson(profileConfigPath(profile), intent.profile);
    await writePrivateAuthJson(path, { ...intent, completed: true });
  });
}

/** Install an already cryptographically verified additional scope under the shared store lock. */
export async function installVerifiedAdditionalDelegation<T extends { delegation: { cid: string } }>(
  profile: string, expectedProfile: object, expectedKey: object, entry: T, signal?: AbortSignal,
): Promise<void> {
  await updateProfileStore<T, void>(profile, "additional-delegations", async records => {
    if (signal?.aborted) throw new AuthStateError("AUTH_CANCELLED", "Consent was cancelled.");
    const [currentProfile, currentKey] = await Promise.all([
      readJson(profileConfigPath(profile)), readJson(join(profilePath(profile), "key.json")),
    ]);
    if (authStateDigest(currentKey) !== authStateDigest(expectedKey) || authStateDigest(currentProfile) !== authStateDigest(expectedProfile)) {
      throw new AuthStateError("AUTH_CONTEXT_CHANGED", "The selected profile or session key changed during consent.");
    }
    return { records: [...records.filter(record => record.delegation.cid !== entry.delegation.cid), entry], result: undefined };
  });
}
