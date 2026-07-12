import { afterEach, describe, expect, mock, test } from "bun:test";

import type { EncodedShareData, ISessionManager, IWasmBindings } from "@tinycloud/sdk-core";
import { Wallet } from "ethers";

import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { deserializeDelegation, serializeDelegation } from "./delegation";

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

  test("real WASM attenuates a received share and the child survives transport/useDelegation", async () => {
    const wasmBindings = new NodeWasmBindings();
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ activated: ["child"] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

    const host = "https://node.tinycloud.xyz";
    const receiver = new TinyCloudNode({ host, wasmBindings });
    const owner = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const manager = wasmBindings.createSessionManager();
    const shareKeyId = manager.createSessionKey("share-parent");
    const shareKeyDid = manager.getDID(shareKeyId).split("#")[0];
    const shareKeyJwk = JSON.parse(manager.jwk(shareKeyId)!) as EncodedShareData["key"];
    const spaceId = `tinycloud:pkh:eip155:1:${owner.address}:applications`;
    const parentExpiry = new Date(Date.now() + 60 * 60 * 1000);
    const path = "xyz.tinycloud.artifacts/artifacts/listen-import/";

    const prepared = wasmBindings.prepareSession({
      abilities: { kv: { [path]: ["tinycloud.kv/get", "tinycloud.kv/list"] } },
      address: wasmBindings.ensureEip55(owner.address),
      chainId: 1,
      domain: "feed.localhost",
      issuedAt: new Date().toISOString(),
      expirationTime: parentExpiry.toISOString(),
      spaceId,
      delegateUri: shareKeyDid,
    });
    const parentSession = wasmBindings.completeSessionSetup({
      ...prepared,
      signature: await owner.signMessage(prepared.siwe),
    });
    const link = receiver.sharing.encodeLink({
      version: 1,
      host,
      spaceId,
      path,
      keyDid: shareKeyDid,
      key: shareKeyJwk,
      delegation: {
        cid: parentSession.delegationCid,
        delegateDID: shareKeyDid,
        delegatorDID: `did:pkh:eip155:1:${owner.address}`,
        spaceId,
        path,
        actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
        expiry: parentExpiry,
        isRevoked: false,
        allowSubDelegation: true,
        authHeader: parentSession.delegationHeader.Authorization,
      },
    });

    const delegated = await receiver.sharing.delegateReceivedShare(link, {
      delegateDID: receiver.did,
      expectedHost: host,
      actions: ["tinycloud.kv/get"],
      expiry: new Date(parentExpiry.getTime() - 1000),
    });
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) return;

    const token = delegated.data.delegation.delegationHeader.Authorization;
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as {
      aud: string;
      prf: string[];
    };
    expect(payload.aud).toBe(receiver.did.split("#")[0]);
    expect(payload.prf).toEqual([parentSession.delegationCid]);

    const transported = serializeDelegation(delegated.data.delegation);
    expect(transported).not.toContain(shareKeyJwk.d!);
    expect(transported).not.toContain(parentSession.delegationHeader.Authorization);
    const restored = deserializeDelegation(transported);
    const access = await receiver.useDelegation(restored);
    expect(access.delegation.cid).toBe(delegated.data.delegation.cid);
    expect(access.path).toBe(path);
    expect(access.restorable.verificationMethod.split("#")[0]).toBe(receiver.did.split("#")[0]);
  });
});
