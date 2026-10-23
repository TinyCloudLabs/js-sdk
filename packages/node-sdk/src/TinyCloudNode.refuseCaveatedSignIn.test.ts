/**
 * TC-1855: a sign-in or session preparation given a permission with a
 * non-empty caveat refuses with the typed `CAVEATED_DELEGATION_UNSUPPORTED`
 * error before any request or signature, because `prepareSession` takes
 * action-only abilities.
 *
 * Absent, `[]`, `[{}]` and `[{}, {}]` caveats are unconstrained and reach
 * `prepareSession`.
 */

import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";

import {
  CaveatedDelegationUnsupportedError,
  composeManifestRequest,
  type ISigner,
  type IWasmBindings,
  type ISessionManager,
  type Manifest,
  type PermissionEntry,
} from "@tinycloud/sdk-core";

import { NodeUserAuthorization } from "./authorization/NodeUserAuthorization";
import { refuseCaveated } from "./authorization/caveatRefusal";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

function sessionManager(): ISessionManager {
  const keys = new Set<string>(["default"]);
  return {
    createSessionKey: (id) => (keys.add(id), id),
    replaceSessionKey: (_jwk, id) => (keys.add(id), id),
    renameSessionKeyId: (oldId, newId) => {
      keys.delete(oldId);
      keys.add(newId);
    },
    getDID: (id) => `did:key:z6MkTest-${id}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
}

function fakeWasm() {
  const prepareSession = mock((params: Record<string, unknown>) => ({
    siwe: "fake-siwe",
    jwk: params.jwk,
    spaceId: params.spaceId,
    verificationMethod: "did:key:z6MkTestSession",
  }));
  const completeSessionSetup = mock(() => ({
    delegationHeader: { Authorization: "Bearer refuse-caveats-fixture" },
    delegationCid: "bafyfake",
  }));
  const wasm = {
    invoke: mock(async () => ({})),
    invokeAny: mock(async () => ({})),
    prepareSession,
    completeSessionSetup,
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, prefix: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${prefix}`,
    createDelegation: mock(() => ({})),
    parseRecapFromSiwe: mock(() => []),
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
  } satisfies IWasmBindings;
  return { wasm, prepareSession, completeSessionSetup };
}

function spySigner() {
  const getAddress = mock(async () => ADDRESS);
  const getChainId = mock(async () => 1);
  const signMessage = mock(async () => "0x" + "ff".repeat(65));
  return {
    signer: { getAddress, getChainId, signMessage },
    calls: () => getAddress.mock.calls.length + getChainId.mock.calls.length + signMessage.mock.calls.length,
  };
}

type Caveats = PermissionEntry["caveats"];

const CAVEATED: Array<[string, Caveats]> = [
  ["a constrained branch", [{ kind: "prefix", prefix: "notes/" }]],
  ["an empty branch next to a constrained one", [{}, { kind: "prefix", prefix: "notes/" }]],
  ["two empty branches", [{}, {}]],
];

const UNCONSTRAINED: Array<[string, Caveats]> = [
  ["absent", undefined],
  ["[]", []],
  ["[{}]", [{}]],
];

describe("refuseCaveated", () => {
  class Branch {}
  const entry = (caveats: unknown, service = "tinycloud.kv"): PermissionEntry => ({
    service,
    path: "notes/",
    actions: [`${service}/get`],
    caveats: caveats as Caveats,
  });

  test("accepts absent, [] and [{}]", () => {
    for (const caveats of [undefined, [], [{}]]) {
      expect(() => refuseCaveated([entry(caveats)])).not.toThrow();
    }
  });

  test("refuses every other shape, for any service", () => {
    const refused: unknown[] = [
      [{}, {}],
      [{ kind: "prefix" }],
      [{}, { kind: "prefix" }],
      null,
      "prefix",
      { kind: "prefix" },
      [null],
      ["x"],
      [[]],
      [new Map()],
      [new Branch()],
    ];
    for (const service of ["tinycloud.kv", "tinycloud.sql"]) {
      for (const caveats of refused) {
        expect(() => refuseCaveated([entry(caveats, service)])).toThrow(CaveatedDelegationUnsupportedError);
      }
    }
  });

  test("names only the caveated entries", () => {
    const plain = entry(undefined);
    const caveated = { ...entry([{ kind: "prefix" }]), path: "b/" };
    try {
      refuseCaveated([plain, entry([{}]), caveated]);
      throw new Error("expected a refusal");
    } catch (error) {
      if (!(error instanceof CaveatedDelegationUnsupportedError)) throw error;
      expect(error.entries.map((refused) => refused.path)).toEqual(["b/"]);
    }
  });

  test("checks an entry's own caveats even when it carries a permissions key", () => {
    const nested = { ...entry([{ kind: "prefix" }]), permissions: [] };
    expect(() => refuseCaveated([nested])).toThrow(CaveatedDelegationUnsupportedError);
  });

  test("accepts a manifest with empty or absent permissions, and absent input", () => {
    expect(() => refuseCaveated({ app_id: "xyz.tinycloud.refuse-caveats", name: "Refuse caveats", permissions: [] })).not.toThrow();
    expect(() => refuseCaveated({ app_id: "xyz.tinycloud.refuse-caveats", name: "Refuse caveats" })).not.toThrow();
    expect(() => refuseCaveated(undefined)).not.toThrow();
  });
});

function manifest(caveats: Caveats): Manifest {
  return {
    app_id: "xyz.tinycloud.refuse-caveats",
    name: "Refuse caveats",
    defaults: false,
    permissions: [
      {
        service: "tinycloud.kv",
        path: "notes/",
        actions: ["get"],
        ...(caveats === undefined ? {} : { caveats }),
      },
    ],
  };
}

let fetchMock: Mock<() => Promise<never>>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = mock(async () => {
    throw new Error("network is closed in this test");
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function expectCaveatRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(CaveatedDelegationUnsupportedError);
  expect(error).toMatchObject({ code: "CAVEATED_DELEGATION_UNSUPPORTED" });
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

function nodeAuthorization(caveats: Caveats, signer: ISigner, wasm: IWasmBindings) {
  return new NodeUserAuthorization({
    signer,
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    manifest: manifest(caveats),
    includeAccountRegistryPermissions: false,
  });
}

describe("TinyCloudNode.signIn refuses caveated manifests", () => {
  for (const [label, caveats] of CAVEATED) {
    test(`${label}: no signer call, no fetch, no prepareSession`, async () => {
      const { wasm, prepareSession } = fakeWasm();
      const { signer, calls } = spySigner();
      const node = new TinyCloudNode({
        wasmBindings: wasm,
        signer,
        host: "https://tinycloud.test",
        autoBootstrapAccount: false,
        includeAccountRegistryPermissions: false,
        manifest: manifest(caveats),
      });
      const before = calls();

      expectCaveatRefusal(await rejection(() => node.signIn()));

      expect(calls()).toBe(before);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prepareSession).not.toHaveBeenCalled();
    });
  }

  test("a pre-composed capabilityRequest is refused the same way", async () => {
    const { wasm, prepareSession } = fakeWasm();
    const { signer, calls } = spySigner();
    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer,
      host: "https://tinycloud.test",
      autoBootstrapAccount: false,
      capabilityRequest: composeManifestRequest([manifest([{ kind: "prefix", prefix: "notes/" }])], {
        includeAccountRegistryPermissions: false,
      }),
    });
    const before = calls();

    expectCaveatRefusal(await rejection(() => node.signIn()));

    expect(calls()).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prepareSession).not.toHaveBeenCalled();
  });

  test("unconstrained caveats prepare the same session as no caveats", async () => {
    const baseline = fakeWasm();
    const baselineNode = new TinyCloudNode({
      wasmBindings: baseline.wasm,
      signer: spySigner().signer,
      host: "https://tinycloud.test",
      autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
      manifest: manifest(undefined),
    });
    await rejection(() => baselineNode.signIn());
    expect(baseline.prepareSession).toHaveBeenCalledTimes(1);
    const expected = baseline.prepareSession.mock.calls[0]![0] as Record<string, unknown>;

    for (const [, caveats] of UNCONSTRAINED) {
      const { wasm, prepareSession } = fakeWasm();
      const node = new TinyCloudNode({
        wasmBindings: wasm,
        signer: spySigner().signer,
        host: "https://tinycloud.test",
        autoBootstrapAccount: false,
        includeAccountRegistryPermissions: false,
        manifest: manifest(caveats),
      });
      const error = await rejection(() => node.signIn());

      expect(error).not.toBeInstanceOf(CaveatedDelegationUnsupportedError);
      expect(prepareSession).toHaveBeenCalledTimes(1);
      const params = prepareSession.mock.calls[0]![0] as Record<string, unknown>;
      expect(params.abilities).toEqual(expected.abilities);
      expect(params.spaceAbilities).toEqual(expected.spaceAbilities);
    }
  });
});

describe("NodeUserAuthorization refuses caveated manifests", () => {
  for (const [label, caveats] of CAVEATED) {
    test(`signIn, ${label}: no signer call, no fetch, no prepareSession`, async () => {
      const { wasm, prepareSession } = fakeWasm();
      const { signer, calls } = spySigner();

      expectCaveatRefusal(await rejection(() => nodeAuthorization(caveats, signer, wasm).signIn()));

      expect(calls()).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prepareSession).not.toHaveBeenCalled();
    });

    test(`prepareSessionForSigning, ${label}: no signer call, no fetch, no prepareSession`, async () => {
      const { wasm, prepareSession } = fakeWasm();
      const { signer, calls } = spySigner();

      expectCaveatRefusal(
        await rejection(() => nodeAuthorization(caveats, signer, wasm).prepareSessionForSigning()),
      );

      expect(calls()).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prepareSession).not.toHaveBeenCalled();
    });

    test(`signInWithOpenKey, ${label}: no signer call, no fetch, OpenKey never asked`, async () => {
      const { wasm, prepareSession } = fakeWasm();
      const { signer, calls } = spySigner();
      const authorize = mock(async () => {
        throw new Error("must not be reached");
      });

      expectCaveatRefusal(
        await rejection(() => nodeAuthorization(caveats, signer, wasm).signInWithOpenKey(authorize)),
      );

      expect(calls()).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
      expect(prepareSession).not.toHaveBeenCalled();
    });
  }

  test("unconstrained caveats still prepare a session for signing", async () => {
    for (const [, caveats] of UNCONSTRAINED) {
      const { wasm, prepareSession } = fakeWasm();
      const prepared = await nodeAuthorization(caveats, spySigner().signer, wasm).prepareSessionForSigning();

      expect(prepared.prepared.siwe).toBe("fake-siwe");
      expect(prepareSession).toHaveBeenCalledTimes(1);
    }
  });
});

describe("NodeUserAuthorization.createBootstrapSession", () => {
  async function bootstrap(caveats: Caveats) {
    const { wasm, prepareSession } = fakeWasm();
    const { signer, calls } = spySigner();
    const auth = nodeAuthorization(undefined, signer, wasm);
    Reflect.set(auth, "_address", ADDRESS);
    Reflect.set(auth, "_chainId", 1);
    const capabilityRequest = composeManifestRequest([manifest(caveats)], {
      includeAccountRegistryPermissions: false,
    });
    const spaceId = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
    return { run: () => auth.createBootstrapSession({ spaceId, capabilityRequest }), prepareSession, calls };
  }

  for (const [label, caveats] of CAVEATED) {
    test(`refuses ${label} before any signature`, async () => {
      const { run, prepareSession, calls } = await bootstrap(caveats);

      expectCaveatRefusal(await rejection(run));

      expect(calls()).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prepareSession).not.toHaveBeenCalled();
    });
  }

  test("unconstrained caveats are still signed", async () => {
    for (const [, caveats] of UNCONSTRAINED) {
      const { run, prepareSession, calls } = await bootstrap(caveats);

      await run();

      expect(prepareSession).toHaveBeenCalledTimes(1);
      expect(calls()).toBeGreaterThan(0);
    }
  });
});

describe("TinyCloudNode.createOwnerDelegation", () => {
  function ownerDelegation(caveats: Caveats, extra: Record<string, unknown> = {}) {
    const { wasm, prepareSession } = fakeWasm();
    const { signer, calls } = spySigner();
    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer,
      host: "https://tinycloud.test",
      autoBootstrapAccount: false,
    });
    const permission = {
      service: "tinycloud.kv",
      path: "notes/",
      actions: ["tinycloud.kv/get"],
      ...(caveats === undefined ? {} : { caveats }),
      ...extra,
    };
    return {
      run: () =>
        node.createOwnerDelegation({
          delegateDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
          spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
          expiresAt: new Date(Date.now() + 60_000),
          permissions: [permission],
        }),
      prepareSession,
      calls,
    };
  }

  for (const [label, caveats] of CAVEATED) {
    test(`refuses ${label} before any signature`, async () => {
      const { run, prepareSession, calls } = ownerDelegation(caveats);
      const before = calls();

      expectCaveatRefusal(await rejection(run));

      expect(calls()).toBe(before);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prepareSession).not.toHaveBeenCalled();
    });
  }

  test("unconstrained caveats are not refused", async () => {
    for (const [, caveats] of UNCONSTRAINED) {
      const { run } = ownerDelegation(caveats);

      // Not signed in, so it stops later for an unrelated reason.
      expect(await rejection(run)).not.toBeInstanceOf(CaveatedDelegationUnsupportedError);
    }
  });

  test("refuses a permission that carries its own permissions key next to caveats", async () => {
    const { run, prepareSession, calls } = ownerDelegation([{ kind: "prefix" }], { permissions: [] });
    const before = calls();

    expectCaveatRefusal(await rejection(run));

    expect(calls()).toBe(before);
    expect(prepareSession).not.toHaveBeenCalled();
  });
});

describe("TinyCloudNode.createSubDelegation", () => {
  function subDelegation(caveats: Caveats, extra: Record<string, unknown> = {}) {
    const { wasm, prepareSession } = fakeWasm();
    const { signer, calls } = spySigner();
    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer,
      host: "https://tinycloud.test",
      autoBootstrapAccount: false,
    });
    const parent = {
      cid: "bafyparent",
      delegationHeader: { Authorization: "Bearer parent" },
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
      path: "notes/",
      actions: ["tinycloud.kv/get"],
      disableSubDelegation: false,
      expiry: new Date(Date.now() + 60_000),
      delegateDID: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      ownerAddress: ADDRESS,
      chainId: 1,
    };
    return {
      run: () =>
        node.createSubDelegation(parent, {
          path: "notes/",
          actions: ["tinycloud.kv/get"],
          delegateDID: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
          resources: [
            {
              service: "tinycloud.kv",
              path: "notes/",
              actions: ["tinycloud.kv/get"],
              ...(caveats === undefined ? {} : { caveats }),
              ...extra,
            },
          ],
        }),
      prepareSession,
      calls,
    };
  }

  for (const [label, caveats] of CAVEATED) {
    test(`refuses ${label} before any signature`, async () => {
      const { run, prepareSession, calls } = subDelegation(caveats);
      const before = calls();

      expectCaveatRefusal(await rejection(run));

      expect(calls()).toBe(before);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prepareSession).not.toHaveBeenCalled();
    });
  }

  test("unconstrained caveats are not refused", async () => {
    for (const [, caveats] of UNCONSTRAINED) {
      const { run } = subDelegation(caveats);

      // Not signed in, so it stops later for an unrelated reason.
      expect(await rejection(run)).not.toBeInstanceOf(CaveatedDelegationUnsupportedError);
    }
  });

  test("refuses a resource that carries its own permissions key next to caveats", async () => {
    const { run, prepareSession, calls } = subDelegation([{ kind: "prefix" }], { permissions: [] });
    const before = calls();

    expectCaveatRefusal(await rejection(run));

    expect(calls()).toBe(before);
    expect(prepareSession).not.toHaveBeenCalled();
  });
});
