/**
 * Decrypt grants last at most one hour on every delegation path.
 *
 * A decrypt-bearing grant with no expiry defaults to one hour. An explicit
 * expiry above one hour is refused with DECRYPT_EXPIRY_TOO_LONG before any
 * session preparation, signing, or network call. Non-decrypt grants keep
 * their existing defaults.
 */

import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";

import type { IWasmBindings, ISessionManager, PermissionEntry } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

const HOUR_MS = 60 * 60_000;
const TOLERANCE_MS = 5_000;
const OWNER = "0xD559CCd9EB87c530A9a349262669386dE93cf412";
const SPACE = `tinycloud:pkh:eip155:1:${OWNER}:applications`;
const BOB_DID = "did:pkh:eip155:1:0x00000000000000000000000000000000000000BB";
// Canonical network URN: `urn:tinycloud:encryption:<ownerDid>:<name>`.
const DECRYPT_PATH = `urn:tinycloud:encryption:did:pkh:eip155:1:${OWNER}:network-1`;
const DECRYPT_ACTION = "tinycloud.encryption/decrypt";

const DECRYPT_REQUEST = {
  service: "tinycloud.encryption",
  space: "encryption",
  path: DECRYPT_PATH,
  actions: [DECRYPT_ACTION],
} as PermissionEntry;

const DECRYPT_GRANTED = {
  service: "encryption",
  space: "encryption",
  path: DECRYPT_PATH,
  actions: [DECRYPT_ACTION],
};

const KV_REQUEST = {
  service: "tinycloud.kv",
  space: "default",
  path: "items/",
  actions: ["tinycloud.kv/get"],
} as PermissionEntry;

const KV_GRANTED = {
  service: "kv",
  space: "default",
  path: "/",
  actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
};

function buildSiwe(expirationTime: string): string {
  return [
    "example.com wants you to sign in with your Ethereum account:",
    "0x0000000000000000000000000000000000000001",
    "",
    "Sign-in statement",
    "",
    "URI: https://example.com",
    "Version: 1",
    "Chain ID: 1",
    "Nonce: abcdefghij",
    "Issued At: 2024-01-01T00:00:00.000Z",
    `Expiration Time: ${expirationTime}`,
  ].join("\n");
}

function makeFakeSessionManager(): ISessionManager {
  const keys = new Set<string>();
  return {
    createSessionKey(id: string): string {
      keys.add(id);
      return id;
    },
    replaceSessionKey(_jwk: object, keyId: string): string {
      keys.add(keyId);
      return keyId;
    },
    renameSessionKeyId(oldId: string, newId: string): void {
      if (keys.has(oldId)) {
        keys.delete(oldId);
        keys.add(newId);
      }
    },
    getDID(keyId: string): string {
      return `did:key:z6MkTest-${keyId}`;
    },
    jwk(keyId: string): string | undefined {
      if (!keys.has(keyId)) return undefined;
      return JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" });
    },
  };
}

/** Fake WASM grant result. Resources mirror a real issuance (non-empty). */
function grantResult(delegateDid: string) {
  return {
    delegation: "fake-serialized-delegation",
    cid: "bafyfake",
    delegateDid,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    resources: [{ service: "kv", space: SPACE, path: "items/", actions: ["tinycloud.kv/get"] }],
  };
}

/**
 * Session-only WASM bindings. `parseRecapFromSiwe` returns `granted`, so a
 * request covered by it takes the session path that calls `createDelegation`.
 */
function makeSessionWasm(granted: unknown[]) {
  return {
    createSessionManager: makeFakeSessionManager,
    invoke: mock(() => Promise.resolve({})),
    invokeAny: mock(() => Promise.resolve({})),
    prepareSession: mock(() => ({})),
    completeSessionSetup: mock(() => ({})),
    ensureEip55: (a: string) => a,
    makeSpaceId: (a: string, c: number, p: string) => `space://${a}:${c}:${p}`,
    createDelegation: mock((_s: unknown, did: string) => grantResult(did)),
    parseRecapFromSiwe: mock(() => granted),
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
  } as unknown as IWasmBindings & {
    prepareSession: ReturnType<typeof mock>;
    createDelegation: ReturnType<typeof mock>;
  };
}

function installFakeSession(node: TinyCloudNode, siweExpiry: Date): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (node as any).auth = {
    tinyCloudSession: {
      address: "0x0000000000000000000000000000000000000001",
      chainId: 1,
      sessionKey: "default",
      spaceId: "space://test",
      delegationCid: "bafyparent",
      delegationHeader: { Authorization: "Bearer parent" },
      verificationMethod: "did:key:z6MkTestSession#z6MkTestSession",
      jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
      siwe: buildSiwe(siweExpiry.toISOString()),
      signature: "0xfake",
    },
  };
}

/** Signing-capable WASM bindings for owner, sharing, and sub-delegation paths. */
function makeSigningWasm() {
  return {
    createSessionManager: makeFakeSessionManager,
    createDelegation: mock((_s: unknown, did: string) => grantResult(did)),
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
  } as unknown as IWasmBindings & {
    prepareSession: ReturnType<typeof mock>;
    createDelegation: ReturnType<typeof mock>;
  };
}

function makeSigningNode(wasm: IWasmBindings) {
  const signMessage = mock(async () => "signature");
  const node = new TinyCloudNode({
    host: "https://node.example",
    signer: { signMessage } as any,
    wasmBindings: wasm,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (node as any)._address = OWNER;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (node as any)._chainId = 1;
  return { node, signMessage };
}

/** Returns the thrown error's `code`, or fails if nothing was thrown. */
function thrownCode(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
  throw new Error("expected a throw, got none");
}

async function rejectedCode(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
  throw new Error("expected a rejection, got a resolution");
}

function inMs(ms: number): number {
  return ms + Date.now();
}

describe("decrypt grants last at most one hour", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ cid: "commit-event-cid", activated: ["share-delegation-cid"], skipped: [] }),
      text: async () => "",
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSystemTime();
  });

  describe("delegateTo (session path)", () => {
    test("a decrypt grant with no expiry lasts one hour", async () => {
      const wasm = makeSessionWasm([DECRYPT_GRANTED]);
      const node = new TinyCloudNode({ wasmBindings: wasm });
      installFakeSession(node, new Date(inMs(30 * 24 * HOUR_MS)));

      await node.delegateTo(BOB_DID, [DECRYPT_REQUEST]);

      expect(wasm.createDelegation).toHaveBeenCalledTimes(1);
      const expirationSecs = wasm.createDelegation.mock.calls[0][4] as number;
      const lifetimeMs = expirationSecs * 1000 - Date.now();
      expect(lifetimeMs).toBeLessThanOrEqual(HOUR_MS);
      expect(lifetimeMs).toBeGreaterThan(HOUR_MS - TOLERANCE_MS);
    });

    test("an explicit decrypt expiry above one hour is refused before any prepare or network call", async () => {
      const wasm = makeSessionWasm([DECRYPT_GRANTED]);
      const node = new TinyCloudNode({ wasmBindings: wasm });
      installFakeSession(node, new Date(inMs(30 * 24 * HOUR_MS)));

      const code = await rejectedCode(
        node.delegateTo(BOB_DID, [DECRYPT_REQUEST], { expiry: 2 * HOUR_MS }),
      );
      expect(code).toBe("DECRYPT_EXPIRY_TOO_LONG");
      expect(wasm.createDelegation).toHaveBeenCalledTimes(0);
      expect(wasm.prepareSession).toHaveBeenCalledTimes(0);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    test("an explicit decrypt expiry of exactly one hour is honoured", async () => {
      const wasm = makeSessionWasm([DECRYPT_GRANTED]);
      const node = new TinyCloudNode({ wasmBindings: wasm });
      installFakeSession(node, new Date(inMs(30 * 24 * HOUR_MS)));

      await node.delegateTo(BOB_DID, [DECRYPT_REQUEST], { expiry: HOUR_MS });

      expect(wasm.createDelegation).toHaveBeenCalledTimes(1);
      const expirationSecs = wasm.createDelegation.mock.calls[0][4] as number;
      const lifetimeMs = expirationSecs * 1000 - Date.now();
      expect(lifetimeMs).toBeLessThanOrEqual(HOUR_MS);
      expect(lifetimeMs).toBeGreaterThan(HOUR_MS - TOLERANCE_MS);
    });

    test("a non-decrypt grant with no expiry keeps the long default", async () => {
      const wasm = makeSessionWasm([KV_GRANTED]);
      const node = new TinyCloudNode({ wasmBindings: wasm });
      installFakeSession(node, new Date(inMs(60 * 24 * HOUR_MS)));

      await node.delegateTo(BOB_DID, [KV_REQUEST]);

      expect(wasm.createDelegation).toHaveBeenCalledTimes(1);
      const expirationSecs = wasm.createDelegation.mock.calls[0][4] as number;
      expect(expirationSecs * 1000 - Date.now()).toBeGreaterThan(24 * HOUR_MS);
    });
  });

  describe("planDelegation", () => {
    test("a decrypt plan with no expiry is capped at one hour", () => {
      const wasm = makeSessionWasm([DECRYPT_GRANTED]);
      const node = new TinyCloudNode({ wasmBindings: wasm });
      installFakeSession(node, new Date(inMs(30 * 24 * HOUR_MS)));

      const plan = node.planDelegation([DECRYPT_REQUEST]);

      expect(plan).toHaveProperty("effectiveExpiration");
      const lifetimeMs = (plan as { effectiveExpiration: Date }).effectiveExpiration.getTime() - Date.now();
      expect(lifetimeMs).toBeLessThanOrEqual(HOUR_MS);
      expect(lifetimeMs).toBeGreaterThan(HOUR_MS - TOLERANCE_MS);
    });

    test("an explicit decrypt expiry above one hour throws instead of returning a plan", () => {
      const wasm = makeSessionWasm([DECRYPT_GRANTED]);
      const node = new TinyCloudNode({ wasmBindings: wasm });
      installFakeSession(node, new Date(inMs(30 * 24 * HOUR_MS)));

      expect(thrownCode(() => node.planDelegation([DECRYPT_REQUEST], { expiry: 2 * HOUR_MS }))).toBe(
        "DECRYPT_EXPIRY_TOO_LONG",
      );
    });

    test("an explicit decrypt expiry of exactly one hour is honoured", () => {
      const now = 1_700_000_000_000;
      setSystemTime(new Date(now));
      const wasm = makeSessionWasm([DECRYPT_GRANTED]);
      const node = new TinyCloudNode({ wasmBindings: wasm });
      installFakeSession(node, new Date(now + 30 * 24 * HOUR_MS));

      const plan = node.planDelegation([DECRYPT_REQUEST], { expiry: HOUR_MS });

      expect((plan as { effectiveExpiration: Date }).effectiveExpiration.getTime()).toBe(now + HOUR_MS);
    });

    test("a non-decrypt plan with no expiry keeps the long default", () => {
      const wasm = makeSessionWasm([KV_GRANTED]);
      const node = new TinyCloudNode({ wasmBindings: wasm });
      installFakeSession(node, new Date(inMs(60 * 24 * HOUR_MS)));

      const plan = node.planDelegation([KV_REQUEST]);

      const lifetimeMs = (plan as { effectiveExpiration: Date }).effectiveExpiration.getTime() - Date.now();
      expect(lifetimeMs).toBeGreaterThan(24 * HOUR_MS);
    });

    test("a non-decrypt plan with an explicit expiry above one hour is honoured", () => {
      const now = 1_700_000_000_000;
      setSystemTime(new Date(now));
      const wasm = makeSessionWasm([KV_GRANTED]);
      const node = new TinyCloudNode({ wasmBindings: wasm });
      installFakeSession(node, new Date(now + 60 * 24 * HOUR_MS));

      const plan = node.planDelegation([KV_REQUEST], { expiry: 2 * HOUR_MS });

      expect((plan as { effectiveExpiration: Date }).effectiveExpiration.getTime()).toBe(now + 2 * HOUR_MS);
    });
  });

  describe("sub-delegation (createSubDelegation)", () => {
    const decryptResources = [
      { service: "kv", space: SPACE, path: "docs", actions: ["tinycloud.kv/get"] },
      { service: "encryption", space: "encryption", path: DECRYPT_PATH, actions: [DECRYPT_ACTION] },
    ];

    function parentWithExpiry(expiry: Date) {
      return {
        cid: "parent-cid",
        delegationHeader: { Authorization: "parent.header.signature" },
        spaceId: SPACE,
        path: "docs",
        actions: ["tinycloud.kv/get"],
        resources: decryptResources,
        expiry,
        delegateDID: "did:key:z6MkReceiver",
        ownerAddress: OWNER,
        chainId: 1,
      };
    }

    test("a decrypt sub-delegation under a three-day parent defaults to one hour", async () => {
      const wasm = makeSigningWasm();
      const { node } = makeSigningNode(wasm);
      const parentExpiry = new Date(inMs(3 * 24 * HOUR_MS));

      await node.createSubDelegation(parentWithExpiry(parentExpiry), {
        path: "docs",
        actions: ["tinycloud.kv/get"],
        delegateDID: "did:key:z6MkChild",
        resources: decryptResources,
      } as any);

      const expirationTime = new Date(wasm.prepareSession.mock.calls[0][0].expirationTime).getTime();
      const lifetimeMs = expirationTime - Date.now();
      expect(lifetimeMs).toBeLessThanOrEqual(HOUR_MS);
      expect(lifetimeMs).toBeGreaterThan(HOUR_MS - TOLERANCE_MS);
      expect(expirationTime).toBeLessThan(parentExpiry.getTime());
    });

    test("an explicit decrypt sub-delegation above one hour is refused before signing or preparing", async () => {
      const wasm = makeSigningWasm();
      const { node, signMessage } = makeSigningNode(wasm);
      const fetchCallsBefore = fetchMock.mock.calls.length;

      const code = await rejectedCode(
        node.createSubDelegation(parentWithExpiry(new Date(inMs(3 * 24 * HOUR_MS))), {
          path: "docs",
          actions: ["tinycloud.kv/get"],
          delegateDID: "did:key:z6MkChild",
          resources: decryptResources,
          expiryMs: 2 * HOUR_MS,
        } as any),
      );
      expect(code).toBe("DECRYPT_EXPIRY_TOO_LONG");
      expect(wasm.prepareSession).toHaveBeenCalledTimes(0);
      expect(signMessage).toHaveBeenCalledTimes(0);
      expect(fetchMock.mock.calls.length - fetchCallsBefore).toBe(0);
    });

    test("an explicit decrypt sub-delegation of thirty minutes is honoured", async () => {
      const wasm = makeSigningWasm();
      const { node } = makeSigningNode(wasm);

      await node.createSubDelegation(parentWithExpiry(new Date(inMs(3 * 24 * HOUR_MS))), {
        path: "docs",
        actions: ["tinycloud.kv/get"],
        delegateDID: "did:key:z6MkChild",
        resources: decryptResources,
        expiryMs: HOUR_MS / 2,
      } as any);

      const expirationTime = new Date(wasm.prepareSession.mock.calls[0][0].expirationTime).getTime();
      const lifetimeMs = expirationTime - Date.now();
      expect(lifetimeMs).toBeLessThanOrEqual(HOUR_MS / 2);
      expect(lifetimeMs).toBeGreaterThan(HOUR_MS / 2 - TOLERANCE_MS);
    });

    test("an explicit decrypt sub-delegation of exactly one hour is honoured", async () => {
      const now = 1_700_000_000_000;
      setSystemTime(new Date(now));
      const wasm = makeSigningWasm();
      const { node } = makeSigningNode(wasm);

      await node.createSubDelegation(parentWithExpiry(new Date(now + 3 * 24 * HOUR_MS)), {
        path: "docs",
        actions: ["tinycloud.kv/get"],
        delegateDID: "did:key:z6MkChild",
        resources: decryptResources,
        expiryMs: HOUR_MS,
      } as any);

      const expirationTime = new Date(wasm.prepareSession.mock.calls[0][0].expirationTime).getTime();
      expect(expirationTime).toBe(now + HOUR_MS);
    });

    test("a non-decrypt sub-delegation with an explicit expiry above one hour is honoured", async () => {
      const now = 1_700_000_000_000;
      setSystemTime(new Date(now));
      const wasm = makeSigningWasm();
      const { node } = makeSigningNode(wasm);
      const kvOnlyResources = [{ service: "kv", space: SPACE, path: "docs", actions: ["tinycloud.kv/get"] }];

      await node.createSubDelegation(
        { ...parentWithExpiry(new Date(now + 3 * 24 * HOUR_MS)), resources: kvOnlyResources },
        {
          path: "docs",
          actions: ["tinycloud.kv/get"],
          delegateDID: "did:key:z6MkChild",
          resources: kvOnlyResources,
          expiryMs: 2 * HOUR_MS,
        } as any,
      );

      const expirationTime = new Date(wasm.prepareSession.mock.calls[0][0].expirationTime).getTime();
      expect(expirationTime).toBe(now + 2 * HOUR_MS);
    });
  });

  describe("owner and sharing root delegation", () => {
    const OWNER_DECRYPT = {
      delegateDid: "did:key:z6MkShare",
      spaceId: SPACE,
      path: DECRYPT_PATH,
      actions: [DECRYPT_ACTION],
    };

    test("an owner decrypt delegation above one hour is refused before preparing or signing", async () => {
      const wasm = makeSigningWasm();
      const { node, signMessage } = makeSigningNode(wasm);

      const code = await rejectedCode(
        (node as any).createOwnerDelegation({
          ...OWNER_DECRYPT,
          expiresAt: new Date(inMs(2 * HOUR_MS)),
        }),
      );
      expect(code).toBe("DECRYPT_EXPIRY_TOO_LONG");
      expect(wasm.prepareSession).toHaveBeenCalledTimes(0);
      expect(signMessage).toHaveBeenCalledTimes(0);
    });

    test("an owner decrypt delegation of thirty minutes is prepared with its explicit expiry", async () => {
      const wasm = makeSigningWasm();
      const { node } = makeSigningNode(wasm);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node as any)._restoredTcSession = { address: OWNER, chainId: 1, spaceId: SPACE };
      const expiresAt = new Date(inMs(30 * 60_000));

      await (node as any).createOwnerDelegation({ ...OWNER_DECRYPT, expiresAt });

      expect(wasm.prepareSession.mock.calls[0][0].expirationTime).toBe(expiresAt.toISOString());
    });

    test("a non-decrypt owner delegation above one hour is still prepared with its explicit expiry", async () => {
      const wasm = makeSigningWasm();
      const { node } = makeSigningNode(wasm);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node as any)._restoredTcSession = { address: OWNER, chainId: 1, spaceId: SPACE };
      const expiresAt = new Date(inMs(2 * HOUR_MS));

      await (node as any).createOwnerDelegation({
        delegateDid: "did:key:z6MkShare",
        spaceId: SPACE,
        path: "xyz.tinycloud.listen/conversations",
        actions: ["tinycloud.sql/read"],
        expiresAt,
      });

      expect(wasm.prepareSession.mock.calls[0][0].expirationTime).toBe(expiresAt.toISOString());
    });

    test("a sharing root for decrypt above one hour rejects with the decrypt code, not undefined", async () => {
      const wasm = makeSigningWasm();
      const { node, signMessage } = makeSigningNode(wasm);

      const code = await rejectedCode(
        (node as any).createRootDelegationForSharing({
          shareKeyDID: "did:key:z6MkShare",
          spaceId: SPACE,
          path: DECRYPT_PATH,
          actions: [DECRYPT_ACTION],
          requestedExpiry: new Date(inMs(2 * HOUR_MS)),
        }),
      );
      expect(code).toBe("DECRYPT_EXPIRY_TOO_LONG");
      expect(wasm.prepareSession).toHaveBeenCalledTimes(0);
      expect(signMessage).toHaveBeenCalledTimes(0);
    });

    test("an owner decrypt delegation of exactly one hour is accepted and one second more is refused", async () => {
      const now = 1_700_000_000_000;
      setSystemTime(new Date(now));
      const wasm = makeSigningWasm();
      const { node } = makeSigningNode(wasm);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node as any)._restoredTcSession = { address: OWNER, chainId: 1, spaceId: SPACE };

      await (node as any).createOwnerDelegation({ ...OWNER_DECRYPT, expiresAt: new Date(now + HOUR_MS) });
      expect(wasm.prepareSession.mock.calls[0][0].expirationTime).toBe(new Date(now + HOUR_MS).toISOString());

      const code = await rejectedCode(
        (node as any).createOwnerDelegation({ ...OWNER_DECRYPT, expiresAt: new Date(now + HOUR_MS + 1000) }),
      );
      expect(code).toBe("DECRYPT_EXPIRY_TOO_LONG");
      expect(wasm.prepareSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("WASM sink (createDelegationWrapper)", () => {
    const sinkSession = {
      delegationHeader: { Authorization: "parent.header" },
      delegationCid: "bafyparent",
      jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
      spaceId: SPACE,
      verificationMethod: "did:key:z6MkTestSession#z6MkTestSession",
    };
    const decryptAbilities = { encryption: { [DECRYPT_PATH]: [DECRYPT_ACTION] } };

    function sinkNode() {
      const wasm = makeSigningWasm();
      const { node } = makeSigningNode(wasm);
      return { wasm, node: node as any };
    }

    test("the sink refuses a decrypt grant whose expiration is above one hour", () => {
      const { wasm, node } = sinkNode();

      expect(
        thrownCode(() =>
          node.createDelegationWrapper({
            session: sinkSession,
            delegateDID: BOB_DID,
            spaceId: SPACE,
            abilities: decryptAbilities,
            expirationSecs: Math.floor(inMs(2 * HOUR_MS) / 1000),
          }),
        ),
      ).toBe("DECRYPT_EXPIRY_TOO_LONG");
      expect(wasm.createDelegation).toHaveBeenCalledTimes(0);
    });

    test("the sink refuses a wildcard encryption grant above one hour", () => {
      const { wasm, node } = sinkNode();

      expect(
        thrownCode(() =>
          node.createDelegationWrapper({
            session: sinkSession,
            delegateDID: BOB_DID,
            spaceId: SPACE,
            abilities: { encryption: { [DECRYPT_PATH]: ["tinycloud.encryption/*"] } },
            expirationSecs: Math.floor(inMs(2 * HOUR_MS) / 1000),
          }),
        ),
      ).toBe("DECRYPT_EXPIRY_TOO_LONG");
      expect(wasm.createDelegation).toHaveBeenCalledTimes(0);
    });

    test("the sink passes a decrypt grant of one hour or less to WASM", () => {
      const { wasm, node } = sinkNode();

      node.createDelegationWrapper({
        session: sinkSession,
        delegateDID: BOB_DID,
        spaceId: SPACE,
        abilities: decryptAbilities,
        expirationSecs: Math.floor(inMs(HOUR_MS) / 1000),
      });

      expect(wasm.createDelegation).toHaveBeenCalledTimes(1);
    });

    test("the sink leaves non-decrypt grants of any lifetime unchanged", () => {
      const { wasm, node } = sinkNode();

      node.createDelegationWrapper({
        session: sinkSession,
        delegateDID: BOB_DID,
        spaceId: SPACE,
        abilities: { kv: { docs: ["tinycloud.kv/get"] } },
        expirationSecs: Math.floor(inMs(2 * HOUR_MS) / 1000),
      });

      expect(wasm.createDelegation).toHaveBeenCalledTimes(1);
    });

    test("the sink accepts a decrypt grant of exactly one hour and refuses one second more", () => {
      const now = 1_700_000_000_000;
      setSystemTime(new Date(now));
      const { wasm, node } = sinkNode();

      node.createDelegationWrapper({
        session: sinkSession,
        delegateDID: BOB_DID,
        spaceId: SPACE,
        abilities: decryptAbilities,
        expirationSecs: (now + HOUR_MS) / 1000,
      });
      expect(wasm.createDelegation).toHaveBeenCalledTimes(1);

      expect(
        thrownCode(() =>
          node.createDelegationWrapper({
            session: sinkSession,
            delegateDID: BOB_DID,
            spaceId: SPACE,
            abilities: decryptAbilities,
            expirationSecs: (now + HOUR_MS + 1000) / 1000,
          }),
        ),
      ).toBe("DECRYPT_EXPIRY_TOO_LONG");
      expect(wasm.createDelegation).toHaveBeenCalledTimes(1);
    });
  });
});
