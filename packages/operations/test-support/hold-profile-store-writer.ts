import {
  profileStoreMetadataPath,
  profileStorePath,
  readProfileStore,
  withProfileLock,
  writeJsonAtomic,
} from "../src/state.js";
import {
  PROFILE_LOCK_HOLDER_RELEASE_TIMEOUT_MS,
  signalProfileLockProtocol,
  waitForProfileLockProtocol,
} from "../src/test-support/profile-lock-protocol.js";

const [profile, store, key, encodedRecord, readyPath, releasePath] = process.argv.slice(2);
if (
  !profile ||
  (store !== "auth-requests" && store !== "additional-delegations") ||
  !key ||
  !encodedRecord ||
  !readyPath ||
  !releasePath
) {
  throw new Error("Expected profile, store, key, record, ready path, and release path arguments.");
}

const record = JSON.parse(encodedRecord) as Record<string, unknown>;

await withProfileLock(profile, async () => {
  const current = await readProfileStore<Record<string, unknown>>(profile, store);
  await signalProfileLockProtocol(readyPath);
  await waitForProfileLockProtocol(
    releasePath,
    "the parent to release the profile lock",
    PROFILE_LOCK_HOLDER_RELEASE_TIMEOUT_MS,
  );

  const next = current.records.filter((candidate) => recordKey(store, candidate) !== key);
  next.push(record);
  await writeJsonAtomic(profileStorePath(profile, store), next);
  await writeJsonAtomic(profileStoreMetadataPath(profile, store), { formatVersion: 1 });
});

function recordKey(
  store: "auth-requests" | "additional-delegations",
  candidate: Record<string, unknown>,
): string | undefined {
  if (store === "auth-requests") {
    return typeof candidate.requestId === "string" ? candidate.requestId : undefined;
  }

  const delegation = candidate.delegation;
  if (delegation === null || typeof delegation !== "object") return undefined;
  const cid = (delegation as { cid?: unknown }).cid;
  return typeof cid === "string" ? cid : undefined;
}
