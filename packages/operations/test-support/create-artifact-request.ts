import { createOrReusePermissionRequest } from "../src/artifacts.js";

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
