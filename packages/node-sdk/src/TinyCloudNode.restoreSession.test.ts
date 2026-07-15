import { describe, expect, test } from "bun:test";

import { principalDidEquals } from "@tinycloud/sdk-core";

import { activateValidatedRuntimeDelegation } from "./delegation";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { createHermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";

const RESTORE_HOST = "http://127.0.0.1:1";

function restorableData(jwk: object, verificationMethod: string) {
  return {
    delegationHeader: { Authorization: "Bearer restore-test" },
    delegationCid: "bafy-restore-test",
    spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
    jwk,
    verificationMethod,
  };
}

describe("TinyCloudNode.restoreSession session-key lifecycle", () => {
  test("rejects malformed, public-only, and mismatched persisted keys without replacing the active signer", async () => {
    const wasm = new NodeWasmBindings();
    const sourceManager = wasm.createSessionManager();
    const sourceJwk = JSON.parse(sourceManager.jwk("default")!);
    const sourceDid = sourceManager.getDID("default");
    const unrelatedManager = wasm.createSessionManager();
    const unrelatedDid = unrelatedManager.getDID("default");
    const node = new TinyCloudNode({ host: RESTORE_HOST, wasmBindings: wasm });
    const initialDid = node.sessionDid;

    const publicOnly = { ...sourceJwk };
    delete publicOnly.d;
    await expect(
      node.restoreSession(restorableData(publicOnly, sourceDid)),
    ).rejects.toThrow(/invalid private Ed25519 session key/);
    expect(node.sessionDid).toBe(initialDid);

    await expect(
      node.restoreSession(restorableData({ kty: "OKP", crv: "Ed25519" }, sourceDid)),
    ).rejects.toThrow(/invalid private Ed25519 session key/);
    expect(node.sessionDid).toBe(initialDid);

    await expect(
      node.restoreSession(restorableData(sourceJwk, unrelatedDid)),
    ).rejects.toThrow(/verification method does not match/);
    expect(node.sessionDid).toBe(initialDid);

    await expect(
      node.restoreSession(restorableData(sourceJwk, "not-a-did")),
    ).rejects.toThrow(/verification method does not match/);
    expect(node.sessionDid).toBe(initialDid);
  });

  test("round-trips a real WASM session JWK into a fresh node and activates a narrow signed grant", async () => {
    const fixture = await createHermeticEncryptedNode();
    try {
      const restored = fixture.createRestoredDelegate();
      const defaultDid = restored.sessionDid;

      await restored.restoreSession(fixture.restorableSession);

      expect(restored.sessionDid).not.toBe(defaultDid);
      expect(principalDidEquals(restored.sessionDid, fixture.restorableSession.verificationMethod)).toBe(
        true,
      );

      const delegation = await fixture.mintDelegation();
      const activated = await activateValidatedRuntimeDelegation(restored, delegation, {
        host: fixture.host,
      });

      expect(activated.audience).toBe(restored.sessionDid.split("#", 1)[0]);
      expect(restored.getRuntimePermissionDelegations()).toHaveLength(1);
    } finally {
      fixture.stop();
    }
  });
});
