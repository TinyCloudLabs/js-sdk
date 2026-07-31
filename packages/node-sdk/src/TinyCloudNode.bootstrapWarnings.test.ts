/**
 * Unit tests for TC-373 Sol blocker #2: a recovered ambiguous batch-write
 * failure must be surfaced structurally on `bootstrapStatus`, not only via
 * `console.warn` (Sol B5/B6e).
 *
 * These drive the PUBLIC contract — `bootstrapAccountIfNeeded()` via
 * `signIn()` — rather than inspecting `runAccountBootstrap`'s private return
 * value directly, using the same stubbing style as
 * `TinyCloudNode.bootstrapGate.test.ts`.
 */

import { describe, expect, mock, test } from "bun:test";

import type {
  IWasmBindings,
  ISessionManager,
  ClientSession,
  BootstrapSeedSpacesStep,
} from "@tinycloud/sdk-core";
import { createOpenKeyCallbackSigningStrategy } from "@tinycloud/sdk-core";
import { TinyCloudNode, type BootstrapWarning } from "./TinyCloudNode";

function makeFakeSessionManager(): ISessionManager {
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

function makeFakeWasmBindings(): IWasmBindings {
  return {
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

function makeExternalSigner() {
  return {
    signMessage: mock(async () => "0x" + "ff".repeat(65)),
    getAddress: async () => FAKE_ADDRESS,
    getChainId: async () => 1,
  };
}

function stubNodeForSignIn(node: TinyCloudNode): void {
  const tc = (node as any).tc;
  if (!tc) throw new Error("expected tc to be present (node needs signer)");
  tc.signIn = mock(async () => FAKE_SESSION);

  (node as any).syncResolvedHostFromAuth = () => {};
  (node as any).initializeServices = () => {};
  (node as any).isFreshBootstrapAccount = async () => true;
  (node as any).ensureRequestedEncryptionNetworks = async () => {};
  (node as any).ensureOwnedSpaceHostedById = async () => {};
  (node as any).scheduleAccountRegistrySync = () => {};
}

function makeNode(warningSpy: ReturnType<typeof mock>) {
  const openKeyStrategy = createOpenKeyCallbackSigningStrategy({
    endpoint: "https://openkey.test/api/delegate/sign",
  });
  const node = new TinyCloudNode({
    wasmBindings: makeFakeWasmBindings(),
    signer: makeExternalSigner() as any,
    signStrategy: openKeyStrategy,
    host: "https://tinycloud.test",
    notificationHandler: {
      success: () => {},
      warning: warningSpy,
      error: () => {},
    },
  });
  stubNodeForSignIn(node);
  return node;
}

describe("bootstrapStatus.warnings — recovered ambiguous batch write (TC-373 / TC-361)", () => {
  test("a recovered registerBatch surfaces a structured warning on bootstrapStatus", async () => {
    const warningSpy = mock(() => {});
    const node = makeNode(warningSpy);

    const warning: BootstrapWarning = {
      stepId: "account:seed-spaces",
      kind: "batch-write-reconciled",
      code: "KV_WRITE_FAILED",
      message: "500 - internal error after commit, reconciled",
    };
    (node as any).runAccountBootstrap = mock(async () => [warning]);

    await node.signIn();

    expect(node.bootstrapSkipped).toBe(false);
    expect(node.bootstrapStatus).toEqual({ skipped: false, warnings: [warning] });
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(String(warningSpy.mock.calls[0]![0])).toContain("account:seed-spaces");
  });

  test("a clean registerBatch leaves bootstrapStatus.warnings undefined (clean vs. recovered are distinguishable)", async () => {
    const warningSpy = mock(() => {});
    const node = makeNode(warningSpy);

    (node as any).runAccountBootstrap = mock(async () => []);

    await node.signIn();

    expect(node.bootstrapSkipped).toBe(false);
    expect(node.bootstrapStatus.skipped).toBe(false);
    expect(node.bootstrapStatus.warnings).toBeUndefined();
    expect(warningSpy).not.toHaveBeenCalled();
  });

  test("bootstrap failure path is unchanged: { skipped: true, reason } with no warnings key", async () => {
    const warningSpy = mock(() => {});
    const node = makeNode(warningSpy);

    (node as any).runAccountBootstrap = mock(async () => {
      throw new Error("boom");
    });

    await node.signIn();

    expect(node.bootstrapSkipped).toBe(true);
    expect(node.bootstrapStatus.skipped).toBe(true);
    expect(node.bootstrapStatus.reason).toBe("boom");
    expect(node.bootstrapStatus.warnings).toBeUndefined();
  });

  // Sol B3 (round 2): the three tests above all replace `runAccountBootstrap`
  // itself with a mock, so they only assert that TinyCloudNode plumbs
  // whatever `runAccountBootstrap` returns onto `bootstrapStatus` — they would
  // still pass even if the mapping from `recoveredFromBatchError` to a
  // `BootstrapWarning` at TinyCloudNode.ts:1667-1675 were deleted entirely.
  // This test drives the REAL `runAccountBootstrap` and only stubs the KV
  // layer it calls (`account.spaces.registerBatch`), so it actually guards
  // the mapping code itself.
  test("the REAL runAccountBootstrap seed-spaces path maps recoveredFromBatchError to a BootstrapWarning", async () => {
    const warningSpy = mock(() => {});
    const node = makeNode(warningSpy);

    // runAccountBootstrap() only requires `this.auth` (set synchronously in
    // the constructor via setupAuth) and `this._address` (normally set
    // inside signIn()). Set the address directly instead of calling
    // signIn(), so the *only* real bootstrap step that runs is the
    // seed-spaces one under test.
    (node as any)._address = FAKE_ADDRESS;

    const batchError = {
      code: "KV_WRITE_FAILED",
      message: "500 - internal error after commit, reconciled",
      service: "kv",
    };

    // Stub only the KV batch outcome. Everything downstream of it —
    // including the `if (batchError) warnings.push(...)` mapping — is the
    // real production code.
    node.account.spaces.registerBatch = mock(async () => ({
      ok: true as const,
      data: { spaces: [], recoveredFromBatchError: batchError },
    }));

    const seedSpacesStep: BootstrapSeedSpacesStep = {
      id: "account:seed-spaces",
      kind: "seed-spaces",
      spaces: [],
    };

    const warnings = await (node as any).runAccountBootstrap([seedSpacesStep]);

    expect(warnings).toEqual([
      {
        stepId: "account:seed-spaces",
        kind: "batch-write-reconciled",
        code: "KV_WRITE_FAILED",
        message: "500 - internal error after commit, reconciled",
      },
    ]);
  });
});
