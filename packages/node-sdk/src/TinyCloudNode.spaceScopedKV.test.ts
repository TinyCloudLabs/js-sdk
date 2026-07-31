/**
 * Regression test for TC-373 corrected-design point 1: `createSpaceScopedKVService`
 * previously omitted `invokeAny` when constructing the space-scoped
 * `ServiceContext`, so any `space.kv.batch*` call synchronously rejected
 * with INVALID_INPUT ("KV batchPut requires SDK runtime support for
 * multi-resource invocations") before ever signing or fetching. This made
 * batching a no-op for every space-scoped KV surface, including the account
 * bootstrap seeding path (`node.account.spaces.get(accountSpaceId).kv`).
 *
 * This drives the fix directly at the public surface named in the TC-373
 * spec: `node.spaces.get(accountSpaceId).kv.batchPut()` must actually reach
 * `invokeAny` and the network, not reject before either.
 */
import { describe, expect, mock, test } from "bun:test";

import type { ISessionManager, IWasmBindings, ServiceSession } from "@tinycloud/sdk-core";
import { ServiceContext, SpaceService } from "@tinycloud/sdk-core";

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

describe("createSpaceScopedKVService threads invokeAny (TC-373 point 1)", () => {
  test("node.spaces.get(accountSpaceId).kv.batchPut() reaches invokeAny and the network, not INVALID_INPUT", async () => {
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

    // Simulate post-signIn identity state without running the network dance.
    (node as any)._address = ADDRESS;
    (node as any)._chainId = 1;
    const accountSpaceId: string = (node as any).accountSpaceId;
    expect(accountSpaceId).toContain(":account");

    const session: ServiceSession = {
      delegationHeader: { Authorization: "Bearer primary" },
      delegationCid: "bafyprimary",
      spaceId: accountSpaceId,
      verificationMethod: "did:key:z6MkTestSession",
      jwk: { kty: "OKP" },
    };

    const invokeAnySpy = mock((_session: ServiceSession, _entries: unknown[]) => ({
      Authorization: "Bearer batch",
    }));
    const fetchSpy = mock(
      async () =>
        new Response(JSON.stringify({ written: ["a", "b"], count: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    // Build the primary ServiceContext exactly as initializeServices() does:
    // both invoke AND invokeAny wired. This is the object
    // createSpaceScopedKVService reads `invokeAny` from.
    const ctx = new ServiceContext({
      invoke: () => ({ Authorization: "Bearer single" }),
      invokeAny: invokeAnySpy as any,
      fetch: fetchSpy as any,
      hosts: ["https://tinycloud.test"],
    });
    ctx.setSession(session);
    (node as any)._serviceContext = ctx;

    // Wire SpaceService exactly like production's initializeServices() does:
    // createKVService delegates to the private createSpaceScopedKVService.
    (node as any)._spaceService = new SpaceService({
      hosts: ["https://tinycloud.test"],
      session,
      invoke: ctx.invoke,
      fetch: ctx.fetch,
      userDid: (node as any).did,
      createKVService: (spaceId: string) => (node as any).createSpaceScopedKVService(spaceId),
    });

    const result = await node.spaces.get(accountSpaceId).kv.batchPut([
      { key: "a", value: "one" },
      { key: "b", value: "two" },
    ]);

    // FAILS before the fix: the space-scoped ServiceContext had no
    // invokeAny, so batchPut rejected synchronously with INVALID_INPUT and
    // neither invokeAnySpy nor fetchSpy were ever reached.
    expect(result.ok).toBe(true);
    expect(invokeAnySpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // And the invocation actually named both resources (one invocation
    // proving both capabilities, not two separate ones).
    const [, entries] = invokeAnySpy.mock.calls[0] as [unknown, Array<{ path: string }>];
    expect(entries).toHaveLength(2);
  });

  test("without the fix (invokeAny omitted from the space-scoped context), batchPut rejects with INVALID_INPUT before signing or fetching", async () => {
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
    const accountSpaceId: string = (node as any).accountSpaceId;

    const session: ServiceSession = {
      delegationHeader: { Authorization: "Bearer primary" },
      delegationCid: "bafyprimary",
      spaceId: accountSpaceId,
      verificationMethod: "did:key:z6MkTestSession",
      jwk: { kty: "OKP" },
    };

    const invokeAnySpy = mock((_session: ServiceSession, _entries: unknown[]) => ({
      Authorization: "Bearer batch",
    }));
    const fetchSpy = mock(
      async () =>
        new Response(JSON.stringify({ written: ["a", "b"], count: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    // Same context as above, but the primary ServiceContext itself has no
    // invokeAny — mirrors a node whose top-level graph wiring never
    // threaded one through in the first place. createSpaceScopedKVService
    // reads `this._serviceContext.invokeAny`, so `undefined` here is
    // sufficient to reproduce the pre-fix regression without needing to
    // revert TinyCloudNode.ts itself.
    const ctx = new ServiceContext({
      invoke: () => ({ Authorization: "Bearer single" }),
      fetch: fetchSpy as any,
      hosts: ["https://tinycloud.test"],
    });
    ctx.setSession(session);
    (node as any)._serviceContext = ctx;

    (node as any)._spaceService = new SpaceService({
      hosts: ["https://tinycloud.test"],
      session,
      invoke: ctx.invoke,
      fetch: ctx.fetch,
      userDid: (node as any).did,
      createKVService: (spaceId: string) => (node as any).createSpaceScopedKVService(spaceId),
    });

    const result = await node.spaces.get(accountSpaceId).kv.batchPut([
      { key: "a", value: "one" },
      { key: "b", value: "two" },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
    expect(invokeAnySpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
