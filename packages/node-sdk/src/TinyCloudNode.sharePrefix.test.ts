/*
 * Sign-in accepts only `decrypt` on the CURRENT owner's default-network `share/` prefix: `NodeUserAuthorization` builds the recap's raw
 * abilities and refuses every other encryption entry that is not a whole network ("named keys go in manifest.keys"), `key.create` included.
 * The fake WASM `prepareSession` records the abilities. (Helpers are duplicated from TinyCloudNode.signInManifest.test.ts so this file stands alone.)
 */

import { describe, expect, mock, test } from "bun:test";

import { type IWasmBindings, type ISessionManager } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";
import { unregisteredLocationRegistryResponse } from "./test-support/unregistered-location-registry";

const REGISTRY_ORIGIN = "https://registry.share-prefix-key.test";

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
    replaceSessionKey(_jwk: object, keyId: string): string {
      keys.add(keyId);
      return keyId;
    },
    renameSessionKeyId(oldId: string, newId: string): void {
      if (!keys.has(oldId)) throw new Error(`Key ${oldId} does not exist.`);
      keys.delete(oldId);
      keys.add(newId);
    },
    getDID(keyId: string): string {
      if (!keys.has(keyId)) throw new Error(`Key ${keyId} does not exist.`);
      return `did:key:z6MkTest-${keyId}`;
    },
    jwk(keyId: string): string | undefined {
      if (!keys.has(keyId)) return undefined;
      return JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" });
    },
  };
}

// Each fake WASM-bindings instance gets a unique, file-scoped activation
// delegation header (`Bearer sharePrefixKeyCreate-<n>`) instead of a constant
// "Bearer fake". The prefix is file-specific — not just "fake-N" — so it
// can't collide with another test file's own counter if bun ever runs
// multiple files in one process. Per-instance uniqueness makes cross-test
// single-flight joins in `activateSessionWithHost`
// (sdk-core/src/space.ts, keyed on host + the full delegation header)
// impossible for this file's sessions: two different headers can never
// coalesce into the same in-flight request. See TC-372.
let sharePrefixKeyCreateAuthorizationSeq = 0;

// Tracks the activation Authorization header each fake bindings instance
// will present, so `withFetchResponses` can confirm an incoming
// `POST .../delegate` actually belongs to the test that installed the
// current fetch mock — not a same-shaped request leaked from an earlier
// test's detached account-registry-sync retry.
const expectedActivationAuthorizationByBindings = new WeakMap<IWasmBindings, string>();

function expectedActivationAuthorizationFor(wasm: IWasmBindings): string {
  const authorization = expectedActivationAuthorizationByBindings.get(wasm);
  if (authorization === undefined) {
    throw new Error(
      "expectedActivationAuthorizationFor: these wasm bindings were not created by " +
        "makeFakeWasmBindings, so withFetchResponses has no expected header to match",
    );
  }
  return authorization;
}

function makeFakeWasmBindings(
  overrides: Partial<IWasmBindings> = {},
): IWasmBindings {
  const authorization = `Bearer sharePrefixKeyCreate-${++sharePrefixKeyCreateAuthorizationSeq}`;
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
      delegationHeader: { Authorization: authorization },
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
  const bindings = { ...base, ...overrides };
  expectedActivationAuthorizationByBindings.set(bindings, authorization);
  return bindings;
}

/**
 * Build a TinyCloudNode wired to a fake signer + the supplied wasm.
 *
 * The signer is the minimal duck-typed shape NodeUserAuthorization.signIn
 * needs: getAddress, getChainId, signMessage. We don't reach the network
 * calls (checkNodeInfo, ensureSpaceExists) because we override those via
 * monkey-patching the auth instance after construction.
 *
 * `scheduleAccountRegistrySync` is stubbed to a no-op by default — the same
 * idiom the `bootstrapGate`/`accountRegistrySync` test fixtures already use.
 * A full `signIn()` in this file otherwise ends with a *detached* background
 * registry sync (retries at 250ms/1s/3s) that easily outlives the calling
 * test's own `withFetchResponses` window and leaks into whichever test runs
 * next (TC-372). Pass `{ realRegistrySync: true }` for the one test that
 * asserts on the sync's own effects.
 */
function makeNodeWithSigner(
  wasm: IWasmBindings,
  config: Partial<ConstructorParameters<typeof TinyCloudNode>[0]> = {},
  opts: { realRegistrySync?: boolean } = {},
): TinyCloudNode {
  const fakeSigner = {
    signMessage: async () => "0x" + "ff".repeat(65),
    getAddress: async () => "0x0000000000000000000000000000000000000001",
    getChainId: async () => 1,
  };
  const node = new TinyCloudNode({
    tinycloudRegistryUrl: REGISTRY_ORIGIN,
    wasmBindings: wasm,
    signer: fakeSigner as any,
    host: "https://tinycloud.test",
    ...config,
  });
  if (!opts.realRegistrySync) {
    (node as any).scheduleAccountRegistrySync = () => {};
  }
  return node;
}

/**
 * Serve fixed `Response`s to fetch calls made during `fn`, but only to the
 * calls this test actually expects.
 *
 * Every signIn / ensureOwnedSpaceHostedById flow in this file makes at most
 * two kinds of request, always in this order: an unauthenticated
 * `GET .../info` (checkNodeInfo) and an authenticated `POST .../delegate`
 * (activateSessionWithHost). Two queued responses means [info, activate];
 * one means [activate] alone — every call site below uses one of those two
 * shapes, so the expected sequence can be derived from `responses.length`.
 *
 * Matching is deliberately strict and *positional* rather than "shift the
 * queue for anything that shows up": a leaked fetch from an earlier test's
 * detached account-registry-sync retry (TC-372) must never silently consume
 * this test's queued response — whether it's a differently-shaped request
 * (e.g. a SQL `/invoke` from `indexHasApplicationHash`) or a same-shaped
 * `POST /delegate` whose Authorization header proves it belongs to a
 * *different* session. `expectedAuthorization` is normally
 * `expectedActivationAuthorizationFor(wasm)` for the wasm bindings this
 * test's node was built with (unique per instance — see
 * `makeFakeWasmBindings`); tests that install a delegation header directly
 * (bypassing `completeSessionSetup`) pass the literal string instead.
 *
 * An unmatched request throws synchronously with the URL/method/position it
 * failed to match, rather than falling through to the real network — a leak
 * fails loudly at its source instead of silently hitting the network or
 * stealing a neighboring test's response.
 */
async function withFetchResponses(
  responses: Response[],
  fn: (fetchMock: any) => Promise<void>,
  expectedAuthorization: string,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const expectedSequence: Array<"info" | "delegate"> =
    responses.length >= 2 ? ["info", "delegate"] : ["delegate"];
  let position = 0;

  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const metadata = unregisteredLocationRegistryResponse(input, REGISTRY_ORIGIN, init);
    if (metadata) return metadata;
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const expectedKind = expectedSequence[position];
    const authorization = new Headers(init?.headers).get("authorization");

    const matches =
      expectedKind === "info"
        ? method === "GET" && url.endsWith("/info")
        : method === "POST" && url.endsWith("/delegate") && authorization === expectedAuthorization;

    if (!matches) {
      throw new Error(
        `unexpected fetch: ${method} ${url} (expected this test's ${expectedKind} ` +
          `request at position ${position}${
            expectedKind === "delegate" ? `, authorization "${authorization}"` : ""
          })`,
      );
    }

    position += 1;
    const response = responses.shift();
    if (!response) {
      throw new Error(`unexpected fetch: ${method} ${url} (response queue already empty)`);
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

const OWNER = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const PREFIX = `${NETWORK}/share/`;
const OTHER_OWNER_PREFIX = "urn:tinycloud:encryption:did:pkh:eip155:1:0x0000000000000000000000000000000000000002:default/share/";
const DECRYPT = "tinycloud.encryption/decrypt";
const CREATE = "tinycloud.encryption/key.create";

async function signInWith(permissions: { path: string; actions: string[] }[]) {
  const wasm = makeFakeWasmBindings();
  const node = makeNodeWithSigner(wasm, {
    includeAccountRegistryPermissions: false,
    manifest: {
      app_id: "com.test.share-keys",
      name: "Share keys",
      defaults: false,
      permissions: permissions.map((entry) => ({ service: "tinycloud.encryption", ...entry })),
    },
  });
  (node as any).ensureEncryptionNetwork = mock(async () => ({}));
  await withFetchResponses(
    [
      new Response(JSON.stringify({ protocol: 1, version: "test", features: ["encryption"], nodeId: "did:key:z6MkNode" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ activated: ["space://test"], skipped: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ],
    async () => { await node.signIn(); },
    expectedActivationAuthorizationFor(wasm),
  );
  return (wasm.prepareSession as any).mock.calls[0][0].rawAbilities as Record<string, string[]>;
}

describe("sign-in: the current owner's default share prefix", () => {
  test("decrypt on the prefix reaches the recap as a raw ability", async () => {
    expect(await signInWith([{ path: PREFIX, actions: ["decrypt"] }])).toEqual({ [PREFIX]: [DECRYPT] });
  });

  const refused: [string, string, string[]][] = [
    ["key.create on the share prefix", PREFIX, ["key.create"]],
    ["decrypt + key.create on the share prefix", PREFIX, ["decrypt", "key.create"]],
    ["key.create on a whole network", NETWORK, ["key.create"]],
    ["key.create on another prefix", `${NETWORK}/other/`, ["key.create"]],
    ["key.create on an apps prefix", `${NETWORK}/apps/billing/`, ["key.create"]],
    ["key.create on an exact share key", `${NETWORK}/share/abc`, ["key.create"]],
    ["key.create on another owner's share prefix", OTHER_OWNER_PREFIX, ["key.create"]],
    ["decrypt + key.create on another owner's share prefix", OTHER_OWNER_PREFIX, ["decrypt", "key.create"]],
    ["key.create on a non-default network's share prefix", `${NETWORK.replace(":default", ":other")}/share/`, ["key.create"]],
    ["decrypt + network.create on the share prefix", PREFIX, ["decrypt", "network.create"]],
    ["network.create on the share prefix", PREFIX, ["network.create"]],
  ];
  for (const [name, path, actions] of refused) {
    test(`refuses ${name}`, async () => {
      await expect(signInWith([{ path, actions }])).rejects.toThrow();
    });
  }
});

// The explicit `capabilityRequest` config takes precedence over the manifest and BYPASSES the sdk-core manifest expander, so these tests
// exercise node-sdk's own check alone (the second layer): any loosening of it is visible here.
async function signInWithCapabilityRequest(resources: { path: string; actions: string[] }[]) {
  const wasm = makeFakeWasmBindings();
  const node = makeNodeWithSigner(wasm, {
    includeAccountRegistryPermissions: false,
    capabilityRequest: {
      manifests: [],
      resources: resources.map((entry) => ({ service: "tinycloud.encryption", space: "encryption", skipPrefix: true, ...entry })),
      delegationTargets: [],
      registryRecords: [],
      expiryMs: 60_000,
      includePublicSpace: false,
    } as never,
  });
  (node as any).ensureEncryptionNetwork = mock(async () => ({}));
  await withFetchResponses(
    [
      new Response(JSON.stringify({ protocol: 1, version: "test", features: ["encryption"], nodeId: "did:key:z6MkNode" }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(JSON.stringify({ activated: ["space://test"], skipped: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ],
    async () => { await node.signIn(); },
    expectedActivationAuthorizationFor(wasm),
  );
  return (wasm.prepareSession as any).mock.calls[0][0].rawAbilities as Record<string, string[]>;
}

describe("sign-in through the explicit capabilityRequest (node-sdk's own check, without the manifest expander)", () => {
  test("accepts decrypt on the current owner's default share prefix", async () => {
    expect(await signInWithCapabilityRequest([{ path: PREFIX, actions: [DECRYPT] }])).toEqual({ [PREFIX]: [DECRYPT] });
  });

  const refused: [string, string, string[]][] = [
    ["key.create on the share prefix", PREFIX, [CREATE]],
    ["decrypt + key.create on the share prefix", PREFIX, [DECRYPT, CREATE]],
    ["key.create on another prefix", `${NETWORK}/other/`, [CREATE]],
    ["key.create on an apps prefix", `${NETWORK}/apps/billing/`, [CREATE]],
    ["key.create on a non-default network's share prefix", `${NETWORK.replace(":default", ":other")}/share/`, [CREATE]],
    ["key.create on another owner's share prefix", OTHER_OWNER_PREFIX, [CREATE]],
    ["decrypt + key.create + key.delete on the share prefix", PREFIX, [DECRYPT, CREATE, "tinycloud.encryption/key.delete"]],
    ["decrypt + a non-encryption action on the share prefix", PREFIX, [DECRYPT, "tinycloud.kv/get"]],
    ["key.create on an exact share key", `${NETWORK}/share/abc`, [CREATE]],
    ["key.block on the share prefix", PREFIX, ["tinycloud.encryption/key.block"]],
  ];
  for (const [name, path, actions] of refused) {
    test(`refuses ${name} with the named-keys refusal`, async () => {
      await expect(signInWithCapabilityRequest([{ path, actions }])).rejects.toThrow("named keys go in manifest.keys");
    });
  }
});
