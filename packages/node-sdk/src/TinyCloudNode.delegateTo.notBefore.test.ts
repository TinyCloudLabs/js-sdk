import { ed25519 } from "@noble/curves/ed25519";
import { afterAll, beforeAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import { base58btc } from "multiformats/bases/base58";
import type { ISessionManager, IWasmBindings, PermissionEntry } from "@tinycloud/sdk-core";
import { TinyCloudNode, type TinyCloudNodeConfig } from "./TinyCloudNode";
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
    signer: { getAddress: async () => ADDRESS, getChainId: async () => 1, signMessage: mock(async () => "0xsig") } as unknown as TinyCloudNodeConfig["signer"],
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

// A fixed whole second plus 900 ms, so "floored" is distinguishable from "rounded" whatever instant the suite runs at.
const wholeSecond = () => Math.floor(Date.now() / 1000) * 1000;

describe("delegateTo notBefore", () => {
  test("session path: the requested instant reaches the signer floored to the whole second", async () => {
    const node = makeNode(farFuture(), sessionRecap);
    const base = wholeSecond();
    const notBefore = new Date(base - 2 * MINUTE + 900);
    await withActivation(() => node.delegateTo(BACKEND, [sessionPermission], { expiry: "1d", notBefore }));
    expect(signerCalls(node)).toHaveLength(1);
    expect(signerCalls(node)[0][5]).toBe(base / 1000 - 120);
  });

  test("runtime-grant path: the requested instant reaches the signer floored to the whole second", async () => {
    const node = makeNode(farFuture());
    const base = wholeSecond();
    const notBefore = new Date(base - MINUTE + 900);
    await withActivation(async () => {
      await node.grantRuntimePermissions([runtimePermission]);
      await node.delegateTo(BACKEND, [runtimePermission], { expiry: "1d", notBefore });
    });
    expect(signerCalls(node)).toHaveLength(1);
    expect(signerCalls(node)[0][5]).toBe(base / 1000 - 60);
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
    expect((error as Error).message).toMatch(/notBefore .* is not before the delegation's expiry/);
    expect(signerCalls(node)).toHaveLength(0);
  });

  test("the expiry it is compared with is the one signed after the session cap", async () => {
    // Requested 30 days, but the session ends in 2 minutes: a not-before at 3 minutes is not before what will be signed.
    const node = makeNode(new Date(Date.now() + 2 * MINUTE), sessionRecap);
    await expect(
      node.delegateTo(BACKEND, [sessionPermission], { notBefore: new Date(Date.now() + 3 * MINUTE) }),
    ).rejects.toThrow(/is not before the delegation's expiry/);
    expect(signerCalls(node)).toHaveLength(0);
  });

  test("on the runtime path it is compared with the runtime grant's expiry, which caps the requested one", async () => {
    // The session lasts a year and delegateTo asks for a day, but the runtime grant ends in 3 minutes: that is the expiry
    // signed, so a not-before at 4 minutes is not before it. Against the session-capped day it would only be "in the future",
    // which is a different refusal.
    const node = makeNode(farFuture());
    await withActivation(() => node.grantRuntimePermissions([runtimePermission], { expiry: "3m" }));
    await expect(
      node.delegateTo(BACKEND, [runtimePermission], { expiry: "1d", notBefore: new Date(Date.now() + 4 * MINUTE) }),
    ).rejects.toThrow(/is not before the delegation's expiry/);
    expect(signerCalls(node)).toHaveLength(0);
  });

  test("a not-before equal to the expiry, to the second, is refused", async () => {
    const base = wholeSecond();
    setSystemTime(new Date(base));
    try {
      const node = makeNode(farFuture(), sessionRecap);
      await expect(
        node.delegateTo(BACKEND, [sessionPermission], { expiry: 3 * MINUTE, notBefore: new Date(base + 3 * MINUTE) }),
      ).rejects.toThrow(/is not before the delegation's expiry/);
      // One second earlier is before the expiry, so it falls through to the future check instead.
      await expect(
        node.delegateTo(BACKEND, [sessionPermission], { expiry: 3 * MINUTE, notBefore: new Date(base + 3 * MINUTE - 1000) }),
      ).rejects.toThrow(/is in the future/);
      expect(signerCalls(node)).toHaveLength(0);
    } finally {
      setSystemTime();
    }
  });

  test("a not-before in the future is refused, even by one second; now and the past are signed", async () => {
    const node = makeNode(farFuture(), sessionRecap);
    await expect(
      node.delegateTo(BACKEND, [sessionPermission], { expiry: "1d", notBefore: new Date(Date.now() + 4 * MINUTE) }),
    ).rejects.toThrow(/is in the future/);
    await expect(
      node.delegateTo(BACKEND, [sessionPermission], { expiry: "1d", notBefore: new Date(Date.now() + 1000) }),
    ).rejects.toThrow(/is in the future/);
    expect(signerCalls(node)).toHaveLength(0);
    await withActivation(async () => {
      await node.delegateTo(BACKEND, [sessionPermission], { expiry: "1d", notBefore: new Date() });
      await node.delegateTo(BACKEND, [sessionPermission], { expiry: "1d", notBefore: new Date(Date.now() - 5 * MINUTE) });
    });
    expect(signerCalls(node)).toHaveLength(2);
  });

  test("with disableSubDelegation the not-before survives the terminal re-sign", async () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    const sessionDid = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...publicKey))}`;
    const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
    const node = makeNode(farFuture(), sessionRecap);
    // The session key is a real one, and the signer mock returns a UCAN signed by it that carries the nbf it was given.
    const session = Reflect.get(Reflect.get(node, "auth"), "tinyCloudSession");
    Object.assign(session, { jwk: { kty: "OKP", crv: "Ed25519", x: b64u(publicKey), d: b64u(privateKey) } });
    const createDelegation = mock((_session: unknown, delegateDID: string, spaceId: string, abilities: Abilities, expirationSecs: number, notBeforeSecs?: number) => {
      const input = [
        { alg: "EdDSA", typ: "JWT", ucv: "0.10.0" },
        { iss: `${sessionDid}#${sessionDid.slice("did:key:".length)}`, aud: delegateDID, exp: expirationSecs, nbf: notBeforeSecs, prf: ["bafyparent"], att: {} },
      ].map((part) => b64u(Buffer.from(JSON.stringify(part)))).join(".");
      return {
        delegation: `${input}.${b64u(ed25519.sign(Buffer.from(input), privateKey))}`,
        cid: "child-cid",
        delegateDid: delegateDID,
        expiry: expirationSecs,
        resources: Object.entries(abilities).flatMap(([service, paths]) =>
          Object.entries(paths).map(([path, actions]) => ({ service, space: spaceId, path, actions }))),
      };
    });
    Reflect.set(Reflect.get(node, "wasmBindings"), "createDelegation", createDelegation);
    const notBefore = new Date(wholeSecond() - 2 * MINUTE + 900);
    const result = await withActivation(() =>
      node.delegateTo(BACKEND, [sessionPermission], { expiry: "1d", notBefore, disableSubDelegation: true }),
    );
    expect(result.delegation.disableSubDelegation).toBe(true);
    const payload = JSON.parse(Buffer.from(result.delegation.delegationHeader.Authorization.split(".")[1]!, "base64url").toString());
    expect(payload.fct).toEqual([{ "xyz.tinycloud.policy/delegationMode": "terminal" }]);
    expect(payload.nbf).toBe(Math.floor(notBefore.getTime() / 1000));
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
