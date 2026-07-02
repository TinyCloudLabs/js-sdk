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
      delegationHeader: { Authorization: "share-auth-header" },
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
      json: async () => ({ activated: ["share-delegation-cid"] }),
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
      requestedExpiry: new Date("2026-07-09T15:17:04.758Z"),
    });

    expect(delegation?.authHeader).toBe("share-auth-header");
    expect((wasmBindings.prepareSession as any).mock.calls[0][0].abilities).toEqual({
      sql: {
        "xyz.tinycloud.tinychat/threads": ["tinycloud.sql/read"],
      },
    });
  });
});
