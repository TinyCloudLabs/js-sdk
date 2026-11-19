// TC-2268: a sign-out that outlives a newer sign-in must clear only the session it ended, never the saved copy
// of a newer session for the same address.

import { describe, expect, test } from "bun:test";

import { NodeWasmBindings } from "./NodeWasmBindings";
import { TinyCloudNode } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";

async function restoredNode() {
  const proof = await signedRestorableSession({ abilities: { kv: { "": ["tinycloud.kv/get"] } } });
  const storage = new MemorySessionStorage();
  const node = new TinyCloudNode({
    host: "https://sign-out-own.test",
    signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
    wasmBindings: new NodeWasmBindings(),
    sessionStorage: storage,
    autoBootstrapAccount: false,
  });
  await node.restoreSession({ ...proof, tinycloudHosts: ["https://sign-out-own.test"] });
  const persisted = {
    address: proof.address,
    chainId: proof.chainId,
    sessionKey: JSON.stringify(proof.jwk),
    siwe: proof.siwe,
    signature: proof.signature,
    tinycloudSession: {
      delegationHeader: proof.delegationHeader,
      delegationCid: proof.delegationCid,
      spaceId: proof.spaceId,
      verificationMethod: proof.verificationMethod,
    },
    expiresAt: proof.expiresAt,
    createdAt: new Date().toISOString(),
    version: "1.0",
  };
  return { node, storage, persisted, address: proof.address };
}

describe("signOut clears only its own persisted session", () => {
  test("a late clear leaves a newer session saved for the same address", async () => {
    const { node, storage, persisted, address } = await restoredNode();
    await storage.save(address, persisted);
    const registry = Promise.withResolvers<void>();
    // The test holds the private registry queue open, as a hung node call would.
    const internals = node as unknown as { accountRegistryTail: Promise<void> };
    internals.accountRegistryTail = registry.promise;

    const signingOut = node.signOut();
    const newer = { ...persisted, signature: `${persisted.signature}-newer` };
    await storage.save(address, newer);
    registry.resolve();
    await signingOut;

    expect((await storage.load(address))?.signature).toBe(newer.signature);
  });

  test("the session being signed out is cleared when it is still the stored one", async () => {
    const { node, storage, persisted, address } = await restoredNode();
    await storage.save(address, persisted);

    await node.signOut();

    expect(await storage.load(address)).toBeNull();
  });
});
