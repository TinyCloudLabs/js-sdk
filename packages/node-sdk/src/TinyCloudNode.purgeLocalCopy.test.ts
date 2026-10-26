/**
 * TC-1888: signing out (and switching account) erases the browser replica before the call resolves,
 * `replication.purgeLocalCopy()` retries a failed erase, and `replica.purge.failed` reports one that
 * stayed failed. Runs the real IndexedDB lifecycle over fake-indexeddb.
 */
import { mkdtempSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBKeyRange as fakeIDBKeyRange, indexedDB as fakeIndexedDB } from "fake-indexeddb";

// Never touch a real home: every tool home is a temp dir, asserted before any write.
const TEST_HOME = mkdtempSync("/var/tmp/tc1888.");
process.env.HOME = TEST_HOME;
process.env.BUN_INSTALL_CACHE_DIR = TEST_HOME;
if (!process.env.HOME.startsWith("/var/tmp/tc1888.")) throw new Error("test home is not a temp dir");

import { pkhDid, type ReplicaPurgeFailedEvent } from "@tinycloud/sdk-core";
import { registerReplicationLoaders } from "./core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";
import type { ReplicationModuleLoaders } from "./replication/module-registry";
import { assertValidReplicationConfig } from "./replication/config";
import { ledgerFor } from "../../replica/src/kv-storage/ledger";
import { createIndexedDbLifecycle, inspectReplicaKeyPresence } from "../../replica/src/kv-storage/lifecycle";
import { KV_DATABASE } from "../../replica/src/kv-storage/schema";
import { injectDenyFailure } from "../../replica/src/kv-storage/testing";
import { requestAsPromise } from "../../replica/src/browser/idb";

const RESTORE_HOST = "http://127.0.0.1:1";
const OTHER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const tombstoneKey = "tinycloud-replica:deny-tombstone";
const markerKey = "tinycloud-replica:logout-pending";

class StubRuntime {
  readonly control = {
    status: async () => [],
    sync: async () => {},
    purge: async () => ({ purged: [], failed: [] }),
    clearPending: async () => 0,
    close: async () => {},
  };
  constructor(_options: unknown) {}
  async bind() {}
  async bindGatedNetworkOnly(_input: unknown) {}
  async unbind() {}
}

function loaders(): ReplicationModuleLoaders {
  return {
    validateConfig: assertValidReplicationConfig,
    runtime: () => import("./replication/runtime"),
    authority: () => import("./replication/authority"),
    gatedNetwork: () => import("./replication/gated-network"),
    gate: () => import("@tinycloud/replica/profile-gate"),
  };
}

beforeEach(() => {
  expect(process.env.HOME).toBe(TEST_HOME);
  registerReplicationLoaders({
    ...loaders(),
    runtime: async () => ({ ReplicationRuntime: StubRuntime }) as never,
    gate: async () => { throw new Error("Browser restore must not load the file gate."); },
  });
});

afterEach(() => {
  registerReplicationLoaders(loaders());
});

async function databaseListed(): Promise<boolean> {
  return (await indexedDB.databases()).some((database) => database.name === KV_DATABASE);
}

async function withBrowserOrigin<T>(run: (
  lifecycle: ReturnType<typeof createIndexedDbLifecycle>,
  entries: Map<string, string>,
) => Promise<T>): Promise<T> {
  const names = ["indexedDB", "IDBKeyRange", "localStorage", "navigator"] as const;
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB });
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: fakeIDBKeyRange });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: (
      _name: string,
      optionsOrSection: LockOptions | (() => Promise<unknown>),
      section?: () => Promise<unknown>,
    ) => (typeof optionsOrSection === "function" ? optionsOrSection : section!)() } },
  });
  try {
    await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE));
    return await run(createIndexedDbLifecycle({ ledger: ledgerFor() }), entries);
  } finally {
    await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE));
    for (let i = 0; i < names.length; i++) {
      const descriptor = previous[i];
      if (descriptor) Object.defineProperty(globalThis, names[i], descriptor);
      else Reflect.deleteProperty(globalThis, names[i]);
    }
  }
}

/** A restored browser-replica session over the real lifecycle. */
async function restoredNode(
  lifecycle: ReturnType<typeof createIndexedDbLifecycle>,
  signerKey = PROOF_PRIVATE_KEY,
) {
  const proof = await signedRestorableSession();
  const principal = pkhDid(proof.address, proof.chainId);
  const stamp = await lifecycle.establishSessionStamp(principal, {
    consentAnchor: { source: "siwe", at: Date.parse(proof.siwe.match(/Issued At: (.+)/)![1]!) },
  });
  const node = new TinyCloudNode({
    host: RESTORE_HOST,
    signer: new PrivateKeySigner(signerKey),
    wasmBindings: new NodeWasmBindings(),
    replication: {
      enabled: true,
      prefixes: ["notes/"],
      storage: { kind: "indexeddb", lifecycle, async open() { throw new Error("no partition in this test"); }, async purge() {} },
    },
  });
  const failures: ReplicaPurgeFailedEvent[] = [];
  node.on("replica.purge.failed", (event) => failures.push(event));
  await node.restoreSession({ ...proof, replicaStamp: stamp });
  return { node, principal, failures };
}

describe("signOut erases the local copy before it resolves", () => {
  test("the database is no longer listed, the keys are gone and the deny tombstone stays", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const { node, failures } = await restoredNode(lifecycle);
      expect(await databaseListed()).toBe(true);

      await node.signOut();

      expect(await databaseListed()).toBe(false);
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
      expect(entries.has(tombstoneKey)).toBe(true);
      expect(entries.has(markerKey)).toBe(false);
      expect(failures).toEqual([]);
    });
  });

  test("a blocked delete that clears within the bounded retries still resolves clean, with no event", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const { node, failures } = await restoredNode(lifecycle);
      const clear = injectDenyFailure("delete_database"); // one failed attempt, the retry succeeds

      await node.signOut();
      clear();

      expect(await databaseListed()).toBe(false);
      expect(entries.has(markerKey)).toBe(false);
      expect(failures).toEqual([]);
      expect(await node.replication!.purgeLocalCopy()).toEqual({ ok: true });
    });
  });

  test("a delete that keeps failing: signOut resolves, the event fires once, purgeLocalCopy retries to success", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const { node, failures } = await restoredNode(lifecycle);
      const clear = injectDenyFailure("delete_database", { once: false });
      try {
        await node.signOut();
        expect(node.address).toBeUndefined();
        expect(await databaseListed()).toBe(true);
        expect(entries.has(markerKey)).toBe(true);
        expect(failures).toEqual([{
          type: "replica.purge.failed", trigger: "sign_out", reason: "logout_pending", code: "STORAGE_ERROR", retryNow: true,
        }]);
        expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "logout_pending" });
        expect(await node.replication!.purgeLocalCopy()).toEqual({ ok: false, retryNow: true });
        expect(failures).toHaveLength(2);
        expect(failures[1]).toMatchObject({ trigger: "purge_local_copy", retryNow: true });
      } finally {
        clear();
      }

      expect(await node.replication!.purgeLocalCopy()).toEqual({ ok: true });
      expect(await databaseListed()).toBe(false);
      expect(entries.has(markerKey)).toBe(false);
      expect(entries.has(tombstoneKey)).toBe(true);
      expect(failures).toHaveLength(2);
    });
  });

  test("marker outcome: keys stay readable until the retry, and no readable copy survives it", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const { node, failures } = await restoredNode(lifecycle);
      const clearTx = injectDenyFailure("deny_tx");
      const clearDelete = injectDenyFailure("delete_database", { once: false });
      try {
        await node.signOut(); // deny falls back to the marker; every erase attempt fails
        expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
        expect(entries.has(markerKey)).toBe(true);
        expect(failures).toMatchObject([{ type: "replica.purge.failed", reason: "logout_pending", retryNow: true }]);
      } finally {
        clearTx();
        clearDelete();
      }

      expect(await node.replication!.purgeLocalCopy()).toEqual({ ok: true });

      expect(await databaseListed()).toBe(false);
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
      expect(entries.has(markerKey)).toBe(false);
    });
  });

  test("marker outcome whose erase succeeds on the first try resolves with the copy gone", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const { node, failures } = await restoredNode(lifecycle);
      const clearTx = injectDenyFailure("deny_tx");
      const clearDelete = injectDenyFailure("delete_database"); // consumed by the deny fallback
      try {
        await node.signOut();
      } finally {
        clearTx();
        clearDelete();
      }

      expect(await databaseListed()).toBe(false);
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
      expect(entries.has(markerKey)).toBe(false);
      expect(failures).toEqual([]);
    });
  });

  test("unguarded with no deny tombstone: signOut rejects with the typed error and nothing is deleted", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const { node, failures } = await restoredNode(lifecycle);
      const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { ...(original.value as object), setItem: () => { throw new Error("storage denied"); } },
      });
      try {
        await expect(node.signOut()).rejects.toMatchObject({
          code: "REPLICA_PURGE_FAILED", reason: "gate_unavailable", retryNow: false,
        });
      } finally {
        Object.defineProperty(globalThis, "localStorage", original);
      }

      expect(node.address).toBeUndefined();
      expect(await databaseListed()).toBe(true);
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
      expect(entries.has(tombstoneKey)).toBe(false);
      expect(failures).toMatchObject([{ reason: "gate_unavailable", retryNow: false }]);
    });
  });

  test("purgeLocalCopy never touches a live session", async () => {
    await withBrowserOrigin(async (lifecycle) => {
      const { node, failures } = await restoredNode(lifecycle);

      expect(await node.replication!.purgeLocalCopy()).toEqual({ ok: false, retryNow: false });

      expect(await databaseListed()).toBe(true);
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
      expect(node.address).toBeDefined();
      expect(failures).toEqual([]);
    });
  });
});

describe("account switch erases the old account's local copy before the new sign-in", () => {
  test("the database is not listed once the new account's sign-in has started", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const { node, failures } = await restoredNode(lifecycle, OTHER_PRIVATE_KEY);
      const establishSignIn = Reflect.get(node, "establishSignIn") as (
        epoch: number,
        performSignIn: () => Promise<unknown>,
      ) => Promise<void>;
      let listedAtSignIn: boolean | undefined;
      let keysAtSignIn: unknown;

      await expect(establishSignIn.call(node, Reflect.get(node, "sessionEpoch") as number, async () => {
        listedAtSignIn = await databaseListed();
        keysAtSignIn = await inspectReplicaKeyPresence();
        throw new Error("new account sign-in stub");
      })).rejects.toThrow("new account sign-in stub");

      expect(listedAtSignIn).toBe(false);
      expect(keysAtSignIn).toEqual({ gateHmac: false, accountKey: false });
      expect(entries.has(tombstoneKey)).toBe(true);
      expect(failures).toEqual([]);
    });
  });

  test("a delete that keeps failing fires the event with the account_switch trigger and the sign-in goes on", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const { node, failures } = await restoredNode(lifecycle, OTHER_PRIVATE_KEY);
      const establishSignIn = Reflect.get(node, "establishSignIn") as (
        epoch: number,
        performSignIn: () => Promise<unknown>,
      ) => Promise<void>;
      const clear = injectDenyFailure("delete_database", { once: false });
      try {
        await expect(establishSignIn.call(node, Reflect.get(node, "sessionEpoch") as number, async () => {
          throw new Error("new account sign-in stub");
        })).rejects.toThrow("new account sign-in stub");
      } finally {
        clear();
      }

      expect(failures).toEqual([{
        type: "replica.purge.failed", trigger: "account_switch", reason: "logout_pending", code: "STORAGE_ERROR", retryNow: true,
      }]);
      expect(entries.has(markerKey)).toBe(true);
      expect(await databaseListed()).toBe(true);
    });
  });
});

/** The deny falls back to a delete that fails and the marker write is dropped: outcome `unguarded`, tombstone advanced. */
async function signOutUnguardedWithAdvancedTombstone(
  node: TinyCloudNode,
  entries: Map<string, string>,
): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      ...(original.value as object),
      setItem: (key: string, value: string) => { if (key !== markerKey) entries.set(key, value); },
    },
  });
  const clearTx = injectDenyFailure("deny_tx");
  const clearDelete = injectDenyFailure("delete_database"); // consumed by the deny fallback
  try {
    await node.signOut();
  } finally {
    clearTx();
    clearDelete();
    Object.defineProperty(globalThis, "localStorage", original);
  }
}

describe("unguarded deny whose tombstone advanced", () => {
  test("a delete that works resolves signOut: the keys-kept database is gone", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const { node, failures } = await restoredNode(lifecycle);

      await expect(signOutUnguardedWithAdvancedTombstone(node, entries)).resolves.toBeUndefined();

      expect(node.address).toBeUndefined();
      expect(await databaseListed()).toBe(false);
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
      expect(entries.has(tombstoneKey)).toBe(true);
      expect(entries.has(markerKey)).toBe(false);
      expect(failures).toEqual([]);
    });
  });
});

describe("a replication chunk that fails to load never reports an erase", () => {
  const failingAuthority = () => registerReplicationLoaders({
    ...loaders(),
    runtime: async () => ({ ReplicationRuntime: StubRuntime }) as never,
    gate: async () => { throw new Error("Browser restore must not load the file gate."); },
    authority: async () => { throw new Error("chunk load failed"); },
  });
  const workingAuthority = () => registerReplicationLoaders({
    ...loaders(),
    runtime: async () => ({ ReplicationRuntime: StubRuntime }) as never,
    gate: async () => { throw new Error("Browser restore must not load the file gate."); },
  });

  test("denied: signOut resolves, the copy stays (ciphertext without keys), purgeLocalCopy fails closed, a later load erases it", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const { node, failures } = await restoredNode(lifecycle);
      failingAuthority();

      await expect(node.signOut()).resolves.toBeUndefined();

      expect(await databaseListed()).toBe(true);
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
      expect(await node.replication!.purgeLocalCopy()).toEqual({ ok: false, retryNow: false });
      expect(await databaseListed()).toBe(true);
      expect(failures).toEqual([]);

      workingAuthority();
      expect(await node.replication!.purgeLocalCopy()).toEqual({ ok: true });
      expect(await databaseListed()).toBe(false);
      expect(entries.has(tombstoneKey)).toBe(true);
    });
  });

  test("unguarded: signOut still rejects, because the erase is not reported as done", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const { node } = await restoredNode(lifecycle);
      failingAuthority();

      await expect(signOutUnguardedWithAdvancedTombstone(node, entries)).rejects.toMatchObject({
        code: "REPLICA_PURGE_FAILED", reason: "gate_unavailable", retryNow: false,
      });

      expect(await databaseListed()).toBe(true);
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });

      workingAuthority();
      expect(await node.replication!.purgeLocalCopy()).toEqual({ ok: true });
      expect(await databaseListed()).toBe(false);
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
    });
  });
});
