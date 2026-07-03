/**
 * Unit tests for the amended G2 fix: durable, awaited account-registry sync.
 *
 * Coverage:
 * (a) On the non-bootstrapped signIn path, syncAccountRegistry() runs and is
 *     awaited — the account index ensure + spaces sync complete before
 *     signIn() resolves (the app has no async refresh path).
 * (b) The account space is proactively hosted BEFORE the registry sync writes
 *     to it (this is the fix for the swallowed 404 that left fresh accounts
 *     with an empty Overview).
 * (c) A definitive registry failure surfaces a NON-FATAL registryStatus and
 *     signIn() still resolves — never a thrown signIn.
 * (d) A 402/404 from a registry write (e.g. at-cap) degrades to registryStatus,
 *     it does NOT lock the user out of signIn().
 * (e) withAccountRegistryRetry retries and resolves when a later attempt wins.
 *
 * These are unit tests: tc.signIn() (the inner TinyCloud layer) is stubbed so
 * NodeUserAuthorization's network calls are never reached, and the account
 * service is replaced with a fake so we can drive its results.
 */

import { describe, expect, mock, test } from "bun:test";

import type { IWasmBindings, ISessionManager, ClientSession } from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";

// ---------------------------------------------------------------------------
// Shared fixtures (mirrors TinyCloudNode.bootstrapGate.test.ts)
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

function makeExternalSigner() {
  return {
    signMessage: mock(async () => "0x" + "ff".repeat(65)),
    getAddress: async () => FAKE_ADDRESS,
    getChainId: async () => 1,
  };
}

interface FakeAccount {
  index: { ensure: ReturnType<typeof mock> };
  spaces: {
    syncAccessible: ReturnType<typeof mock>;
    register: ReturnType<typeof mock>;
  };
}

/**
 * Wire an interactive-signer node whose signIn() takes the non-bootstrapped
 * path (bootstrap is skipped for interactive signers), so syncAccountRegistry()
 * runs. Records the ordering of host + sync operations in `callLog`.
 */
function makeRegistryNode(opts: {
  hostImpl?: (spaceId: string) => Promise<void>;
  account?: {
    index?: Partial<FakeAccount["index"]>;
    spaces?: Partial<FakeAccount["spaces"]>;
  };
} = {}): {
  node: TinyCloudNode;
  callLog: string[];
  account: FakeAccount;
} {
  const callLog: string[] = [];
  const account: FakeAccount = {
    index: {
      ensure: mock(async () => {
        callLog.push("index.ensure");
        return { ok: true, data: undefined } as any;
      }),
      ...(opts.account?.index ?? {}),
    },
    spaces: {
      syncAccessible: mock(async () => {
        callLog.push("spaces.syncAccessible");
        return { ok: true, data: [] } as any;
      }),
      register: mock(async (record: any) => {
        callLog.push(`spaces.register:${record.spaceId ?? record.id}`);
        return { ok: true, data: record } as any;
      }),
      ...(opts.account?.spaces ?? {}),
    },
  };

  const node = new TinyCloudNode({
    wasmBindings: makeFakeWasmBindings(),
    // External signer, no privateKey, no signStrategy → interactive path →
    // bootstrap skipped → non-bootstrapped signIn tail runs the registry sync.
    signer: makeExternalSigner() as any,
    host: "https://tinycloud.test",
  });

  // Stub inner layers so signIn() completes offline.
  const tc = (node as any).tc;
  tc.signIn = mock(async () => FAKE_SESSION);
  (node as any).syncResolvedHostFromAuth = () => {};
  (node as any).initializeServices = () => {};
  (node as any).ensureRequestedEncryptionNetworks = async () => {};
  (node as any).writeManifestRegistryRecords = async () => {};

  // Spy the proactive host used by both the SECRETS pre-host and the account
  // space host inside syncAccountRegistry().
  (node as any).ensureOwnedSpaceHostedById = mock(async (spaceId: string) => {
    callLog.push(`host:${spaceId}`);
    if (opts.hostImpl) await opts.hostImpl(spaceId);
  });

  // Replace the account getter with our fake so syncAccountRegistry's leaves
  // are controllable without a real service context.
  Object.defineProperty(node, "account", {
    get: () => account,
    configurable: true,
  });

  return { node, callLog, account };
}

// ---------------------------------------------------------------------------
// (a) registry sync runs and is awaited on the non-bootstrapped path
// ---------------------------------------------------------------------------

describe("account registry sync — awaited durability", () => {
  test("signIn awaits the registry sync (ensure + syncAccessible complete)", async () => {
    const { node, account } = makeRegistryNode();

    await node.signIn();

    expect(account.index.ensure).toHaveBeenCalledTimes(1);
    expect(account.spaces.syncAccessible).toHaveBeenCalledTimes(1);
    expect(node.registryStatus.synced).toBe(true);
    expect(node.registryStatus.reason).toBeUndefined();
  });

  test("registryStatus starts synced=true before any signIn", () => {
    const node = new TinyCloudNode({
      wasmBindings: makeFakeWasmBindings(),
      signer: makeExternalSigner() as any,
      host: "https://tinycloud.test",
    });
    expect(node.registryStatus.synced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) account space is hosted BEFORE the sync writes to it
// ---------------------------------------------------------------------------

describe("account registry sync — proactive hosting order", () => {
  test("hosts the account space before syncAccessible", async () => {
    const { node, callLog } = makeRegistryNode();

    await node.signIn();

    const accountSpaceId = node.accountSpaceId!;
    const hostAccountIdx = callLog.indexOf(`host:${accountSpaceId}`);
    const syncIdx = callLog.indexOf("spaces.syncAccessible");

    expect(hostAccountIdx).toBeGreaterThanOrEqual(0);
    expect(syncIdx).toBeGreaterThanOrEqual(0);
    expect(hostAccountIdx).toBeLessThan(syncIdx);
  });
});

// ---------------------------------------------------------------------------
// (c) definitive sync failure surfaces a non-fatal status, signIn survives
// ---------------------------------------------------------------------------

describe("account registry sync — non-fatal failure surfacing", () => {
  test("syncAccessible !ok surfaces registryStatus and signIn resolves", async () => {
    const { node } = makeRegistryNode({
      account: {
        spaces: {
          syncAccessible: mock(async () => ({
            ok: false,
            error: { message: "sync boom" },
          })) as any,
        },
      },
    });

    // Skip the real backoff delays: exercise the surfacing, not the timers.
    (node as any).withAccountRegistryRetry = async (task: () => Promise<void>) => {
      await task();
    };

    await node.signIn(); // must NOT throw

    expect(node.registryStatus.synced).toBe(false);
    expect(node.registryStatus.reason).toContain("sync boom");
  });

  test("index.ensure !ok surfaces registryStatus and signIn resolves", async () => {
    const { node } = makeRegistryNode({
      account: {
        index: {
          ensure: mock(async () => ({
            ok: false,
            error: { message: "no such table" },
          })) as any,
        },
      },
    });
    (node as any).withAccountRegistryRetry = async (task: () => Promise<void>) => {
      await task();
    };

    await node.signIn();

    expect(node.registryStatus.synced).toBe(false);
    expect(node.registryStatus.reason).toContain("no such table");
  });
});

// ---------------------------------------------------------------------------
// (d) a 402/404 on a registry write must not lock the user out of signIn
// ---------------------------------------------------------------------------

describe("account registry sync — at-cap 402 does not fail signIn", () => {
  test("a 402 from hosting the account space degrades to status, signIn resolves", async () => {
    const { node } = makeRegistryNode({
      hostImpl: async (spaceId) => {
        // Fail only the account-space host (the registry-write target), the
        // way an at-cap 402 would.
        if (spaceId === /* account space */ node.accountSpaceId) {
          throw new Error("Storage quota exceeded (402)");
        }
      },
    });

    await node.signIn(); // must NOT throw even though the registry host 402s

    expect(node.registryStatus.synced).toBe(false);
    expect(node.registryStatus.reason).toContain("402");
  });
});

// ---------------------------------------------------------------------------
// (e) withAccountRegistryRetry resolves when a later attempt wins
// ---------------------------------------------------------------------------

describe("withAccountRegistryRetry", () => {
  test("retries and resolves when the second attempt succeeds", async () => {
    const node = new TinyCloudNode({
      wasmBindings: makeFakeWasmBindings(),
      signer: makeExternalSigner() as any,
      host: "https://tinycloud.test",
    });

    let attempts = 0;
    const task = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
    });

    await (node as any).withAccountRegistryRetry(task);

    expect(attempts).toBe(2);
  });

  test("throws (de-swallowed) when every attempt fails", async () => {
    const node = new TinyCloudNode({
      wasmBindings: makeFakeWasmBindings(),
      signer: makeExternalSigner() as any,
      host: "https://tinycloud.test",
    });

    // Collapse the backoff delays so the exhaustion path is fast.
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void) => realSetTimeout(fn, 0);
    try {
      const task = mock(async () => {
        throw new Error("permanent");
      });
      await expect(
        (node as any).withAccountRegistryRetry(task),
      ).rejects.toThrow("permanent");
      expect(task).toHaveBeenCalledTimes(3);
    } finally {
      (globalThis as any).setTimeout = realSetTimeout;
    }
  });
});

// ---------------------------------------------------------------------------
// (f) owned-space registrations are durably flushed by the awaited sync
// ---------------------------------------------------------------------------

const PENDING_SPACE = {
  spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications",
  name: "applications",
  ownerDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
  type: "owned" as const,
  permissions: ["*"],
  status: "active" as const,
};

describe("account registry sync — durable owned-space registration flush", () => {
  test("a register() failure reported as {ok:false} keeps the record pending (no throw to notice)", async () => {
    const { node, account } = makeRegistryNode();
    account.spaces.register.mockImplementationOnce(async () => ({
      ok: false,
      error: { message: "404 space not found" },
    }));

    await (node as any).attemptSpaceRegistration(PENDING_SPACE);

    expect((node as any).pendingSpaceRegistrations.size).toBe(1);
  });

  test("signIn's awaited sync flushes a previously failed registration", async () => {
    const { node, account, callLog } = makeRegistryNode();
    // Best-effort attempt fails as a Result — the pre-fix code silently
    // dropped this record forever (the .catch never fires on {ok:false}).
    account.spaces.register.mockImplementationOnce(async () => ({
      ok: false,
      error: { message: "404 space not found" },
    }));
    await (node as any).attemptSpaceRegistration(PENDING_SPACE);
    expect((node as any).pendingSpaceRegistrations.size).toBe(1);

    await node.signIn();

    expect((node as any).pendingSpaceRegistrations.size).toBe(0);
    // 1 failed best-effort + 1 successful flush inside the sync
    expect(account.spaces.register).toHaveBeenCalledTimes(2);
    expect(node.registryStatus.synced).toBe(true);
    // The flush happens inside the retry block, after index.ensure and
    // before syncAccessible.
    const flushIdx = callLog.indexOf(`spaces.register:${PENDING_SPACE.spaceId}`);
    const ensureIdx = callLog.indexOf("index.ensure");
    const syncIdx = callLog.indexOf("spaces.syncAccessible");
    expect(flushIdx).toBeGreaterThan(ensureIdx);
    expect(flushIdx).toBeLessThan(syncIdx);
  });

  test("a flush that keeps failing surfaces registryStatus, keeps the record pending, and signIn resolves", async () => {
    const { node, account } = makeRegistryNode();
    account.spaces.register.mockImplementation(async () => ({
      ok: false,
      error: { message: "Storage quota exceeded (402)" },
    }));
    (node as any).withAccountRegistryRetry = async (task: () => Promise<void>) => {
      await task();
    };

    await (node as any).attemptSpaceRegistration(PENDING_SPACE);
    await node.signIn(); // must NOT throw

    expect(node.registryStatus.synced).toBe(false);
    expect(node.registryStatus.reason).toContain("402");
    // Still pending: the next signIn retries it (retry-on-signIn policy).
    expect((node as any).pendingSpaceRegistrations.size).toBe(1);
  });

  test("the create-path callback keeps SpaceInfo-shaped records pending on failure", async () => {
    const { node, account } = makeRegistryNode();
    account.spaces.register.mockImplementationOnce(async () => ({
      ok: false,
      error: { message: "404 space not found" },
    }));

    await (node as any).attemptSpaceRegistration({
      id: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      name: "default",
      owner: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
      type: "owned",
      permissions: ["*"],
    });

    expect(
      (node as any).pendingSpaceRegistrations.has(
        "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default",
      ),
    ).toBe(true);
  });
});
