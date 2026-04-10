/**
 * Unit tests for {@link TinyCloudNode.delegateTo}.
 *
 * These tests stand up a TinyCloudNode in session-only mode with a fully
 * mocked {@link IWasmBindings} so no real WASM is loaded and no server is
 * contacted. A fake `tinyCloudSession` is attached directly to the
 * internal auth shim so we can exercise the subset-check / wallet-path /
 * expiry-check branches in isolation.
 */

import { describe, expect, mock, test } from "bun:test";

import {
  PermissionNotInManifestError,
  SessionExpiredError,
  type PermissionEntry,
  type IWasmBindings,
  type ISessionManager,
} from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a signed SIWE message string with a specific `Expiration Time`.
 * Mirrors the fixture helper in delegateToHelpers.test.ts so both tests
 * avoid depending on siwe-library output formatting.
 */
function buildSiwe(expirationTime: string | null): string {
  const lines = [
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
  ];
  if (expirationTime !== null) {
    lines.push(`Expiration Time: ${expirationTime}`);
  }
  return lines.join("\n");
}

/**
 * Fake ISessionManager — enough for TinyCloudNode's constructor.
 *
 * The real WASM `TCWSessionManager.createSessionKey(id)` returns the same
 * `id` back (the id is the caller-provided handle), and `jwk(id)` /
 * `getDID(id)` are keyed off that id. The constructor code path is:
 *
 *   this.sessionKeyId = sessionManager.createSessionKey("default");
 *   jwkStr = sessionManager.jwk(this.sessionKeyId);
 *
 * so our fake returns the id from createSessionKey, not a DID.
 */
function makeFakeSessionManager(): ISessionManager {
  const keys = new Set<string>();
  return {
    createSessionKey(id: string): string {
      keys.add(id);
      return id;
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

/**
 * A mocked IWasmBindings. Test callers override specific fields via the
 * `overrides` param — we provide no-op defaults for everything the
 * TinyCloudNode constructor touches.
 */
function makeFakeWasmBindings(
  overrides: Partial<IWasmBindings> = {},
): IWasmBindings {
  const base: IWasmBindings = {
    invoke: mock(() => Promise.resolve({} as any)) as any,
    invokeAny: mock(() => Promise.resolve({} as any)) as any,
    prepareSession: mock(() => ({})),
    completeSessionSetup: mock(() => ({})),
    ensureEip55: (a: string) => a,
    makeSpaceId: (a: string, c: number, p: string) => `space://${a}:${c}:${p}`,
    createDelegation: mock(() => ({
      delegation: "fake-serialized-delegation",
      cid: "bafyfake",
      delegateDid: "did:pkh:eip155:1:0xDEAD",
      expiry: Math.floor(Date.now() / 1000) + 3600,
      resources: [
        {
          service: "kv",
          space: "space://test",
          path: "items/",
          actions: ["tinycloud.kv/get"],
        },
      ],
    })),
    parseRecapFromSiwe: mock(() => [] as any[]),
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

/**
 * Install a fake session on a newly-constructed session-only TinyCloudNode
 * so delegateTo can reach it via `this.auth?.tinyCloudSession`. The node
 * starts session-only (no signer), so `this.auth` is null; we assign a
 * minimal duck-typed stub that matches the `auth` shape delegateTo reads.
 */
function installFakeSession(
  node: TinyCloudNode,
  opts: {
    siwe: string;
    spaceId?: string;
    address?: string;
    chainId?: number;
  },
): void {
  const fakeSession = {
    address: opts.address ?? "0x0000000000000000000000000000000000000001",
    chainId: opts.chainId ?? 1,
    sessionKey: "default",
    spaceId: opts.spaceId ?? "space://test",
    delegationCid: "bafyparent",
    delegationHeader: { Authorization: "Bearer parent" },
    verificationMethod: "did:key:z6MkTestSession",
    jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
    siwe: opts.siwe,
    signature: "0xfake",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (node as any).auth = { tinyCloudSession: fakeSession };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TinyCloudNode.delegateTo", () => {
  const ALICE_DID = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
  const BOB_DID = "did:pkh:eip155:1:0x00000000000000000000000000000000000000BB";

  const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  test("no session → SessionExpiredError with epoch", async () => {
    const wasm = makeFakeWasmBindings();
    const node = new TinyCloudNode({ wasmBindings: wasm });
    // Leave `auth` null — session-only with no attached session.

    await expect(
      node.delegateTo(BOB_DID, [
        {
          service: "tinycloud.kv",
          space: "default",
          path: "items/",
          actions: ["tinycloud.kv/get"],
        },
      ]),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  test("expired session → SessionExpiredError with the expired date", async () => {
    const wasm = makeFakeWasmBindings();
    const node = new TinyCloudNode({ wasmBindings: wasm });
    // Expiry in the past — clearly expired, well outside the 60s margin.
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    installFakeSession(node, { siwe: buildSiwe(pastIso) });

    await expect(
      node.delegateTo(BOB_DID, [
        {
          service: "tinycloud.kv",
          space: "default",
          path: "items/",
          actions: ["tinycloud.kv/get"],
        },
      ]),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  test("subset match → WASM path, no wallet prompt (prompted=false)", async () => {
    // parseRecapFromSiwe returns the granted set (entire KV space); the
    // test asserts delegateTo never touches prepareSession or the signer.
    const grantedRaw = [
      {
        service: "kv", // short form — parseRecapCapabilities normalizes
        space: "default",
        path: "/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
    ];

    const parseSpy = mock(() => grantedRaw);
    const createDelegationSpy = mock(() => ({
      delegation: "fake-ucan-delegation",
      cid: "bafyfakeucan",
      delegateDid: BOB_DID,
      expiry: Math.floor((Date.now() + 3600_000) / 1000),
      resources: [
        {
          service: "kv",
          space: "space://test",
          path: "items/",
          actions: ["tinycloud.kv/get"],
        },
      ],
    }));
    const prepareSessionSpy = mock(() => ({}));

    const wasm = makeFakeWasmBindings({
      parseRecapFromSiwe: parseSpy as any,
      createDelegation: createDelegationSpy as any,
      prepareSession: prepareSessionSpy as any,
    });

    const node = new TinyCloudNode({ wasmBindings: wasm });
    installFakeSession(node, { siwe: buildSiwe(futureExpiry) });

    const result = await node.delegateTo(BOB_DID, [
      {
        service: "tinycloud.kv",
        space: "default",
        path: "items/",
        actions: ["tinycloud.kv/get"],
      },
    ]);

    expect(result.prompted).toBe(false);
    expect(result.delegation.delegateDID).toBe(BOB_DID);
    // WASM path was used.
    expect(createDelegationSpy).toHaveBeenCalledTimes(1);
    // Wallet path was NOT used.
    expect(prepareSessionSpy).not.toHaveBeenCalled();
  });

  test("missing caps → PermissionNotInManifestError, no WASM or wallet call", async () => {
    // Granted set covers kv/get only. Requesting kv/put should miss.
    const parseSpy = mock(() => [
      {
        service: "kv",
        space: "default",
        path: "/",
        actions: ["tinycloud.kv/get"],
      },
    ]);
    const createDelegationSpy = mock(() => ({}));
    const prepareSessionSpy = mock(() => ({}));

    const wasm = makeFakeWasmBindings({
      parseRecapFromSiwe: parseSpy as any,
      createDelegation: createDelegationSpy as any,
      prepareSession: prepareSessionSpy as any,
    });

    const node = new TinyCloudNode({ wasmBindings: wasm });
    installFakeSession(node, { siwe: buildSiwe(futureExpiry) });

    await expect(
      node.delegateTo(BOB_DID, [
        {
          service: "tinycloud.kv",
          space: "default",
          path: "items/",
          actions: ["tinycloud.kv/put"],
        },
      ]),
    ).rejects.toBeInstanceOf(PermissionNotInManifestError);

    expect(createDelegationSpy).not.toHaveBeenCalled();
    expect(prepareSessionSpy).not.toHaveBeenCalled();
  });

  test("multi-entry input → ONE UCAN with merged abilities map", async () => {
    // Multi-entry delegation is now first-class: the SDK folds every
    // (service, path, actions) tuple into a single abilities map and
    // calls WASM createDelegation once. The resulting PortableDelegation
    // is a single signed blob whose `.resources` array lists every
    // grant. This is the core fix that lets listen-style apps
    // pre-declare backend delegations across KV + SQL in one
    // manifest and have them issue from the session key in a single
    // wallet-prompt-free operation.
    const grantedRaw = [
      {
        // KV actions granted on the app prefix
        service: "kv",
        space: "default",
        path: "com.listen.app/",
        actions: [
          "tinycloud.kv/get",
          "tinycloud.kv/put",
          "tinycloud.kv/del",
          "tinycloud.kv/list",
          "tinycloud.kv/metadata",
        ],
      },
      {
        // SQL actions granted on the app's database file
        service: "sql",
        space: "default",
        path: "com.listen.app/data.sqlite",
        actions: ["tinycloud.sql/read", "tinycloud.sql/write"],
      },
    ];

    const parseSpy = mock(() => grantedRaw);
    const createDelegationSpy = mock(() => ({
      delegation: "fake-multi-resource-ucan",
      cid: "bafymulti",
      delegateDid: BOB_DID,
      expiry: Math.floor((Date.now() + 3600_000) / 1000),
      // Rust emits sorted by (service, path); for these entries kv < sql.
      resources: [
        {
          service: "kv",
          space: "space://test",
          path: "com.listen.app/",
          actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
        },
        {
          service: "sql",
          space: "space://test",
          path: "com.listen.app/data.sqlite",
          actions: ["tinycloud.sql/read"],
        },
      ],
    }));
    const prepareSessionSpy = mock(() => ({}));

    const wasm = makeFakeWasmBindings({
      parseRecapFromSiwe: parseSpy as any,
      createDelegation: createDelegationSpy as any,
      prepareSession: prepareSessionSpy as any,
    });

    const node = new TinyCloudNode({ wasmBindings: wasm });
    installFakeSession(node, { siwe: buildSiwe(futureExpiry) });

    const entries: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "default",
        path: "com.listen.app/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
      {
        service: "tinycloud.sql",
        space: "default",
        path: "com.listen.app/data.sqlite",
        actions: ["tinycloud.sql/read"],
      },
    ];

    const result = await node.delegateTo(BOB_DID, entries);

    expect(result.prompted).toBe(false);
    expect(result.delegation.delegateDID).toBe(BOB_DID);
    // Flat path/actions mirror the first (sorted) resource
    expect(result.delegation.path).toBe("com.listen.app/");
    expect(result.delegation.actions).toEqual([
      "tinycloud.kv/get",
      "tinycloud.kv/put",
    ]);
    // The full multi-resource breakdown is available for consumers
    // that need it.
    expect(result.delegation.resources).toEqual([
      {
        service: "kv",
        space: "space://test",
        path: "com.listen.app/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
      {
        service: "sql",
        space: "space://test",
        path: "com.listen.app/data.sqlite",
        actions: ["tinycloud.sql/read"],
      },
    ]);
    // Exactly ONE underlying WASM call for the entire multi-entry
    // request — not N.
    expect(createDelegationSpy).toHaveBeenCalledTimes(1);
    expect(prepareSessionSpy).not.toHaveBeenCalled();

    // Sanity: the abilities map we passed to WASM has both services
    // grouped correctly. createDelegation is mocked so we can inspect
    // call.mock.calls for the actual shape.
    const call = (createDelegationSpy as any).mock.calls[0];
    // call = [session, delegateDID, spaceId, abilities, expirationSecs, notBeforeSecs]
    const abilitiesSent = call[3];
    expect(abilitiesSent).toEqual({
      kv: {
        "com.listen.app/": ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
      sql: {
        "com.listen.app/data.sqlite": ["tinycloud.sql/read"],
      },
    });
  });

  test("multi-entry with one missing cap → PermissionNotInManifestError surfaces ALL missing", async () => {
    // One entry is a subset; the other is NOT. delegateTo must reject
    // the whole call, not partially issue — partial issuance would
    // produce a delegation the caller didn't ask for.
    const parseSpy = mock(() => [
      {
        service: "kv",
        space: "default",
        path: "/",
        actions: ["tinycloud.kv/get"],
      },
    ]);
    const createDelegationSpy = mock(() => ({}));

    const wasm = makeFakeWasmBindings({
      parseRecapFromSiwe: parseSpy as any,
      createDelegation: createDelegationSpy as any,
    });

    const node = new TinyCloudNode({ wasmBindings: wasm });
    installFakeSession(node, { siwe: buildSiwe(futureExpiry) });

    const entries: PermissionEntry[] = [
      {
        service: "tinycloud.kv",
        space: "default",
        path: "items/",
        actions: ["tinycloud.kv/get"], // covered
      },
      {
        service: "tinycloud.sql",
        space: "default",
        path: "/",
        actions: ["tinycloud.sql/read"], // NOT covered
      },
    ];

    await expect(node.delegateTo(BOB_DID, entries)).rejects.toBeInstanceOf(
      PermissionNotInManifestError,
    );
    expect(createDelegationSpy).not.toHaveBeenCalled();
  });

  test("empty permissions array throws", async () => {
    const wasm = makeFakeWasmBindings();
    const node = new TinyCloudNode({ wasmBindings: wasm });
    installFakeSession(node, { siwe: buildSiwe(futureExpiry) });

    await expect(node.delegateTo(BOB_DID, [])).rejects.toThrow(
      /non-empty permissions array/,
    );
  });

  test("forceWalletSign: true bypasses derivability check", async () => {
    // No signer on the node → the wallet path will fail, but before it
    // does we can assert the derivability check never fired. This is the
    // cleanest way to verify the branch without mocking the full wallet
    // activation stack (SIWE sign + activateSessionWithHost network call).
    const parseSpy = mock(() => [
      // Granting the full KV space — derivable, so the non-forced path
      // would absolutely take the WASM route. forceWalletSign should
      // still short-circuit past this.
      {
        service: "kv",
        space: "default",
        path: "/",
        actions: ["tinycloud.kv/get"],
      },
    ]);
    const createDelegationSpy = mock(() => ({
      delegation: "fake",
      cid: "bafy",
      delegateDid: BOB_DID,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      resources: [
        {
          service: "kv",
          space: "space://test",
          path: "items/",
          actions: ["tinycloud.kv/get"],
        },
      ],
    }));

    const wasm = makeFakeWasmBindings({
      parseRecapFromSiwe: parseSpy as any,
      createDelegation: createDelegationSpy as any,
    });

    const node = new TinyCloudNode({ wasmBindings: wasm });
    installFakeSession(node, { siwe: buildSiwe(futureExpiry) });

    // Wallet path will fail at the session-only guard inside
    // createDelegationWalletPath ("Cannot createDelegation() in session-
    // only mode. Requires wallet mode."), which proves the forced path
    // was taken.
    await expect(
      node.delegateTo(
        BOB_DID,
        [
          {
            service: "tinycloud.kv",
            space: "default",
            path: "items/",
            actions: ["tinycloud.kv/get"],
          },
        ],
        { forceWalletSign: true },
      ),
    ).rejects.toThrow(/session-only mode/);

    // Derivability was never checked (parseRecapFromSiwe not called) and
    // WASM createDelegation was not called either — we went straight to
    // the wallet path.
    expect(parseSpy).not.toHaveBeenCalled();
    expect(createDelegationSpy).not.toHaveBeenCalled();
  });

  test("legacy createDelegation: derivable caps route through delegateTo fast path", async () => {
    // Construct a session-only node, install a session granting full KV
    // access, and call the legacy createDelegation method with a single
    // service request. It should go through delegateTo → WASM path,
    // returning a PortableDelegation without ever touching the wallet
    // path (which would throw "session-only mode").
    const parseSpy = mock(() => [
      {
        service: "kv",
        space: "default",
        path: "/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
    ]);
    const createDelegationSpy = mock(() => ({
      delegation: "fake-legacy-routed",
      cid: "bafylegacy",
      delegateDid: BOB_DID,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      resources: [
        {
          service: "kv",
          space: "space://test",
          path: "items/",
          actions: ["tinycloud.kv/get"],
        },
      ],
    }));

    const wasm = makeFakeWasmBindings({
      parseRecapFromSiwe: parseSpy as any,
      createDelegation: createDelegationSpy as any,
    });

    const node = new TinyCloudNode({ wasmBindings: wasm });
    installFakeSession(node, { siwe: buildSiwe(futureExpiry) });

    // Legacy method bails in session-only mode before any routing, so we
    // simulate the "signer present" state by attaching a minimal stub.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (node as any).signer = {
      signMessage: async () => "0xfake",
      getAddress: async () => "0x0000000000000000000000000000000000000001",
      getChainId: async () => 1,
    };

    const result = await node.createDelegation({
      path: "items/",
      actions: ["tinycloud.kv/get"],
      delegateDID: BOB_DID,
    });

    expect(result.delegateDID).toBe(BOB_DID);
    // Subset check happened and WASM path was taken.
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(createDelegationSpy).toHaveBeenCalledTimes(1);
  });
});
