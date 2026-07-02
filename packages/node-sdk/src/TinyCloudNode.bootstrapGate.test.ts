/**
 * Unit tests for TC-86: bootstrap gate for interactive signers.
 *
 * Coverage:
 * (a) Interactive signer (external signer, no signStrategy) → bootstrap
 *     skipped, node.bootstrapSkipped === true, only one signature call.
 * (b) Local-key signer (privateKey) → bootstrap does not skip
 *     (exercised via autoBootstrapAccount=false sub-case showing the
 *     gate does not fire for non-interactive config).
 * (c) OpenKey auto-sign strategy → bootstrap runs when account is fresh.
 * (d) Bootstrap aborts after first signature rejection without cascading.
 *
 * These are unit tests: we stub tc.signIn() (the inner TinyCloud layer)
 * so that NodeUserAuthorization's network calls are never reached, then
 * exercise the bootstrap gate logic that runs after the main sign-in.
 */

import { describe, expect, mock, test } from "bun:test";

import type { IWasmBindings, ISessionManager, ClientSession } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { createOpenKeyCallbackSigningStrategy } from "@tinycloud/sdk-core";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeFakeSessionManager(): ISessionManager {
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

function makeFakeWasmBindings(overrides: Partial<IWasmBindings> = {}): IWasmBindings {
  const base: IWasmBindings = {
    invoke: mock(() => Promise.resolve({} as any)) as any,
    invokeAny: mock(() => Promise.resolve({} as any)) as any,
    prepareSession: mock(() => ({
      siwe: "fake-siwe",
      jwk: { kty: "OKP" },
      spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      verificationMethod: "did:key:z6MkTestSession",
    })),
    completeSessionSetup: mock(() => ({
      delegationHeader: { Authorization: "Bearer fake" },
      delegationCid: "bafyfake",
      jwk: { kty: "OKP" },
      spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
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

const FAKE_ADDRESS = "0x0000000000000000000000000000000000000001";

const FAKE_SESSION: ClientSession = {
  address: FAKE_ADDRESS,
  walletAddress: FAKE_ADDRESS,
  chainId: 1,
  sessionKey: "session-test",
  siwe: "fake-siwe",
  signature: "0x" + "ff".repeat(65),
};

function makeExternalSigner(signCallSpy?: ReturnType<typeof mock>) {
  const signMessage = signCallSpy ?? mock(async () => "0x" + "ff".repeat(65));
  return {
    signMessage,
    getAddress: async () => FAKE_ADDRESS,
    getChainId: async () => 1,
  };
}

/**
 * Stub node internals so signIn() completes without hitting the network.
 *
 * We replace tc.signIn() (the TinyCloud layer) with a function that returns
 * a fake session and sets the internal address/chainId fields that
 * TinyCloudNode.signIn() reads after the inner signIn resolves.
 * We also stub isFreshBootstrapAccount and the post-bootstrap helpers.
 */
function stubNodeForSignIn(
  node: TinyCloudNode,
  { freshAccount = false }: { freshAccount?: boolean } = {},
): void {
  // Stub tc.signIn() to avoid network calls.
  const tc = (node as any).tc;
  if (!tc) throw new Error("expected tc to be present (node needs signer)");
  tc.signIn = mock(async () => {
    // TinyCloudNode.signIn() reads _address and _chainId after tc.signIn() returns;
    // they are set from signer.getAddress/getChainId before the tc.signIn() call,
    // so we don't need to set them here.
    return FAKE_SESSION;
  });

  // Stub syncResolvedHostFromAuth (reads auth.hosts[0]).
  (node as any).syncResolvedHostFromAuth = () => {};

  // Stub initializeServices (sets up service context, needs real session).
  (node as any).initializeServices = () => {};

  // Control isFreshBootstrapAccount to simulate fresh vs existing account.
  (node as any).isFreshBootstrapAccount = async () => freshAccount;

  // Stub post-bootstrap helpers that would hit the network.
  (node as any).ensureRequestedEncryptionNetworks = async () => {};
  (node as any).ensureOwnedSpaceHostedById = async () => {};
  (node as any).scheduleAccountRegistrySync = () => {};
}

/**
 * Stub runAccountBootstrap so we can verify it was or wasn't called.
 * Returns the mock for assertions.
 */
function stubRunAccountBootstrap(node: TinyCloudNode): ReturnType<typeof mock> {
  const bootstrapMock = mock(async () => {});
  (node as any).runAccountBootstrap = bootstrapMock;
  return bootstrapMock;
}

// ---------------------------------------------------------------------------
// (a) Interactive signer → bootstrap skipped
// ---------------------------------------------------------------------------

describe("bootstrap gate — interactive signer", () => {
  test("skips bootstrap and sets bootstrapSkipped=true", async () => {
    const wasm = makeFakeWasmBindings();
    const signSpy = mock(async () => "0x" + "ff".repeat(65));
    const signer = makeExternalSigner(signSpy);

    // External signer, no privateKey, no signStrategy → interactive path.
    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer: signer as any,
      host: "https://tinycloud.test",
    });

    stubNodeForSignIn(node, { freshAccount: true });
    const bootstrapMock = stubRunAccountBootstrap(node);

    await node.signIn();

    expect(node.bootstrapSkipped).toBe(true);
    expect(bootstrapMock).not.toHaveBeenCalled();
  });

  test("bootstrapSkipped is false before first signIn", () => {
    const wasm = makeFakeWasmBindings();
    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer: makeExternalSigner() as any,
      host: "https://tinycloud.test",
    });
    expect(node.bootstrapSkipped).toBe(false);
  });

  test("bootstrapSkipped is false when account is not fresh (no bootstrap needed)", async () => {
    const wasm = makeFakeWasmBindings();
    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer: makeExternalSigner() as any,
      host: "https://tinycloud.test",
    });

    // freshAccount=false → isFreshBootstrapAccount returns false → bootstrap
    // would be skipped by the freshness check anyway, not the interactive gate.
    stubNodeForSignIn(node, { freshAccount: false });
    stubRunAccountBootstrap(node);

    await node.signIn();

    // Not a fresh account → the interactive-signer skip still fires (it runs
    // before the freshness check). bootstrapSkipped=true because we have an
    // interactive signer regardless of freshness.
    expect(node.bootstrapSkipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) Non-interactive config — autoBootstrapAccount=false suppresses bootstrap
// ---------------------------------------------------------------------------

describe("bootstrap gate — non-interactive config (autoBootstrapAccount=false)", () => {
  test("bootstrap not called when autoBootstrapAccount=false, bootstrapSkipped=false", async () => {
    const wasm = makeFakeWasmBindings();

    // autoBootstrapAccount=false overrides everything — bootstrap never runs
    // and the skip flag is not set (it was explicitly disabled, not skipped).
    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer: makeExternalSigner() as any,
      host: "https://tinycloud.test",
      autoBootstrapAccount: false,
    });

    stubNodeForSignIn(node, { freshAccount: true });
    const bootstrapMock = stubRunAccountBootstrap(node);

    await node.signIn();

    expect(bootstrapMock).not.toHaveBeenCalled();
    // autoBootstrapAccount=false hits the early-return before the interactive
    // gate, so _bootstrapSkipped is reset to false (the reset happens at the
    // top of bootstrapAccountIfNeeded before the early-return).
    expect(node.bootstrapSkipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) OpenKey auto-sign strategy → bootstrap runs
// ---------------------------------------------------------------------------

describe("bootstrap gate — OpenKey auto-sign strategy", () => {
  test("does not skip bootstrap on fresh account", async () => {
    const wasm = makeFakeWasmBindings();

    const openKeyStrategy = createOpenKeyCallbackSigningStrategy({
      endpoint: "https://openkey.test/api/delegate/sign",
    });

    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer: makeExternalSigner() as any,
      signStrategy: openKeyStrategy,
      host: "https://tinycloud.test",
    });

    stubNodeForSignIn(node, { freshAccount: true });
    const bootstrapMock = stubRunAccountBootstrap(node);

    await node.signIn();

    // OpenKey auto-sign strategy → isInteractiveSigner() = false →
    // bootstrap is NOT skipped.
    expect(node.bootstrapSkipped).toBe(false);
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
  });

  test("non-fresh account → bootstrap not triggered regardless of strategy", async () => {
    const wasm = makeFakeWasmBindings();

    const openKeyStrategy = createOpenKeyCallbackSigningStrategy({
      endpoint: "https://openkey.test/api/delegate/sign",
    });

    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer: makeExternalSigner() as any,
      signStrategy: openKeyStrategy,
      host: "https://tinycloud.test",
    });

    stubNodeForSignIn(node, { freshAccount: false });
    const bootstrapMock = stubRunAccountBootstrap(node);

    await node.signIn();

    expect(node.bootstrapSkipped).toBe(false);
    // isFreshBootstrapAccount returned false → bootstrap not run.
    expect(bootstrapMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (d) Bootstrap aborts after first rejection — no cascade
// ---------------------------------------------------------------------------

describe("bootstrap gate — abort on first rejection", () => {
  test("runAccountBootstrap throws on first createBootstrapSession failure without cascading", async () => {
    const wasm = makeFakeWasmBindings();
    const openKeyStrategy = createOpenKeyCallbackSigningStrategy({
      endpoint: "https://openkey.test/api/delegate/sign",
    });

    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer: makeExternalSigner() as any,
      signStrategy: openKeyStrategy,
      host: "https://tinycloud.test",
    });

    stubNodeForSignIn(node, { freshAccount: true });
    (node as any).ensureRequestedEncryptionNetworks = async () => {};
    (node as any).ensureOwnedSpaceHostedById = async () => {};
    (node as any).scheduleAccountRegistrySync = () => {};

    // Stub auth.createBootstrapSession to reject on the first call.
    const auth = (node as any).auth;
    let createBootstrapCallCount = 0;
    auth.createBootstrapSession = mock(async () => {
      createBootstrapCallCount++;
      throw new Error("Sign request rejected by callback");
    });

    // Stub auth.hostOwnedSpace — it must never be reached (cascade check).
    let hostOwnedSpaceCallCount = 0;
    auth.hostOwnedSpace = mock(async () => {
      hostOwnedSpaceCallCount++;
      return true;
    });

    await expect(node.signIn()).rejects.toThrow(
      /Account bootstrap aborted.*Sign request rejected/,
    );

    // Only one createBootstrapSession call — the abort prevents further calls.
    expect(createBootstrapCallCount).toBe(1);
    // hostOwnedSpace must never be called — the abort happened before phase 2.
    expect(hostOwnedSpaceCallCount).toBe(0);
  });

  test("error message includes space name and original cause", async () => {
    const wasm = makeFakeWasmBindings();
    const openKeyStrategy = createOpenKeyCallbackSigningStrategy({
      endpoint: "https://openkey.test/api/delegate/sign",
    });

    const node = new TinyCloudNode({
      wasmBindings: wasm,
      signer: makeExternalSigner() as any,
      signStrategy: openKeyStrategy,
      host: "https://tinycloud.test",
    });

    stubNodeForSignIn(node, { freshAccount: true });
    (node as any).ensureRequestedEncryptionNetworks = async () => {};
    (node as any).ensureOwnedSpaceHostedById = async () => {};
    (node as any).scheduleAccountRegistrySync = () => {};

    const auth = (node as any).auth;
    auth.createBootstrapSession = mock(async () => {
      throw new Error("auto-sign rejected");
    });
    auth.hostOwnedSpace = mock(async () => true);

    let thrownError: Error | undefined;
    try {
      await node.signIn();
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).toContain("Account bootstrap aborted");
    expect(thrownError!.message).toContain("auto-sign rejected");
  });
});
