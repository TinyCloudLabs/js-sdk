import { upsertProfileRecord } from "../src/state.js";

const [profile, key, encodedRecord] = process.argv.slice(2);
if (!profile || !key || !encodedRecord) {
  throw new Error("Expected profile, record key, and JSON record arguments.");
}

const record = JSON.parse(encodedRecord) as { requestId?: unknown };
await upsertProfileRecord(
  profile,
  "auth-requests",
  key,
  record,
  (candidate) => typeof candidate.requestId === "string" ? candidate.requestId : undefined,
);
