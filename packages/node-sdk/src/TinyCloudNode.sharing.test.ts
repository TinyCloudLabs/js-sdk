import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  CapabilityKeyRegistry,
  CaveatedDelegationUnsupportedError,
  type EncodedShareData,
  type ISessionManager,
  type IWasmBindings,
} from "@tinycloud/sdk-core";
import { Wallet } from "ethers";

import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { deserializeDelegation, serializeDelegation } from "./delegation";

const originalFetch = globalThis.fetch;
const OWNER = "0xD559CCd9EB87c530A9a349262669386dE93cf412";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:applications`;

function makeFakeSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
    replaceSessionKey: (_jwk: object, keyId: string) => keyId,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test", d: "test" }),
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
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
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

  test("rejects every meaningful parent caveat branch before sub-delegation signing", async () => {
    const wasmBindings = makeWasmBindings();
    const signer = { signMessage: mock(async () => "signature") };
    const node = new TinyCloudNode({
      host: "https://node.example",
      signer: signer as any,
      wasmBindings,
    });
    (node as any)._address = OWNER;
    (node as any)._chainId = 1;
    const parent = {
      cid: "parent-cid",
      delegationHeader: { Authorization: "parent.header.signature" },
      spaceId: SPACE,
      path: "shared",
      actions: ["tinycloud.kv/get"],
      expiry: new Date(Date.now() + 60 * 60_000),
      delegateDID: "did:key:z6MkReceiver",
      ownerAddress: OWNER,
      chainId: 1,
    };
    const cases = [
      { caveats: [{ tenant: "alpha" }] },
      { caveats: [{}, { tenant: "alpha" }] },
      {
        resources: [{
          service: "kv",
          space: SPACE,
          path: "shared",
          actions: ["tinycloud.kv/get"],
          caveats: [{ tenant: "alpha" }],
        }],
      },
    ];

    for (const parentCaveats of cases) {
      const result = node.createSubDelegation(
        { ...parent, ...parentCaveats },
        {
          path: "shared",
          actions: ["tinycloud.kv/get"],
          delegateDID: "did:key:z6MkChild",
        },
      );
      await expect(result).rejects.toBeInstanceOf(CaveatedDelegationUnsupportedError);
      await expect(result).rejects.toMatchObject({
        code: "CAVEATED_DELEGATION_UNSUPPORTED",
      });
    }

    expect(wasmBindings.prepareSession).not.toHaveBeenCalled();
    expect(signer.signMessage).not.toHaveBeenCalled();
  });

  test("does not activate a root share after its owner-signer graph retires", async () => {
    const wasmBindings = makeWasmBindings();
    let releaseSignature!: () => void;
    let markSigningStarted!: () => void;
    const signingStarted = new Promise<void>((resolve) => {
      markSigningStarted = resolve;
    });
    const signer = {
      signMessage: mock(async () => {
        markSigningStarted();
        await new Promise<void>((resolve) => {
          releaseSignature = resolve;
        });
        return "signature";
      }),
    };
    const node = new TinyCloudNode({
      host: "https://node.example",
      signer: signer as any,
      wasmBindings,
    });
    const session = {
      address: OWNER,
      chainId: 1,
      sessionKey: "default",
      spaceId: SPACE,
      delegationCid: "parent-cid",
      delegationHeader: { Authorization: "parent.header.signature" },
      verificationMethod: "did:key:default",
      jwk: { kty: "OKP", crv: "Ed25519", x: "test", d: "test" },
      siwe: "signed session",
      signature: "signature",
    };
    (node as any).auth = { tinyCloudSession: session };
    (node as any)._address = OWNER;
    (node as any)._chainId = 1;
    (node as any).initializeV2Services({
      delegationHeader: session.delegationHeader,
      delegationCid: session.delegationCid,
      spaceId: session.spaceId,
      verificationMethod: session.verificationMethod,
      jwk: session.jwk,
    });
    (node.sharing as any).registry = new CapabilityKeyRegistry();
    globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as typeof fetch;

    const result = node.sharing.generate({
      path: "outside-the-session-recap",
      actions: ["tinycloud.kv/get"],
    });
    await signingStarted;
    (node as any)._serviceGraph.retire();
    releaseSignature();

    await expect(result).resolves.toMatchObject({ ok: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("public owner delegation does not activate after its captured graph retires during wallet signing", async () => {
    const wasmBindings = makeWasmBindings();
    let releaseSignature!: () => void;
    let markSigningStarted!: () => void;
    const signingStarted = new Promise<void>((resolve) => {
      markSigningStarted = resolve;
    });
    const signer = {
      signMessage: mock(async () => {
        markSigningStarted();
        await new Promise<void>((resolve) => {
          releaseSignature = resolve;
        });
        return "signature";
      }),
    };
    globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as typeof fetch;
    const node = new TinyCloudNode({
      host: "https://node.example",
      signer: signer as any,
      wasmBindings,
    });
    (node as any)._restoredTcSession = {
      address: OWNER,
      chainId: 1,
      spaceId: SPACE,
    };

    const result = node.createOwnerDelegation({
      delegateDid: "did:key:z6MkExternalCaller",
      spaceId: SPACE,
      path: "xyz.tinycloud.listen/conversations",
      actions: ["tinycloud.sql/read"],
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    await signingStarted;
    (node as any)._serviceGraph.retire();
    releaseSignature();

    await expect(result).rejects.toThrow("Service graph has been retired");
    expect(signer.signMessage).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
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
    expect(receiver.computeDelegationCid(token)).toBe(delegated.data.delegation.cid);
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

  test("real WASM signs the requested revocation CID rather than the session parent CID", async () => {
    const wasmBindings = new NodeWasmBindings();
    const owner = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const manager = wasmBindings.createSessionManager();
    const sessionKeyId = manager.createSessionKey("revocation-session");
    const sessionKeyDid = manager.getDID(sessionKeyId).split("#")[0];
    const spaceId = `tinycloud:pkh:eip155:1:${owner.address}:applications`;
    const prepared = wasmBindings.prepareSession({
      abilities: { delegation: { "": ["tinycloud.delegation/revoke"] } },
      address: wasmBindings.ensureEip55(owner.address),
      chainId: 1,
      domain: "feed.localhost",
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      spaceId,
      delegateUri: sessionKeyDid,
    });
    const session = wasmBindings.completeSessionSetup({
      ...prepared,
      signature: await owner.signMessage(prepared.siwe),
    });
    const childCid = "bafy-child-distinct-from-parent";

    const headers = wasmBindings.invokeAny!(session, [{
      resource: `urn:cid:${childCid}`,
      service: "delegation",
      path: "",
      action: "tinycloud.delegation/revoke",
    }]);
    const token = headers.Authorization;
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as {
      att: Record<string, Record<string, unknown>>;
      prf: string[];
    };

    expect(session.delegationCid).not.toBe(childCid);
    expect(payload.att[`urn:cid:${childCid}`]).toEqual({
      "tinycloud.delegation/revoke": [{}],
    });
    expect(payload.prf).toEqual([session.delegationCid]);
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

  test.each([
    [403, "activation denied"],
    [503, "activation unavailable"],
  ])("public owner delegation fails closed when /delegate returns %i", async (status, error) => {
    const wasmBindings = makeWasmBindings();
    globalThis.fetch = mock(async () => ({
      ok: false,
      status,
      statusText: error,
      json: async () => ({}),
      text: async () => error,
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

    await expect(node.createOwnerDelegation({
      delegateDid: "did:key:z6MkExternalCaller",
      spaceId: "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:applications",
      path: "xyz.tinycloud.listen/conversations",
      actions: ["tinycloud.sql/read"],
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    })).rejects.toThrow(`Owner delegation import failed: ${status} ${error}`);
  });

  test("public owner delegation rejects invalid authority inputs before signing or network access", async () => {
    const signMessage = mock(async () => "signature");
    const node = new TinyCloudNode({
      host: "https://node.example",
      signer: { signMessage } as any,
      wasmBindings: makeWasmBindings(),
    });
    (node as any)._restoredTcSession = {
      address: "0xD559CCd9EB87c530A9a349262669386dE93cf412",
      chainId: 1,
      spaceId: "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:applications",
    };
    const valid = {
      delegateDid: "did:key:z6MkExternalCaller",
      spaceId: "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:applications",
      path: "xyz.tinycloud.listen/conversations",
      actions: ["tinycloud.sql/read"],
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    };

    for (const [overrides, message] of [
      [{ delegateDid: "did:pkh:eip155:1:0x1234" }, "external did:key audience"],
      [{ path: "" }, "bounded capabilities"],
      [{ actions: [] }, "bounded capabilities"],
      [{ actions: ["tinycloud.unknown/read"] }, "capabilities are unsupported"],
      [{ expiresAt: new Date(Date.now() - 1_000) }, "expiry must be explicit"],
      [{ expiresAt: new Date(Date.now() + 11 * 365 * 24 * 60 * 60 * 1000) }, "within EXPIRY.MAX_MS"],
    ] as const) {
      await expect(node.createOwnerDelegation({ ...valid, ...overrides })).rejects.toThrow(message);
    }
    expect(signMessage).not.toHaveBeenCalled();
  });

  test("public owner delegation requires both wallet signer and owner session", async () => {
    const params = {
      delegateDid: "did:key:z6MkExternalCaller",
      spaceId: "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:applications",
      path: "xyz.tinycloud.listen/conversations",
      actions: ["tinycloud.sql/read"],
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    };
    const withoutSigner = new TinyCloudNode({
      host: "https://node.example",
      wasmBindings: makeWasmBindings(),
    });
    (withoutSigner as any)._restoredTcSession = {
      address: "0xD559CCd9EB87c530A9a349262669386dE93cf412",
      chainId: 1,
      spaceId: params.spaceId,
    };
    await expect(withoutSigner.createOwnerDelegation(params)).rejects.toThrow("Owner wallet signer is required");

    const withoutSession = new TinyCloudNode({
      host: "https://node.example",
      signer: { signMessage: mock(async () => "signature") } as any,
      wasmBindings: makeWasmBindings(),
    });
    await expect(withoutSession.createOwnerDelegation(params)).rejects.toThrow("Owner session is required");
  });
});
