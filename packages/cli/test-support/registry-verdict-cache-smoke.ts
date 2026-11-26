import assert from "node:assert/strict";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { createSDKInstance } from "../src/lib/sdk.js";
import { invokeOperation } from "../src/lib/operations.js";
import { wrapError } from "../src/output/errors.js";
import { writeOwnerOpenKeyProfile } from "../src/test-support/secrets-wait-harness.js";

import { createHermeticEncryptedNode } from "../../node-sdk/src/test-support/hermetic-encrypted-node.ts";
const mode = process.argv[2];
const fixture = await createHermeticEncryptedNode({ secretPayloadValue: "TC-4373-fixture-value" });
let v2 = 0, v1 = 0, midRunOutage = false;
const registry = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  const ownerKey = path.startsWith("/v2/") ? fixture.ownerDid.split(":").at(-1) : fixture.ownerDid;
  if (path.endsWith(encodeURIComponent(ownerKey))) {
    if (path.startsWith("/v2/")) v2++;
    else v1++;
    if (midRunOutage || mode === "503") return new Response("fixture outage", { status: 503 });
    if (mode === "timeout" && path.startsWith("/v1/") && v1 === 1) return new Promise<Response>(() => {});
  }
  return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
} });
process.env.TC_REGISTRY_URL = registry.url.origin;
const rawFetch = globalThis.fetch;
const allowed = new Set([fixture.host, registry.url.origin]);
globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert(allowed.has(url.origin), "Non-fixture origin refused");
  return rawFetch(input, init);
}, { preconnect: rawFetch.preconnect });
try {
  fixture.provisionSecret();
  fixture.allowInvocationProof(fixture.ownerRestorableSession.delegationCid);
  await writeOwnerOpenKeyProfile(process.env.TC_HOME!, fixture, "registry-smoke");
  const ctx = { profile: "registry-smoke", host: fixture.host, tinycloudRegistryUrl: registry.url.origin,
    verbose: false, noCache: false, quiet: true, replication: false, replicationDebug: false };
  // The same SDK acquisition used by secrets migrate, followed by the canonical
  // operations acquisition used by secrets get. Both must join the process cache.
  const node = await createSDKInstance(ctx);
  const path = "vault/secrets/HERMETIC_DELEGATION_CANARY";
  const first = await node.kvForSpace(fixture.ownerRestorableSession.spaceId).get(path);
  if (mode === "503") {
    assert.equal(first.ok, false);
    if (first.ok) throw new Error("Expected refusal");
    const failure = wrapError(first.error);
    console.log(JSON.stringify({ code: failure.code, message: failure.message, v2, v1,
      reads: fixture.invocations().filter((entry: { action: string }) => entry.action === "tinycloud.kv/get").length }));
  } else {
    assert.equal(first.ok, true, JSON.stringify(first));
    for (let record = 1; record < 140; record++) {
      if (record === 70) midRunOutage = true;
      assert.equal((await node.kvForSpace(fixture.ownerRestorableSession.spaceId).get(path)).ok, true);
    }
    const result = await invokeOperation("tinycloud.secrets.get", 1,
      { profile: ctx.profile, host: ctx.host, allowOwnerProfile: true }, { name: "HERMETIC_DELEGATION_CANARY" });
    assert.equal(result.status, "ok", JSON.stringify(result));
    if (result.status === "ok") assert.deepEqual(result.output, { value: "TC-4373-fixture-value" });
    console.log(JSON.stringify({ completed: 140, canonical: result.status, v2, v1 }));
  }
} finally {
  globalThis.fetch = rawFetch;
  registry.stop(true);
  fixture.stop();
}
