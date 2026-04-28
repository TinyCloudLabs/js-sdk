/**
 * Unit tests for manifest-driven `signIn`.
 *
 * The headline behavior we're verifying: when a manifest is passed in
 * the TinyCloudNode config, `signIn()` resolves it via
 * `resolveManifest` + `manifestAbilitiesUnion` and uses the resulting
 * abilities map as the SIWE recap — instead of the legacy
 * `defaultActions` table.
 *
 * Coverage:
 * - Manifest with own permissions only → recap reflects those entries
 * - Manifest with `delegations[]` → recap covers BOTH the app's caps
 *   AND every delegation target's permissions (the union)
 * - No manifest installed → falls back to `defaultActions` (legacy)
 * - Manifest installed via `setManifest()` post-construction takes
 *   effect on the next signIn
 *
 * The WASM `prepareSession` call is mocked so we can inspect the
 * `abilities` argument directly without standing up a real session.
 */

import { describe, expect, mock, test } from "bun:test";

import {
  type IWasmBindings,
  type ISessionManager,
  type Manifest,
} from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

// ---------------------------------------------------------------------------
// Test fixtures (subset of delegateTo.test.ts; intentionally duplicated to
// keep this file self-contained and easy to read in isolation)
// ---------------------------------------------------------------------------

function makeFakeSessionManager(): ISessionManager {
  // Pre-seed with "default" since that's the key name the
  // TinyCloudNode constructor uses on the WASM side; the real
  // WASM session manager creates it eagerly. Without this, signIn's
  // `renameSessionKeyId("default", keyId)` is a no-op and the
  // subsequent `jwk(keyId)` returns undefined → "Failed to create
  // session key" error.
  const keys = new Set<string>(["default"]);
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
      if (!keys.has(keyId)) return undefined;
      return JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" });
    },
  };
}

function makeFakeWasmBindings(
  overrides: Partial<IWasmBindings> = {},
): IWasmBindings {
  const base: IWasmBindings = {
    invoke: mock(() => Promise.resolve({} as any)) as any,
    invokeAny: mock(() => Promise.resolve({} as any)) as any,
    prepareSession: mock(() => ({
      siwe: "fake-siwe",
      jwk: { kty: "OKP" },
      spaceId: "space://test",
      verificationMethod: "did:key:z6MkTestSession",
    })),
    completeSessionSetup: mock(() => ({
      delegationHeader: { Authorization: "Bearer fake" },
      delegationCid: "bafyfake",
      jwk: { kty: "OKP" },
      spaceId: "space://test",
      verificationMethod: "did:key:z6MkTestSession",
    })),
    ensureEip55: (a: string) => a,
    makeSpaceId: (a: string, c: number, p: string) => `tinycloud:pkh:eip155:${c}:${a}:${p}`,
    createDelegation: mock(() => ({})),
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
 * Build a TinyCloudNode wired to a fake signer + the supplied wasm.
 *
 * The signer is the minimal duck-typed shape NodeUserAuthorization.signIn
 * needs: getAddress, getChainId, signMessage. We don't reach the network
 * calls (checkNodeInfo, ensureSpaceExists) because we override those via
 * monkey-patching the auth instance after construction.
 */
function makeNodeWithSigner(
  wasm: IWasmBindings,
  config: Partial<ConstructorParameters<typeof TinyCloudNode>[0]> = {},
): TinyCloudNode {
  const fakeSigner = {
    signMessage: async () => "0x" + "ff".repeat(65),
    getAddress: async () => "0x0000000000000000000000000000000000000001",
    getChainId: async () => 1,
  };
  return new TinyCloudNode({
    wasmBindings: wasm,
    signer: fakeSigner as any,
    host: "https://tinycloud.test",
    ...config,
  });
}

async function withFetchResponses(
  responses: Response[],
  fn: (fetchMock: any) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected fetch");
    }
    return response;
  });

  globalThis.fetch = fetchMock as any;
  try {
    await fn(fetchMock);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * Stub out the post-prepareSession network calls so signIn can complete
 * without contacting a real server. We monkey-patch the inner auth
 * handler's methods directly because they're not part of any public
 * interface — this is a unit test, not an integration test.
 */
function stubAuthNetworkCalls(node: TinyCloudNode): void {
  const auth = (node as any).auth;
  if (!auth) throw new Error("expected auth handler to be present");
  // checkNodeInfo is imported at module level inside NodeUserAuthorization;
  // we can't easily replace it. Instead we replace the methods that wrap
  // it: ensureSpaceExists is the post-signIn hook, and the import call
  // happens via `checkNodeInfo(this.tinycloudHosts[0], ...)` which we
  // intercept by overriding the `tinycloudHosts` array via reflection.
  // Simpler: replace `signIn` with a thin wrapper that catches the
  // post-prepareSession network errors. But the cleanest approach is
  // to mock the global fetch the WASM/server layer uses.
  //
  // Replace ensureSpaceExists with a no-op so we don't hit
  // activateSessionWithHost. checkNodeInfo is already mockable via the
  // global fetch which Bun's test runner doesn't intercept by default.
  // We'll instead just stub the entire auth.ensureSpaceExists.
  auth.ensureSpaceExists = async () => {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TinyCloudNode.signIn — manifest-driven recap", () => {
  test("no manifest → uses defaultActions (legacy fallback)", async () => {
    const prepareSessionSpy = mock((cfg: any) => ({
      siwe: "fake-siwe",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: "did:key:z6MkTestSession",
    }));
    const wasm = makeFakeWasmBindings({
      prepareSession: prepareSessionSpy as any,
    });

    const node = makeNodeWithSigner(wasm);
    stubAuthNetworkCalls(node);

    // Replace checkNodeInfo via the global fetch — the simplest path
    // is to override the prototype method on the auth handler.
    const auth = (node as any).auth;
    const originalSignIn = auth.signIn.bind(auth);
    auth.signIn = async () => {
      // Reach into the auth's `wasm.prepareSession` path by simulating
      // just the part we need to assert: call signIn but stub out the
      // network bits via a try/catch that swallows the post-prepareSession
      // errors. We rebuild the assertions on the prepareSession spy.
      try {
        return await originalSignIn();
      } catch {
        // checkNodeInfo network failure is expected in unit-test mode;
        // we already captured what we care about via prepareSessionSpy.
        return undefined as any;
      }
    };

    await auth.signIn();

    expect(prepareSessionSpy).toHaveBeenCalled();
    const cfg = (prepareSessionSpy as any).mock.calls[0][0];
    // defaultActions table: kv/sql/duckdb/capabilities/hooks under "" path
    expect(cfg.abilities).toBeDefined();
    expect(Object.keys(cfg.abilities).sort()).toEqual([
      "capabilities",
      "duckdb",
      "hooks",
      "kv",
      "sql",
    ]);
    // Empty path means "no path segment" — same convention as the
    // legacy default table.
    expect(cfg.abilities.kv).toHaveProperty("");
    expect(cfg.abilities.kv[""]).toContain("tinycloud.kv/get");
  });

  test("manifest with app permissions → recap reflects manifest", async () => {
    const prepareSessionSpy = mock((cfg: any) => ({
      siwe: "fake-siwe",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: "did:key:z6MkTestSession",
    }));
    const wasm = makeFakeWasmBindings({
      prepareSession: prepareSessionSpy as any,
    });

    const manifest: Manifest = {
      app_id: "com.listen.app",
      name: "Listen",
      // Standard tier defaults: kv/sql/capabilities under the
      // manifest prefix. No DuckDB. No hooks.
      defaults: true,
    };

    const node = makeNodeWithSigner(wasm, {
      manifest,
      includeAccountRegistryPermissions: false,
    });
    stubAuthNetworkCalls(node);

    const auth = (node as any).auth;
    try {
      await auth.signIn();
    } catch {
      /* checkNodeInfo network call expected to fail in unit-test mode */
    }

    expect(prepareSessionSpy).toHaveBeenCalled();
    const cfg = (prepareSessionSpy as any).mock.calls[0][0];
    expect(cfg.spaceId).toBe(
      "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications",
    );

    // Manifest standard tier produces kv + sql + capabilities entries,
    // each scoped to the manifest prefix path "com.listen.app/".
    // No DuckDB (only "all" tier includes it). No hooks (not in defaults).
    expect(Object.keys(cfg.abilities).sort()).toEqual([
      "capabilities",
      "kv",
      "sql",
    ]);
    expect(cfg.abilities.kv).toEqual({
      "com.listen.app/": [
        "tinycloud.kv/get",
        "tinycloud.kv/put",
        "tinycloud.kv/del",
        "tinycloud.kv/list",
        "tinycloud.kv/metadata",
      ],
    });
    expect(cfg.abilities.sql).toEqual({
      "com.listen.app/": ["tinycloud.sql/read", "tinycloud.sql/write"],
    });
    expect(cfg.abilities.capabilities).toEqual({
      "com.listen.app/": ["tinycloud.capabilities/read"],
    });
  });

  test("manifest sign-in includes account registry permission by default", async () => {
    const prepareSessionSpy = mock((cfg: any) => ({
      siwe: "fake-siwe",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: "did:key:z6MkTestSession",
    }));
    const wasm = makeFakeWasmBindings({
      prepareSession: prepareSessionSpy as any,
    });

    const node = makeNodeWithSigner(wasm, {
      manifest: {
        app_id: "com.listen.app",
        name: "Listen",
        defaults: false,
      },
    });
    stubAuthNetworkCalls(node);

    const auth = (node as any).auth;
    try {
      await auth.signIn();
    } catch {
      /* network failure expected */
    }

    const cfg = (prepareSessionSpy as any).mock.calls[0][0];
    expect(cfg.spaceAbilities).toEqual({
      "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:account": {
        kv: {
          "applications/": [
            "tinycloud.kv/get",
            "tinycloud.kv/put",
            "tinycloud.kv/list",
          ],
        },
      },
    });
  });

  test("manifest registry write does not re-host existing account space", async () => {
    const node = makeNodeWithSigner(makeFakeWasmBindings());
    const auth = (node as any).auth;
    auth._tinyCloudSession = {
      delegationHeader: { Authorization: "Bearer fake" },
    };
    auth.hostOwnedSpace = mock(async () => true);

    await withFetchResponses(
      [
        new Response(JSON.stringify({ activated: ["space://test"], skipped: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ],
      async () => {
        await (node as any).ensureOwnedSpaceHosted(
          "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:account",
        );
      },
    );

    expect(auth.hostOwnedSpace).not.toHaveBeenCalled();
  });

  test("manifest registry write hosts account space only when activation skips it", async () => {
    const accountSpaceId =
      "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:account";
    const node = makeNodeWithSigner(makeFakeWasmBindings());
    const auth = (node as any).auth;
    auth._tinyCloudSession = {
      delegationHeader: { Authorization: "Bearer fake" },
    };
    auth.hostOwnedSpace = mock(async () => true);

    await withFetchResponses(
      [
        new Response(JSON.stringify({ activated: [], skipped: [accountSpaceId] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        new Response(JSON.stringify({ activated: [accountSpaceId], skipped: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ],
      async () => {
        await (node as any).ensureOwnedSpaceHosted(accountSpaceId);
      },
    );

    expect(auth.hostOwnedSpace).toHaveBeenCalledTimes(1);
    expect(auth.hostOwnedSpace).toHaveBeenCalledWith(accountSpaceId);
  });

  test("multiple manifests → recap unions app caps + delegation caps", async () => {
    // This is the headline test for the listen use case: an app
    // declares its own permissions AND a backend delegation target,
    // and the resulting SIWE recap covers both so the session key
    // can later issue the backend delegation without a wallet
    // prompt.
    const prepareSessionSpy = mock((cfg: any) => ({
      siwe: "fake-siwe",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: "did:key:z6MkTestSession",
    }));
    const wasm = makeFakeWasmBindings({
      prepareSession: prepareSessionSpy as any,
    });

    const appManifest: Manifest = {
      app_id: "com.listen.app",
      name: "Listen",
      // App-side: only KV (turn off the broader defaults table).
      defaults: false,
      permissions: [
        {
          service: "tinycloud.kv",
          path: "/",
          actions: ["get", "put"],
        },
      ],
    };
    const backendManifest: Manifest = {
      app_id: "com.listen.app",
      name: "Listen Backend",
      did: "did:pkh:eip155:1:0xBACKEND00000000000000000000000000000000",
      defaults: false,
      permissions: [
        {
          service: "tinycloud.sql",
          path: "data.sqlite",
          actions: ["read", "write"],
        },
      ],
    };

    const node = makeNodeWithSigner(wasm, {
      manifest: [appManifest, backendManifest],
      includeAccountRegistryPermissions: false,
    });
    stubAuthNetworkCalls(node);

    const auth = (node as any).auth;
    try {
      await auth.signIn();
    } catch {
      /* network failure expected */
    }

    expect(prepareSessionSpy).toHaveBeenCalled();
    const cfg = (prepareSessionSpy as any).mock.calls[0][0];

    // The recap union must contain BOTH services. KV from the app's
    // own permissions; SQL from the delegation's permissions.
    expect(Object.keys(cfg.abilities).sort()).toEqual(["kv", "sql"]);

    // KV path inherits the manifest prefix.
    expect(cfg.abilities.kv).toEqual({
      "com.listen.app/": ["tinycloud.kv/get", "tinycloud.kv/put"],
    });

    // SQL path also inherits the manifest prefix —
    // "data.sqlite" → "com.listen.app/data.sqlite". This is the
    // test that proves the delegation's permissions go through the
    // same prefix-application logic as the app's own.
    expect(cfg.abilities.sql).toEqual({
      "com.listen.app/data.sqlite": ["tinycloud.sql/read", "tinycloud.sql/write"],
    });
  });

  test("setManifest() post-construction takes effect on next signIn", async () => {
    const prepareSessionSpy = mock((cfg: any) => ({
      siwe: "fake-siwe",
      jwk: cfg.jwk,
      spaceId: cfg.spaceId,
      verificationMethod: "did:key:z6MkTestSession",
    }));
    const wasm = makeFakeWasmBindings({
      prepareSession: prepareSessionSpy as any,
    });

    // Construct without a manifest, then install one and confirm the
    // installed manifest drives the next signIn's recap.
    const node = makeNodeWithSigner(wasm);
    stubAuthNetworkCalls(node);

    node.setManifest({
      app_id: "com.demo.app",
      name: "Demo",
      defaults: false,
      permissions: [
        {
          service: "tinycloud.kv",
          space: "default",
          path: "config",
          actions: ["get"],
        },
      ],
    });

    const auth = (node as any).auth;
    try {
      await auth.signIn();
    } catch {
      /* network failure expected */
    }

    expect(prepareSessionSpy).toHaveBeenCalled();
    const cfg = (prepareSessionSpy as any).mock.calls[0][0];
    expect(cfg.abilities).toEqual({
      kv: {
        "com.demo.app/config": ["tinycloud.kv/get"],
      },
    });
  });
});
