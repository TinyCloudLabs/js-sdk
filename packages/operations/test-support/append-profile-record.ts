// Appends one auth-request record under the profile lock of the release
// TC_TEST_LOCK_PROTOCOL names (see lock-protocol.ts): through
// upsertProfileRecord for this release, as an older release's store writer
// would otherwise.
import {
  profileStoreMetadataPath,
  profileStorePath,
  readProfileStore,
  upsertProfileRecord,
  writeJsonAtomic,
} from "../src/state.js";
import { withFixtureLock } from "./lock-protocol.js";

const [profile, key, encodedRecord, timeoutMs] = process.argv.slice(2);
if (!profile || !key || !encodedRecord) {
  throw new Error("Expected profile, record key, and JSON record arguments.");
}

const record = JSON.parse(encodedRecord) as { requestId?: unknown };
const requestId = (candidate: { requestId?: unknown }) => typeof candidate.requestId === "string" ? candidate.requestId : undefined;
const options = timeoutMs === undefined ? {} : { timeoutMs: Number(timeoutMs) };
if ((process.env.TC_TEST_LOCK_PROTOCOL ?? "current") === "current") {
  await upsertProfileRecord(profile, "auth-requests", key, record, requestId, options);
} else {
  await withFixtureLock(profile, async () => {
    const current = (await readProfileStore<{ requestId?: unknown }>(profile, "auth-requests")).records;
    await writeJsonAtomic(profileStorePath(profile, "auth-requests"), [...current.filter((candidate) => requestId(candidate) !== key), record]);
    await writeJsonAtomic(profileStoreMetadataPath(profile, "auth-requests"), { formatVersion: 1 });
  }, options);
}
