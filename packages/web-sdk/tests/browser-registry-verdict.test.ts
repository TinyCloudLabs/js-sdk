import "./support/browserGlobalsShim";
import "../../operations/test-support/test-bootstrap.mjs";
import { expect, spyOn, test } from "bun:test";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { TinyCloudWeb } from "../src/modules/tcw";
import { createHermeticEncryptedNode } from "../../node-sdk/src/test-support/hermetic-encrypted-node";

test("browser reads reuse a confirmed absent registry verdict for 60 seconds without error logging", async () => {
  const fixture = await createHermeticEncryptedNode();
  fixture.allowInvocationProof(fixture.ownerRestorableSession.delegationCid);
  const realFetch = globalThis.fetch;
  let requests = 0;
  let registryStatus = 404;
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "registry.test") {
      requests++;
      return Promise.resolve(new Response(registryStatus === 404 ? REGISTRY_NOT_FOUND_BODY : "unavailable", { status: registryStatus }));
    }
    if (url.hostname !== "127.0.0.1") throw new Error("Registry test refused non-loopback fetch");
    return realFetch(input, init);
  }, { preconnect: realFetch.preconnect });
  try {
    const web = await TinyCloudWeb.create({ ui: false, autoBootstrapAccount: false,
      tinycloudHosts: [fixture.host], tinycloudRegistryUrl: "https://registry.test", autoDiscoverLocalNode: false });
    const node = (web as unknown as { _node: { restoreSession(session: unknown): Promise<void> } })._node;
    await node.restoreSession(fixture.ownerRestorableSession);
    fixture.configureKv(fixture.ownerRestorableSession.spaceId, { "vault/secrets/HERMETIC_DELEGATION_CANARY": { value: "kept" } });
    for (let tick = 0; tick < 12; tick++) {
      now = tick * 5_000;
      const reads = await Promise.all([web.kv.get("vault/secrets/HERMETIC_DELEGATION_CANARY"), web.kv.get("vault/secrets/HERMETIC_DELEGATION_CANARY")]);
      expect(reads.map(result => result.ok ? result.data.data : { code: result.error.code })).toEqual([{ value: "kept" }, { value: "kept" }]);
      expect(requests).toBe(2);
    }
    now = 60_000;
    expect((await web.kv.get("vault/secrets/HERMETIC_DELEGATION_CANARY")).ok).toBe(true);
    expect(requests).toBe(4);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    registryStatus = 503;
    now = 120_000;
    expect((await web.kv.get("vault/secrets/HERMETIC_DELEGATION_CANARY")).ok).toBe(false);
    const afterFailure = requests;
    expect(afterFailure).toBeGreaterThan(4);
    expect((await web.kv.get("vault/secrets/HERMETIC_DELEGATION_CANARY")).ok).toBe(false);
    expect(requests).toBeGreaterThan(afterFailure);
  } finally {
    globalThis.fetch = realFetch;
    clock.mockRestore(); errors.mockRestore(); warnings.mockRestore();
    fixture.stop();
  }
});
