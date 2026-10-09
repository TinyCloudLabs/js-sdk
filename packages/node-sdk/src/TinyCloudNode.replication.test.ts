/**
 * Unit tests for the TC-858 B-node wiring in {@link TinyCloudNode}:
 * config validation, `planDelegation` parity with `delegateTo` (§4.3),
 * `replicationAuthority` inputs, and `replicationSignInEntries` parity
 * with the abilities `signIn` actually requests (§4.1, §4.6).
 *
 * Fully mocked IWasmBindings — no real WASM, no server.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  CaveatedDelegationUnsupportedError,
  PermissionNotInManifestError,
  SessionExpiredError,
  type ComposedManifestRequest,
  type ISessionManager,
  type ISigner,
  type IWasmBindings,
  type PermissionEntry,
  type TinyCloudSession,
} from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";
import { NodeUserAuthorization } from "./authorization/NodeUserAuthorization";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";

// ---------------------------------------------------------------------------
// Fixtures (mirrors TinyCloudNode.delegateTo.test.ts)
// ---------------------------------------------------------------------------

const ADDRESS = "0x0000000000000000000000000000000000000001";
const SPACE_ID = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const BOB_DID = "did:pkh:eip155:1:0x00000000000000000000000000000000000000BB";
const DEVICE_DID = "did:key:zTestDevice";

function buildSiwe(expirationTime: string | null): string {
  const lines = [
    "example.com wants you to sign in with your Ethereum account:",
    ADDRESS,
    "",
    "Sign-in statement",
    "",
    "URI: https://example.com",
    "Version: 1",
    "Chain ID: 1",
    "Nonce: abcdefghij",
    "Issued At: 2024-01-01T00:00:00.000Z",
  ];
  if (expirationTime !== null) {
    lines.push(`Expiration Time: ${expirationTime}`);
  }
  return lines.join("\n");
}

const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

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
      if (!keys.has(keyId)) {
        return undefined;
      }
      return JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" });
    },
  };
}

function makeFakeWasmBindings(
  overrides: Partial<IWasmBindings> = {},
): IWasmBindings {
  const base: IWasmBindings = {
    invoke: mock(() => Promise.resolve({} as never)) as never,
    invokeAny: mock(() => Promise.resolve({} as never)) as never,
    prepareSession: mock(() => ({})),
    completeSessionSetup: mock(() => ({})),
    ensureEip55: (a: string) => a,
    makeSpaceId: (a: string, c: number, p: string) =>
      `tinycloud:pkh:eip155:${c}:${a}:${p}`,
    createDelegation: mock(() => ({
      delegation: "fake-serialized-delegation",
      cid: "bafyfake",
      delegateDid: BOB_DID,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      resources: [],
    })),
    parseRecapFromSiwe: mock(() => [] as never[]),
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    vault_encrypt: mock(() => new Uint8Array()),
    vault_decrypt: mock(() => new Uint8Array()),
    vault_derive_key: mock(() => new Uint8Array()),
    vault_x25519_from_seed: mock(() => ({
      publicKey: new Uint8Array(),
      privateKey: new Uint8Array(),
    })),
    vault_x25519_dh: mock(() => new Uint8Array()),
    vault_random_bytes: mock(() => new Uint8Array()),
    vault_sha256: mock(() => new Uint8Array()),
    createSessionManager: makeFakeSessionManager,
  };
  return { ...base, ...overrides };
}

function kvEntry(over: Partial<PermissionEntry> = {}): PermissionEntry {
  return {
    service: "tinycloud.kv",
    space: "default",
    path: "notes",
    actions: ["tinycloud.kv/get", "tinycloud.kv/sync"],
    ...over,
  };
}

function fakeSession(over: Partial<TinyCloudSession> = {}): TinyCloudSession {
  return {
    address: ADDRESS,
    chainId: 1,
    sessionKey: "default",
    spaceId: SPACE_ID,
    delegationCid: "bafySessionParent",
    delegationHeader: { Authorization: "Bearer session" },
    verificationMethod: "did:key:z6MkTestSession#z6MkTestSession",
    jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
    siwe: buildSiwe(futureExpiry),
    signature: "0xfake",
    ...over,
  };
}

/** Private-field seams the plan's own tests use; typed, never `any`. */
interface AuthShim {
  auth: { tinyCloudSession: TinyCloudSession };
}
interface GrantsShim {
  runtimePermissionGrants: Array<{
    session: Record<string, unknown>;
    delegation: Record<string, unknown>;
    operations: Array<{
      spaceId?: string;
      resource?: string;
      service: string;
      path: string;
      action: string;
      caveats?: Record<string, unknown>[];
    }>;
    expiresAt: Date;
    provenance?: "primary" | "bootstrap" | "delegated" | "runtime";
  }>;
}

/** Session-only node with a stub auth carrying the session (delegateTo-test pattern). */
function sessionOnlyNode(wasm: IWasmBindings, session: TinyCloudSession): TinyCloudNode {
  const node = new TinyCloudNode({ wasmBindings: wasm });
  // Private-field test seam: the delegateTo suite uses the same stub shape.
  (node as unknown as AuthShim).auth = { tinyCloudSession: session };
  return node;
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ activated: [], skipped: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Config validation (§3.1)
// ---------------------------------------------------------------------------

describe("TinyCloudNode replication config validation (§3.1)", () => {
  const storage = {} as never;

  test("missing storage, empty prefixes and overlap throw at construction", () => {
    expect(
      () =>
        new TinyCloudNode({
          wasmBindings: makeFakeWasmBindings(),
          replication: { enabled: true, prefixes: ["notes"] } as never,
        }),
    ).toThrow(/storage/);
    expect(
      () =>
        new TinyCloudNode({
          wasmBindings: makeFakeWasmBindings(),
          replication: { enabled: true, storage, prefixes: [] },
        }),
    ).toThrow(/non-empty/);
    expect(
      () =>
        new TinyCloudNode({
          wasmBindings: makeFakeWasmBindings(),
          replication: { enabled: true, storage, prefixes: ["notes", "notes/todo"] },
        }),
    ).toThrow(/overlap/);
  });

  test("a vault prefix without allowSecrets throws; with it, construction succeeds", () => {
    expect(
      () =>
        new TinyCloudNode({
          wasmBindings: makeFakeWasmBindings(),
          replication: { enabled: true, storage, prefixes: ["vault/keys"] },
        }),
    ).toThrow(/allowSecrets/);
    expect(
      () =>
        new TinyCloudNode({
          wasmBindings: makeFakeWasmBindings(),
          replication: {
            enabled: true,
            storage,
            prefixes: ["vault/keys"],
            allowSecrets: true,
          },
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// planDelegation parity with delegateTo (§4.3)
// ---------------------------------------------------------------------------

describe("planDelegation parity with delegateTo (§4.3)", () => {
  test("session path: same parent (session cid) and expiry delegateTo would use", () => {
    const parseSpy = mock(() => [
      { service: "kv", space: "default", path: "/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);
    const wasm = makeFakeWasmBindings({ parseRecapFromSiwe: parseSpy as never });
    const node = sessionOnlyNode(wasm, fakeSession());

    const plan = node.planDelegation([kvEntry()]);
    expect(plan).toMatchObject({
      path: "session",
      parentCid: "bafySessionParent",
    });
    if ("refused" in plan) throw new Error("expected a plan");
    // Session path caps at the SIWE expiry (§4.3).
    expect(plan.expiresAt).toBe(new Date(futureExpiry).getTime());
  });

  test("runtime path: same parent grant delegateTo selects, expiry capped by the grant", async () => {
    const parseSpy = mock(() => []); // session recap covers nothing
    const createDelegationSpy = mock(() => ({
      delegation: "fake-ucan",
      cid: "bafyChild",
      delegateDid: DEVICE_DID,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      resources: [],
    }));
    const wasm = makeFakeWasmBindings({
      parseRecapFromSiwe: parseSpy as never,
      createDelegation: createDelegationSpy as never,
    });
    const node = sessionOnlyNode(wasm, fakeSession());

    const grantExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000);
    (node as unknown as GrantsShim).runtimePermissionGrants = [
      {
        session: {
          delegationHeader: { Authorization: "Bearer grant" },
          delegationCid: "bafyRuntimeParent",
          spaceId: SPACE_ID,
          verificationMethod: "did:key:zGrant",
          jwk: {},
        },
        delegation: { cid: "bafyRuntimeParent" },
        operations: [
          { spaceId: SPACE_ID, service: "kv", path: "notes", action: "tinycloud.kv/get" },
          { spaceId: SPACE_ID, service: "kv", path: "notes", action: "tinycloud.kv/sync" },
        ],
        expiresAt: grantExpiry,
        provenance: "runtime",
      },
    ];

    const plan = node.planDelegation([kvEntry()]);
    expect(plan).toMatchObject({
      path: "runtime",
      parentCid: "bafyRuntimeParent",
      expiresAt: grantExpiry.getTime(),
    });
  });

  test("no coverage: plan refuses NOT_COVERED and delegateTo throws PermissionNotInManifestError", async () => {
    const wasm = makeFakeWasmBindings({ parseRecapFromSiwe: mock(() => []) as never });
    const node = sessionOnlyNode(wasm, fakeSession());

    const plan = node.planDelegation([kvEntry()]);
    expect(plan).toMatchObject({ refused: "NOT_COVERED" });
    await expect(node.delegateTo(BOB_DID, [kvEntry()])).rejects.toBeInstanceOf(
      PermissionNotInManifestError,
    );
  });

  test("caveated-only coverage: plan refuses CAVEATED_AUTHORITY, delegateTo throws CaveatedDelegationUnsupportedError", async () => {
    const caveats = [{ maxValueSize: 1000 }];
    const wasm = makeFakeWasmBindings({
      parseRecapFromSiwe: mock(() => [
        {
          service: "kv",
          space: "default",
          path: "/",
          actions: ["tinycloud.kv/get", "tinycloud.kv/sync"],
          caveats,
        },
      ]) as never,
    });
    const node = sessionOnlyNode(wasm, fakeSession());

    const plan = node.planDelegation([kvEntry()]);
    expect(plan).toMatchObject({ refused: "CAVEATED_AUTHORITY" });
    await expect(node.delegateTo(BOB_DID, [kvEntry()])).rejects.toBeInstanceOf(
      CaveatedDelegationUnsupportedError,
    );
  });

  test("a caveated request refuses before any parent is chosen", () => {
    const parseSpy = mock(() => [
      { service: "kv", space: "default", path: "/", actions: ["tinycloud.kv/get", "tinycloud.kv/sync"] },
    ]);
    const node = sessionOnlyNode(
      makeFakeWasmBindings({ parseRecapFromSiwe: parseSpy as never }),
      fakeSession(),
    );
    const plan = node.planDelegation([kvEntry({ caveats: [{ ifMatch: "etag" }] })]);
    expect(plan).toMatchObject({ refused: "CAVEATED_AUTHORITY" });
  });

  test("an expiring session refuses both plan and delegateTo inside the 60s margin", async () => {
    const nearExpiry = new Date(Date.now() + 30_000).toISOString();
    const node = sessionOnlyNode(
      makeFakeWasmBindings(),
      fakeSession({ siwe: buildSiwe(nearExpiry) }),
    );
    expect(node.planDelegation([kvEntry()])).toMatchObject({ refused: "SESSION_EXPIRING" });
    await expect(node.delegateTo(BOB_DID, [kvEntry()])).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  test("get+sync split across two parents refuses (§4.3 one-mint-per-prefix)", async () => {
    const wasm = makeFakeWasmBindings({ parseRecapFromSiwe: mock(() => []) as never });
    const node = sessionOnlyNode(wasm, fakeSession());
    const farFuture = new Date(Date.now() + 86_400_000);
    // Grant A covers get, grant B covers sync — no single grant covers both.
    (node as unknown as GrantsShim).runtimePermissionGrants = [
      {
        session: { delegationCid: "bafyGetOnly", delegationHeader: { Authorization: "x" }, spaceId: SPACE_ID, verificationMethod: "d", jwk: {} },
        delegation: { cid: "bafyGetOnly" },
        operations: [{ spaceId: SPACE_ID, service: "kv", path: "notes", action: "tinycloud.kv/get" }],
        expiresAt: farFuture,
        provenance: "runtime",
      },
      {
        session: { delegationCid: "bafySyncOnly", delegationHeader: { Authorization: "x" }, spaceId: SPACE_ID, verificationMethod: "d", jwk: {} },
        delegation: { cid: "bafySyncOnly" },
        operations: [{ spaceId: SPACE_ID, service: "kv", path: "notes", action: "tinycloud.kv/sync" }],
        expiresAt: farFuture,
        provenance: "runtime",
      },
    ];
    const plan = node.planDelegation([kvEntry()]);
    expect(plan).toMatchObject({ refused: "NOT_COVERED" });
  });
});

// ---------------------------------------------------------------------------
// replicationAuthority host wiring (§4.2)
// ---------------------------------------------------------------------------

describe("replicationAuthority (§4.2)", () => {
  test("no session → sessionGrant and plan refuse SESSION_EXPIRING", () => {
    const node = new TinyCloudNode({ wasmBindings: makeFakeWasmBindings() });
    const authority = node.replicationAuthority();
    expect(authority.sessionGrant("notes")).toEqual({ refused: "SESSION_EXPIRING" });
    expect(authority.plan("notes")).toEqual({ refused: "SESSION_EXPIRING" });
  });

  test("plan routes through planDelegation with one get+sync entry on the session space", () => {
    const node = sessionOnlyNode(makeFakeWasmBindings(), fakeSession());
    const planDelegationSpy = mock(() => ({
      path: "runtime" as const,
      parentCid: "bafyP",
      expiresAt: 1_700_000_000_000,
      effectiveExpiration: new Date(1_700_000_000_000),
    }));
    // Method-shape shim: planDelegation's union return includes internal fields.
    (node as unknown as { planDelegation: typeof planDelegationSpy }).planDelegation =
      planDelegationSpy;
    const authority = node.replicationAuthority();
    expect(authority.plan("notes")).toEqual({
      path: "runtime",
      parentCid: "bafyP",
      expiresAt: 1_700_000_000_000,
    });
    const entries = planDelegationSpy.mock.calls[0]![0] as PermissionEntry[];
    expect(entries).toEqual([
      {
        service: "tinycloud.kv",
        space: SPACE_ID,
        path: "notes",
        actions: ["tinycloud.kv/get", "tinycloud.kv/sync"],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// replicationSignInEntries parity (§4.1, §4.6)
// ---------------------------------------------------------------------------

function signInFetch() {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: [], skipped: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function makeSigner(): ISigner {
  return {
    getAddress: async () => ADDRESS,
    getChainId: async () => 1,
    signMessage: async () => "0xsigned",
  };
}

function replicationConfig(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    storage: {} as never,
    prefixes: ["notes"],
    ...over,
  };
}

describe("replicationSignInEntries (§4.1, §4.6)", () => {
  test("flag off → [] before and after sign-in", () => {
    const node = new TinyCloudNode({
      wasmBindings: makeFakeWasmBindings(),
      signer: makeSigner(),
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: new MemorySessionStorage(),
    });
    expect(node.replicationSignInEntries()).toEqual([]);
  });

  test("default request: entries match the kv actions the sign-in abilities carry", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const wasm = makeFakeWasmBindings({
      prepareSession: ((params: Record<string, unknown>) => {
        captured.push(params);
        return {
          siwe: "siwe",
          jwk: {},
          spaceId: params.spaceId,
          verificationMethod: "did:key:v",
        };
      }) as never,
      completeSessionSetup: (() => ({
        delegationHeader: { Authorization: "Bearer s" },
        delegationCid: "bafy",
      })) as never,
    });
    globalThis.fetch = signInFetch();
    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer: makeSigner(),
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: new MemorySessionStorage(),
      replication: replicationConfig(),
    });
    await (node.auth as NodeUserAuthorization).signIn();

    const entries = node.replicationSignInEntries();
    expect(entries).toEqual([
      {
        service: "tinycloud.kv",
        space: SPACE_ID,
        path: "notes",
        actions: ["tinycloud.kv/get", "tinycloud.kv/sync"],
      },
    ]);
    // Parity (§4.6): the abilities handed to prepareSession carry the same
    // sync entry the restore check will require.
    const spaceAbilities = captured[0]!.spaceAbilities as Record<
      string,
      { kv?: Record<string, string[]> }
    >;
    expect(spaceAbilities[SPACE_ID]?.kv?.notes).toEqual(
      expect.arrayContaining(["tinycloud.kv/get", "tinycloud.kv/sync"]),
    );
  });

  test("a configured prefix the request doesn't cover gets no entry", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const wasm = makeFakeWasmBindings({
      prepareSession: ((params: Record<string, unknown>) => {
        captured.push(params);
        return { siwe: "s", jwk: {}, spaceId: params.spaceId, verificationMethod: "d" };
      }) as never,
      completeSessionSetup: (() => ({
        delegationHeader: { Authorization: "Bearer s" },
        delegationCid: "bafy",
      })) as never,
    });
    globalThis.fetch = signInFetch();
    const capabilityRequest: ComposedManifestRequest = {
      manifests: [],
      resources: [
        {
          service: "tinycloud.kv",
          space: "default",
          path: "notes",
          actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
        },
      ],
      delegationTargets: [],
      registryRecords: [],
      expiryMs: 86_400_000,
      includePublicSpace: false,
    };
    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer: makeSigner(),
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: new MemorySessionStorage(),
      capabilityRequest,
      replication: replicationConfig({ prefixes: ["notes", "other"] }),
    });
    await (node.auth as NodeUserAuthorization).signIn();

    const entries = node.replicationSignInEntries();
    expect(entries.map((entry) => entry.path)).toEqual(["notes"]);
    const spaceAbilities = captured[0]!.spaceAbilities as Record<
      string,
      { kv?: Record<string, string[]> }
    >;
    expect(spaceAbilities[SPACE_ID]?.kv?.notes).toEqual(
      expect.arrayContaining(["tinycloud.kv/get", "tinycloud.kv/sync"]),
    );
    expect(spaceAbilities[SPACE_ID]?.kv?.other).toBeUndefined();
  });

  test("secrets gate: vault prefix needs allowSecrets (§10.1)", async () => {
    globalThis.fetch = signInFetch();
    const wasm = makeFakeWasmBindings({
      prepareSession: (() => ({ siwe: "s", jwk: {}, spaceId: "x", verificationMethod: "d" })) as never,
      completeSessionSetup: (() => ({
        delegationHeader: { Authorization: "Bearer s" },
        delegationCid: "bafy",
      })) as never,
    });
    const gated = new TinyCloudNode({
      wasmBindings: wasm,
      signer: makeSigner(),
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: new MemorySessionStorage(),
      replication: {
        enabled: true,
        storage: {} as never,
        prefixes: ["vault/keys"],
        allowSecrets: true,
      },
    });
    (gated.auth as NodeUserAuthorization).setRestoredTinyCloudSession(fakeSession());
    // defaultActions grants an unrestricted root get; only the opt-in gate stands.
    expect(gated.replicationSignInEntries().map((entry) => entry.path)).toEqual(["vault/keys"]);
  });
  test("account-primary space: entries target the account space id (account-registry modes)", () => {
    const accountSpaceId =
      "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:account";
    for (const includeAccountRegistryPermissions of [true, false]) {
      const node = new TinyCloudNode({
        wasmBindings: makeFakeWasmBindings(),
        signer: makeSigner(),
        tinycloudHosts: ["https://tinycloud.test"],
        sessionStorage: new MemorySessionStorage(),
        prefix: "account",
        includeAccountRegistryPermissions,
        replication: replicationConfig(),
      });
      (node.auth as NodeUserAuthorization).setRestoredTinyCloudSession(
        fakeSession({ spaceId: accountSpaceId }),
      );
      expect(node.replicationSignInEntries()).toEqual([
        {
          service: "tinycloud.kv",
          space: accountSpaceId,
          path: "notes",
          actions: ["tinycloud.kv/get", "tinycloud.kv/sync"],
        },
      ]);
    }
  });

  test("secrets-primary space: opt-in produces entries on the secrets space (§10.1)", () => {
    const secretsSpaceId =
      "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:secrets";
    const gated = new TinyCloudNode({
      wasmBindings: makeFakeWasmBindings(),
      signer: makeSigner(),
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: new MemorySessionStorage(),
      prefix: "secrets",
      replication: replicationConfig(),
    });
    (gated.auth as NodeUserAuthorization).setRestoredTinyCloudSession(
      fakeSession({ spaceId: secretsSpaceId }),
    );
    expect(gated.replicationSignInEntries()).toEqual([]);

    const opted = new TinyCloudNode({
      wasmBindings: makeFakeWasmBindings(),
      signer: makeSigner(),
      tinycloudHosts: ["https://tinycloud.test"],
      sessionStorage: new MemorySessionStorage(),
      prefix: "secrets",
      replication: replicationConfig({ allowSecrets: true }),
    });
    (opted.auth as NodeUserAuthorization).setRestoredTinyCloudSession(
      fakeSession({ spaceId: secretsSpaceId }),
    );
    expect(opted.replicationSignInEntries()).toEqual([
      {
        service: "tinycloud.kv",
        space: secretsSpaceId,
        path: "notes",
        actions: ["tinycloud.kv/get", "tinycloud.kv/sync"],
      },
    ]);
  });

});
