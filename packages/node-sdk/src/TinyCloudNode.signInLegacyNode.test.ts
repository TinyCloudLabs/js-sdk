/*
 * TC-3801: sign-in on a node without `encryption-named-keys-v1`. The fake WASM `prepareSession` records the recap's abilities.
 * (Helpers are duplicated from TinyCloudNode.sharePrefix.test.ts so this file stands alone.)
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
const DECRYPT = "tinycloud.encryption/decrypt";
const CREATE = "tinycloud.encryption/key.create";


// TC-3801: a node without encryption-named-keys-v1 refuses a sign-in whose recap names a secret's own key ("Cannot find parent
// delegation"), so sign-in drops those entries there. It only ever narrows: nothing is added or swapped, and a node that lists
// named keys gets the request exactly as composed.
describe("sign-in on a node without named keys: the secret-key entries are dropped, nothing else changes", () => {
  const NAMED_KEYS = "encryption-named-keys-v1";
  const SECRET_KEY = `${NETWORK}/secrets/api_key`;
  const SECRETS_PREFIX = `${NETWORK}/secrets/`;
  const rootDecrypt = { service: "tinycloud.encryption", space: "encryption", skipPrefix: true, path: NETWORK, actions: [DECRYPT] };
  const secretKey = { service: "tinycloud.encryption", space: "encryption", skipPrefix: true, path: SECRET_KEY, actions: [DECRYPT, CREATE] };
  const secretsPrefix = { service: "tinycloud.encryption", space: "encryption", skipPrefix: true, path: SECRETS_PREFIX, actions: [DECRYPT, CREATE] };
  const kvRead = { service: "tinycloud.kv", space: "secrets", skipPrefix: true, path: "vault/secrets/API_KEY", actions: ["tinycloud.kv/get"] };

  async function signInRequest(resources: Record<string, unknown>[], features: string[]) {
    const wasm = makeFakeWasmBindings();
    const node = makeNodeWithSigner(wasm, {
      includeAccountRegistryPermissions: false,
      capabilityRequest: {
        manifests: [], resources, delegationTargets: [], registryRecords: [], expiryMs: 60_000, includePublicSpace: false,
      } as never,
    });
    (node as any).ensureEncryptionNetwork = mock(async () => ({}));
    let infoReads = 0;
    await withFetchResponses(
      [
        new Response(JSON.stringify({ protocol: 1, version: "test", features, nodeId: "did:key:z6MkNode" }), { status: 200, headers: { "Content-Type": "application/json" } }),
        new Response(JSON.stringify({ activated: ["space://test"], skipped: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      ],
      async (fetchMock) => {
        await node.signIn();
        infoReads = fetchMock.mock.calls.filter(([url]: [unknown]) => String(url).endsWith("/info")).length;
      },
      expectedActivationAuthorizationFor(wasm),
    );
    const { abilities, spaceAbilities, rawAbilities } = (wasm.prepareSession as any).mock.calls[0][0];
    return { request: { abilities, spaceAbilities, rawAbilities: rawAbilities ?? {} }, infoReads };
  }

  const pairs = (raw: Record<string, string[]>) => Object.entries(raw).flatMap(([path, actions]) => actions.map((action) => `${path}#${action}`));
  const kvText = (request: { spaceAbilities?: unknown }) => JSON.stringify(request.spaceAbilities);

  test("the old node's request is a strict subset of the named-keys node's, and only secret keys are missing", async () => {
    const entries = [rootDecrypt, secretKey, secretsPrefix, kvRead];
    const old = await signInRequest(entries, ["encryption"]);
    const named = await signInRequest(entries, ["encryption", NAMED_KEYS]);
    // Sign-in adds network.create beside a network-root decrypt itself.
    const root = [DECRYPT, "tinycloud.encryption/network.create"];
    expect(old.request.rawAbilities).toEqual({ [NETWORK]: root });
    expect(named.request.rawAbilities).toEqual({ [NETWORK]: root, [SECRET_KEY]: [DECRYPT, CREATE], [SECRETS_PREFIX]: [DECRYPT, CREATE] });
    const kept = new Set(pairs(named.request.rawAbilities));
    const dropped = pairs(old.request.rawAbilities);
    expect(dropped.every((pair) => kept.has(pair))).toBe(true);
    expect(dropped.length).toBeLessThan(kept.size);
    // Everything that is not a secret key is the same, bit for bit.
    expect(JSON.stringify({ a: old.request.abilities, s: old.request.spaceAbilities })).toBe(JSON.stringify({ a: named.request.abilities, s: named.request.spaceAbilities }));
  });

  // What a v1 secret read needs from the recap: decrypt on the network root and kv/get on the vault path.
  const v1Readable = ({ request }: { request: { rawAbilities: Record<string, string[]>; spaceAbilities?: unknown } }) =>
    (request.rawAbilities[NETWORK] ?? []).includes(DECRYPT) && kvText(request).includes("vault/secrets/API_KEY");

  for (const [hadRoot, hadKv] of [[true, true], [true, false], [false, true], [false, false]] as const) {
    test(`a v1 read works on the old node only if the request already had root decrypt (${hadRoot}) and kv (${hadKv})`, async () => {
      const entries = [secretKey, secretsPrefix, ...(hadRoot ? [rootDecrypt] : []), ...(hadKv ? [kvRead] : [])];
      const old = await signInRequest(entries, ["encryption"]);
      expect(v1Readable(old)).toBe(hadRoot && hadKv);
      // Never substituted: no network-root decrypt appears that was not asked for, and no secrets/ prefix is added.
      expect(Object.keys(old.request.rawAbilities).includes(NETWORK)).toBe(hadRoot);
      expect(Object.keys(old.request.rawAbilities).some((path) => path.includes("/secrets/"))).toBe(false);
    });
  }

  test("a node that lists named keys signs the request exactly as composed", async () => {
    const entries = [rootDecrypt, secretKey, secretsPrefix, kvRead];
    // The unfiltered baseline: a node whose /info does not say either way cannot narrow anything, so its request is the composed one.
    const wasm = makeFakeWasmBindings();
    const node = makeNodeWithSigner(wasm, {
      includeAccountRegistryPermissions: false,
      capabilityRequest: { manifests: [], resources: entries, delegationTargets: [], registryRecords: [], expiryMs: 60_000, includePublicSpace: false } as never,
    });
    (node as any).ensureEncryptionNetwork = mock(async () => ({}));
    (node as any).auth.refreshNodeInfo = async () => {};
    await withFetchResponses(
      [new Response(JSON.stringify({ activated: ["space://test"], skipped: [] }), { status: 200, headers: { "Content-Type": "application/json" } })],
      async () => { await node.signIn(); },
      expectedActivationAuthorizationFor(wasm),
    );
    const composed = (wasm.prepareSession as any).mock.calls[0][0];
    const named = await signInRequest(entries, ["encryption", NAMED_KEYS]);
    expect(JSON.stringify(named.request)).toBe(JSON.stringify({
      abilities: composed.abilities, spaceAbilities: composed.spaceAbilities, rawAbilities: composed.rawAbilities ?? {},
    }));
    expect(Object.keys(named.request.rawAbilities)).toContain(SECRET_KEY);
  });

  test("sign-in reads /info once, before it builds the request", async () => {
    expect((await signInRequest([rootDecrypt, secretKey, kvRead], ["encryption"])).infoReads).toBe(1);
    expect((await signInRequest([rootDecrypt, secretKey, kvRead], ["encryption", NAMED_KEYS])).infoReads).toBe(1);
  });
});
