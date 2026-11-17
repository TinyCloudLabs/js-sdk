import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

import type { ISessionManager, IWasmBindings, PermissionEntry } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

/**
 * `delegateTo({ notBefore })` must reach the WASM signer as whole seconds (its sixth argument) on both signing
 * paths, and a delegation asked for without it must reach the signer with none. The signer is a mock that records
 * its arguments; the Rust signer's own handling of `notBeforeSecs` is the pinned tinycloud-node tag's.
 */

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const BACKEND = "did:key:backend";
const SESSION_SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
const MINUTE = 60_000;

let registry: UnregisteredLocationRegistry;
beforeAll(() => {
  registry = startUnregisteredLocationRegistry();
});
afterAll(() => {
  registry?.stop(true);
});

const sessionManager = (): ISessionManager => ({
  createSessionKey: (id: string) => id,
  replaceSessionKey: (_jwk: object, keyId: string) => keyId,
  renameSessionKeyId: () => {},
  getDID: (keyId: string) => `did:key:${keyId}`,
  jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
});

type SessionConfig = { jwk: object; spaceId: string; verificationMethod: string };
type Abilities = Record<string, Record<string, string[]>>;

function wasmBindings(sessionRecap: unknown[]): IWasmBindings {
  return {
    invoke: mock(() => ({})) as unknown as IWasmBindings["invoke"],
    invokeAny: mock(() => ({})) as unknown as IWasmBindings["invokeAny"],
    prepareSession: mock((cfg: SessionConfig) => ({ siwe: "runtime-siwe", jwk: cfg.jwk, spaceId: cfg.spaceId, verificationMethod: "did:key:runtime" })),
    completeSessionSetup: mock((cfg: SessionConfig) => ({
      delegationHeader: { Authorization: "runtime-token" },
      delegationCid: "runtime-cid",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: cfg.verificationMethod,
    })),
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, name: string) => `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    createDelegation: mock((_session: unknown, delegateDID: string, spaceId: string, abilities: Abilities) => ({
      delegation: "child-token",
      cid: "child-cid",
      delegateDid: delegateDID,
      expiry: Math.floor((Date.now() + 3600_000) / 1000),
      resources: Object.entries(abilities).flatMap(([service, paths]) =>
        Object.entries(paths).map(([path, actions]) => ({ service, space: spaceId, path, actions }))),
    })),
    parseRecapFromSiwe: mock(() => sessionRecap) as unknown as IWasmBindings["parseRecapFromSiwe"],
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    vault_encrypt: mock(() => new Uint8Array()),
    vault_decrypt: mock(() => new Uint8Array()),
    vault_derive_key: mock(() => new Uint8Array()),
    vault_x25519_from_seed: mock(() => ({ publicKey: new Uint8Array(), privateKey: new Uint8Array() })),
    vault_x25519_dh: mock(() => new Uint8Array()),
    vault_random_bytes: mock(() => new Uint8Array()),
    vault_sha256: mock(() => new Uint8Array()),
    createSessionManager: sessionManager,
    computeCid: () => "bafy-cid",
  };
}

/** A node holding a session that ends at `sessionExpiry`; `sessionRecap` is what its signed SIWE grants. */
function makeNode(sessionExpiry: Date, sessionRecap: unknown[] = []): TinyCloudNode {
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    tinycloudRegistryUrl: registry.url.origin,
    signer: { getAddress: async () => ADDRESS, getChainId: async () => 1, signMessage: mock(async () => "0xsig") } as unknown as ConstructorParameters<typeof TinyCloudNode>[0]["signer"],
    wasmBindings: wasmBindings(sessionRecap),
  });
  const siwe = `tinycloud.test wants you to sign in with your Ethereum account:
${ADDRESS}

Sign in.

URI: https://tinycloud.test
Version: 1
Chain ID: 1
Nonce: 32891756
Issued At: 2026-05-05T00:00:00.000Z
Expiration Time: ${sessionExpiry.toISOString()}`;
  Reflect.set(node, "auth", {
    resolveResourceDestinations: async () => [{ url: "https://tinycloud.test" }],
    nodeIdForHost: () => node.did,
    tinyCloudSession: {
      address: ADDRESS,
      chainId: 1,
      delegationHeader: { Authorization: "base-token" },
      delegationCid: "base-cid",
      jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
      sessionKey: "default",
      siwe,
      spaceId: SESSION_SPACE,
      verificationMethod: "did:key:default",
    },
  });
  return node;
}

async function withActivation<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === registry.url.origin) return originalFetch(input, init);
      return Promise.resolve(Response.json({ activated: ["child-cid", "runtime-cid"], skipped: [] }));
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const farFuture = () => new Date(Date.now() + 365 * 24 * 3600_000);
const sessionPermission: PermissionEntry = { service: "tinycloud.kv", space: "default", path: "items/", actions: ["tinycloud.kv/get"] };
const sessionRecap = [{ service: "kv", space: "default", path: "/", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] }];
const runtimePermission: PermissionEntry = { service: "tinycloud.kv", space: "secrets", path: "vault/a", actions: ["tinycloud.kv/put"] };

const signerCalls = (node: TinyCloudNode): unknown[][] =>
  (Reflect.get(node, "wasmBindings") as { createDelegation: { mock: { calls: unknown[][] } } }).createDelegation.mock.calls;

describe("delegateTo notBefore", () => {
  test("session path: the requested instant reaches the signer as whole seconds", async () => {
    const node = makeNode(farFuture(), sessionRecap);
    const notBefore = new Date(Date.now() + 2 * MINUTE + 789);
    await withActivation(() => node.delegateTo(BACKEND, [sessionPermission], { expiry: "1d", notBefore }));
    expect(signerCalls(node)).toHaveLength(1);
    expect(signerCalls(node)[0][5]).toBe(Math.floor(notBefore.getTime() / 1000));
    expect(Number.isInteger(signerCalls(node)[0][5])).toBe(true);
  });

  test("runtime-grant path: the requested instant reaches the signer as whole seconds", async () => {
    const node = makeNode(farFuture());
    const notBefore = new Date(Date.now() - MINUTE);
    await withActivation(async () => {
      await node.grantRuntimePermissions([runtimePermission]);
      await node.delegateTo(BACKEND, [runtimePermission], { expiry: "1d", notBefore });
    });
    expect(signerCalls(node)).toHaveLength(1);
    expect(signerCalls(node)[0][5]).toBe(Math.floor(notBefore.getTime() / 1000));
  });

  test("without the option the signer is given no not-before, on both paths", async () => {
    const session = makeNode(farFuture(), sessionRecap);
    await withActivation(() => session.delegateTo(BACKEND, [sessionPermission], { expiry: "1d" }));
    expect(signerCalls(session)[0][5]).toBeUndefined();

    const runtime = makeNode(farFuture());
    await withActivation(async () => {
      await runtime.grantRuntimePermissions([runtimePermission]);
      await runtime.delegateTo(BACKEND, [runtimePermission]);
    });
    expect(signerCalls(runtime)[0][5]).toBeUndefined();
  });

  test("a not-before after the expiry is refused and nothing is signed", async () => {
    const node = makeNode(farFuture(), sessionRecap);
    const error = await node
      .delegateTo(BACKEND, [sessionPermission], { expiry: MINUTE, notBefore: new Date(Date.now() + 2 * MINUTE) })
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/notBefore .* is after the delegation's expiry/);
    expect(signerCalls(node)).toHaveLength(0);
  });

  test("the expiry it is compared with is the one signed after the session cap", async () => {
    // Requested 30 days, but the session ends in 2 minutes: a not-before at 3 minutes is after what will be signed.
    const node = makeNode(new Date(Date.now() + 2 * MINUTE), sessionRecap);
    await expect(
      node.delegateTo(BACKEND, [sessionPermission], { notBefore: new Date(Date.now() + 3 * MINUTE) }),
    ).rejects.toThrow(/is after the delegation's expiry/);
    expect(signerCalls(node)).toHaveLength(0);
  });

  test("more than 5 minutes ahead is refused; 4 minutes ahead is signed", async () => {
    const node = makeNode(farFuture(), sessionRecap);
    await expect(
      node.delegateTo(BACKEND, [sessionPermission], { expiry: "1d", notBefore: new Date(Date.now() + 6 * MINUTE) }),
    ).rejects.toThrow(/at most 5 minutes in the future/);
    expect(signerCalls(node)).toHaveLength(0);
    await withActivation(() => node.delegateTo(BACKEND, [sessionPermission], { expiry: "1d", notBefore: new Date(Date.now() + 4 * MINUTE) }));
    expect(signerCalls(node)).toHaveLength(1);
  });

  test("an invalid Date or a non-Date is refused", async () => {
    const node = makeNode(farFuture(), sessionRecap);
    await expect(node.delegateTo(BACKEND, [sessionPermission], { notBefore: new Date(Number.NaN) })).rejects.toThrow(/valid Date/);
    await expect(node.delegateTo(BACKEND, [sessionPermission], { notBefore: Math.floor(Date.now() / 1000) as unknown as Date })).rejects.toThrow(/valid Date/);
    expect(signerCalls(node)).toHaveLength(0);
  });

  test("it cannot be combined with the wallet-signed path, which could not carry it", async () => {
    const node = makeNode(farFuture(), sessionRecap);
    await expect(
      node.delegateTo(BACKEND, [sessionPermission], { forceWalletSign: true, notBefore: new Date() }),
    ).rejects.toThrow(/cannot be combined with forceWalletSign/);
    expect(signerCalls(node)).toHaveLength(0);
  });
});
