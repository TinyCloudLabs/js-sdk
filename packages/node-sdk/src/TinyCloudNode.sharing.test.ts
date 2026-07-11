import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ISessionManager, IWasmBindings } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

const originalFetch = globalThis.fetch;

function makeFakeSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
}

function makeWasmBindings(): IWasmBindings {
  return {
    createSessionManager: makeFakeSessionManager,
    prepareSession: mock((config: unknown) => ({
      ...(config as object),
      siwe: "share-siwe",
    })),
    completeSessionSetup: mock((config: unknown) => ({
      ...(config as object),
      delegationCid: "share-delegation-cid",
      delegationHeader: { Authorization: "c2hhcmUtYXV0aC1oZWFkZXI" },
    })),
    ensureEip55: (address: string) => address,
  } as unknown as IWasmBindings;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("TinyCloudNode sharing", () => {
  test("root sharing delegates SQL actions under the SQL service", async () => {
    const wasmBindings = makeWasmBindings();
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ cid: "commit-event-cid", activated: ["share-delegation-cid"], skipped: [] }),
      text: async () => "",
    })) as unknown as typeof fetch;

    const node = new TinyCloudNode({
      host: "https://node.example",
      signer: {
        signMessage: mock(async () => "signature"),
      } as any,
      wasmBindings,
    });
    (node as any)._restoredTcSession = {
      address: "0xD559CCd9EB87c530A9a349262669386dE93cf412",
      chainId: 1,
      spaceId: "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:applications",
    };

    const delegation = await (node as any).createRootDelegationForSharing({
      shareKeyDID: "did:key:z6MkShare",
      spaceId: "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:applications",
      path: "xyz.tinycloud.tinychat/threads",
      actions: ["tinycloud.sql/read"],
      requestedExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    expect(delegation?.authHeader).toBe("c2hhcmUtYXV0aC1oZWFkZXI");
    expect((wasmBindings.prepareSession as any).mock.calls[0][0].abilities).toEqual({
      sql: {
        "xyz.tinycloud.tinychat/threads": ["tinycloud.sql/read"],
      },
    });
  });

  test("public owner delegation is wallet-rooted, caller-targeted, expiring, and returns raw receipt identities", async () => {
    const wasmBindings = makeWasmBindings();
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        cid: "commit-event-cid",
        activated: ["tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:applications"],
        skipped: [],
      }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const node = new TinyCloudNode({
      host: "https://node.example",
      signer: { signMessage: mock(async () => "signature") } as any,
      wasmBindings,
    });
    (node as any)._restoredTcSession = {
      address: "0xD559CCd9EB87c530A9a349262669386dE93cf412",
      chainId: 1,
      spaceId: "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:applications",
    };
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const receipt = await node.createOwnerDelegation({
      delegateDid: "did:key:z6MkExternalCaller",
      spaceId: "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:applications",
      path: "xyz.tinycloud.listen/conversations",
      actions: ["tinycloud.sql/read"],
      expiresAt,
    });

    const prepared = (wasmBindings.prepareSession as any).mock.calls[0][0];
    expect(prepared.delegateUri).toBe("did:key:z6MkExternalCaller");
    expect(prepared.expirationTime).toBe(expiresAt.toISOString());
    expect(prepared.parents).toBeUndefined();
    expect(receipt.delegation.allowSubDelegation).toBe(true);
    expect(receipt.delegationCid).toBe("share-delegation-cid");
    expect(receipt.nodeReceipt.commitEventCid).toBe("commit-event-cid");
    expect(new TextDecoder().decode(receipt.signedDagCbor)).toBe("share-auth-header");
  });
});
