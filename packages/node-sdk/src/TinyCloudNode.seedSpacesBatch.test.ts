/**
 * TC-373: the account-bootstrap "seed-spaces" step must batch all 5 spaces
 * into ONE `account.spaces.registerBatch()` call instead of looping 5 times
 * over `account.spaces.register()`.
 *
 * This exercises `runAccountBootstrap` directly with a `steps` array
 * containing only a `seed-spaces` step, isolating the seeding branch from
 * the session/host/activate machinery (which no-op when their step kinds
 * are absent from the array).
 */
import { describe, expect, mock, test } from "bun:test";

import type { IWasmBindings, ISessionManager } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

function makeSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
}

function makeWasmBindings(): IWasmBindings {
  return {
    invoke: async () => undefined,
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    createSessionManager: makeSessionManager,
  } as unknown as IWasmBindings;
}

function makeNode() {
  const signer = {
    getAddress: async () => ADDRESS,
    getChainId: async () => 1,
    signMessage: mock(async () => "0xsig"),
  };
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    signer: signer as any,
    wasmBindings: makeWasmBindings(),
  });
  (node as any)._address = ADDRESS;
  (node as any)._chainId = 1;
  // runAccountBootstrap only needs a truthy `auth` with the two properties
  // it reads (tinyCloudSession, capabilityRequest) — no session/host steps
  // are present in this test's `steps` array, so nothing else is read.
  (node as any).auth = { tinyCloudSession: undefined, capabilityRequest: undefined };
  return node;
}

const SPACE_NAMES = ["default", "applications", "account", "secrets", "public"] as const;

function seedSpacesStep() {
  return {
    id: "account:seed-spaces",
    kind: "seed-spaces" as const,
    spaces: SPACE_NAMES.map((name) => ({
      name,
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:${name}`,
    })),
  };
}

describe("seed-spaces bootstrap step batches all 5 spaces in ONE call (TC-373)", () => {
  test("calls account.spaces.registerBatch once with all 5 spaces, never register()", async () => {
    const node = makeNode();

    const registerBatch = mock(async (spaces: any[]) => ({
      ok: true,
      data: spaces.map((s) => ({ ...s })),
    }));
    const register = mock(async () => ({ ok: true, data: {} }));
    (node as any)._account = { spaces: { registerBatch, register } };

    await (node as any).runAccountBootstrap([seedSpacesStep()]);

    expect(registerBatch).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();

    const [passedSpaces] = registerBatch.mock.calls[0] as [Array<{ spaceId: string; ownerDid: string }>];
    expect(passedSpaces).toHaveLength(5);
    expect(passedSpaces.map((s) => s.spaceId).sort()).toEqual(
      SPACE_NAMES.map((name) => `tinycloud:pkh:eip155:1:${ADDRESS}:${name}`).sort(),
    );
    // Every entry carries the signed-in owner DID.
    for (const space of passedSpaces) {
      expect(space.ownerDid).toBe((node as any).did);
    }
  });

  test("throws with all space ids named when registerBatch fails", async () => {
    const node = makeNode();

    const registerBatch = mock(async () => ({
      ok: false,
      error: { code: "KV_WRITE_FAILED", message: "boom", service: "kv" },
    }));
    (node as any)._account = { spaces: { registerBatch, register: mock(async () => ({ ok: true, data: {} })) } };

    await expect((node as any).runAccountBootstrap([seedSpacesStep()])).rejects.toThrow(
      "Failed to seed account spaces: boom",
    );
  });
});
