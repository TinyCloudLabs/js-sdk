import { createOrReusePermissionRequest } from "../src/artifacts.js";
import { PROFILE_LOCK_HELPER_DEADLINE_MS } from "../src/test-support/profile-lock-protocol.js";
import { exitWithParent } from "../src/test-support/parent-watch.mjs";

exitWithParent(PROFILE_LOCK_HELPER_DEADLINE_MS);

const [profile, requestId, isoNow] = process.argv.slice(2);
if (!profile || !requestId || !isoNow) {
  throw new Error("Expected profile, request ID, and clock timestamp.");
}

await createOrReusePermissionRequest({
  profile,
  posture: "delegate-session",
  operatorType: "agent",
  host: "https://node.tinycloud.test",
  sessionDid: "did:key:session",
  missing: [{
    service: "tinycloud.kv",
    space: "secrets",
    path: "vault/secrets/WRITER_KEY",
    actions: ["tinycloud.kv/get"],
  }],
  granted: [],
  now: () => new Date(isoNow),
  createRequestId: () => requestId,
});
