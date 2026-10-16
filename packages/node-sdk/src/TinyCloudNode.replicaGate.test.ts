import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBKeyRange as fakeIDBKeyRange, indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRecapAttenuations, parseCanonicalRecapResource, pkhDid, type ReplicationEvent } from "@tinycloud/sdk-core";
import { registerReplicationLoaders } from "./core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { mintCompactDelegation } from "./test-support/compact-delegation";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";
import type { ReplicationModuleLoaders } from "./replication/module-registry";
import { createSqliteReplicaStorage } from "./replication/sqlite";
// @ts-ignore node-sdk moduleResolution "node" cannot read replica exports (see replica-contract.ts)
import * as replicaGate from "@tinycloud/replica/profile-gate";
import { createIndexedDbLifecycle, inspectReplicaKeyPresence } from "../../replica/src/kv-storage/lifecycle";
import { KV_DATABASE } from "../../replica/src/kv-storage/schema";
import { requestAsPromise } from "../../replica/src/browser/idb";

const RESTORE_HOST = "http://127.0.0.1:1";
const OTHER_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const GATE_FILE = "replica-gate.json";

const storage = {
  kind: "sqlite" as const,
  async open() { throw new Error("gate tests must not open storage"); },
  async purge() {},
};

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
  async unbind() {}
}

function loaders(): ReplicationModuleLoaders {
  return {
    runtime: () => import("./replication/runtime"),
    authority: () => import("./replication/authority"),
    gate: () => import("@tinycloud/replica/profile-gate"),
  };
}

const dirs: string[] = [];

beforeEach(() => {
  registerReplicationLoaders({
    ...loaders(),
    runtime: async () => ({ ReplicationRuntime: StubRuntime }) as never,
  });
});

afterEach(() => {
  registerReplicationLoaders(loaders());
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tc858-gate-"));
  dirs.push(dir);
  return dir;
}

function profileGuard(dir: string): <T>(section: () => Promise<T>) => Promise<T> {
  const lock = join(dir, ".replica-test-profile-lock");
  return async (section) => {
    await mkdir(lock);
    try {
      return await section();
    } finally {
      await rmdir(lock);
    }
  };
}

function replicatedNode(dir?: string, onEvent?: (event: ReplicationEvent) => void): TinyCloudNode {
  const guard = dir === undefined ? undefined : profileGuard(dir);
  const replicaStorage = dir === undefined ? storage
    : createSqliteReplicaStorage({ dir: join(dir, "replicas"), guard });
  return new TinyCloudNode({
    host: RESTORE_HOST,
    signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
    wasmBindings: new NodeWasmBindings(),
    replication: { enabled: true, prefixes: ["notes/"], storage: replicaStorage, profileDir: dir, profileGuard: guard, onEvent },
  });
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
    value: { locks: { request: (_name: string, section: () => Promise<unknown>) => section() } },
  });
  try {
    await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE));
    return await run(createIndexedDbLifecycle(), entries);
  } finally {
    await requestAsPromise(indexedDB.deleteDatabase(KV_DATABASE));
    for (let i = 0; i < names.length; i++) {
      const descriptor = previous[i];
      if (descriptor) Object.defineProperty(globalThis, names[i], descriptor);
      else Reflect.deleteProperty(globalThis, names[i]);
    }
  }
}

describe("replica gate: restore", () => {
  test("restores when the persisted stamp matches the profile gate", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const replicaStamp = await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });

    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });

    expect(node.address).toBe(proof.address);
    expect(node.spaceId).toBe(proof.spaceId);
    expect(await node.replication!.status()).toEqual([]);
  });

  test("exposes only the validated active replica stamp without sharing mutable state", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const stamp = await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });
    const node = replicatedNode(dir);
    expect(node.replicaStamp).toBeUndefined();
    await node.restoreSession({ ...proof, replicaStamp: stamp });
    expect(node.replicaStamp).toEqual(stamp);
    const exposed = node.replicaStamp!;
    (exposed as { lifecycleEpoch: number }).lifecycleEpoch++;
    expect(node.replicaStamp).toEqual(stamp);
    await node.signOut();
    expect(node.replicaStamp).toBeUndefined();
    const stale = replicatedNode(dir);
    await stale.restoreSession({ ...proof, replicaStamp: stamp });
    expect(stale.address).toBe(proof.address);
    expect(stale.replicaStamp).toBeUndefined();
  });

  test("keeps a verified network restore when replica runtime binding fails", async () => {
    class FailingRuntime extends StubRuntime {
      override async bind() { throw new Error("replica runtime unavailable"); }
    }
    registerReplicationLoaders({
      ...loaders(),
      runtime: async () => ({ ReplicationRuntime: FailingRuntime }) as never,
    });
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const replicaStamp = await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });
    const node = replicatedNode(dir);

    await node.restoreSession({ ...proof, replicaStamp });
    expect(node.address).toBe(proof.address);
    expect(node.spaceId).toBe(proof.spaceId);
    expect(node.replicaStamp).toBeUndefined();
    expect((await node.replication!.status())[0]).toMatchObject({
      state: "gated",
      gate: "gate_unavailable",
      errorCode: "REPLICA_GATED",
    });
  });

  test("restores the network session but gates a stamp that predates sign-out", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const replicaStamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    await replicaGate.denyGate(dir, { reason: "sign_out", principal }, async () => []);

    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });
    expect(node.address).toBe(proof.address);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "stamp_stale" });
    await expect(node.replication!.sync({ prefix: "notes/" })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
  });

  test("keeps the network session while rejecting malformed replica metadata", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const replicaStamp = await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });
    const malformed = { ...replicaStamp, forged: true };
    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp: malformed });

    expect(node.spaceId).toBe(proof.spaceId);
    expect(node.replicaStamp).toBeUndefined();
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "stamp_stale" });
  });

  test("keeps an unstamped network session with replica gated", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });

    const node = replicatedNode(dir);
    await node.restoreSession(proof);
    expect(node.spaceId).toBe(proof.spaceId);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "not_established" });
  });

  test("keeps the network session while profile purge is pending", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const replicaStamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    const partitionId = `${"a".repeat(64)}:${"a".repeat(26)}`;
    await replicaGate.denyGate(dir, { reason: "sign_out", principal }, async (principalHash) => [{
      id: partitionId,
      kind: "partition",
      partitionId,
      principalHash,
      recordedAt: 1,
    }]);

    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });
    expect(node.spaceId).toBe(proof.spaceId);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "purge_pending" });
  });

  test("keeps the network session when the replica profile belongs to another principal", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const replicaStamp = await replicaGate.establishSessionStamp(dir, pkhDid(OTHER_ADDRESS, proof.chainId), {
      siweIssuedAt: Date.now(),
    });

    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });
    expect(node.spaceId).toBe(proof.spaceId);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "principal_mismatch" });
  });

  test("keeps the network session without a replica profile directory", async () => {
    const proof = await signedRestorableSession();

    const node = replicatedNode();
    await node.restoreSession(proof);
    expect(node.spaceId).toBe(proof.spaceId);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "gate_unavailable" });
  });

  test("keeps a compact network session when replica-only scope verification throws", async () => {
    registerReplicationLoaders({
      ...loaders(),
      runtime: async () => ({ ReplicationRuntime: StubRuntime }) as never,
      authority: async () => ({
        replicationScopeFromSignedSession: () => { throw new Error("replica scope unavailable"); },
      }) as never,
    });
    const wasm = new NodeWasmBindings();
    const manager = wasm.createSessionManager();
    const delegateDid = manager.getDID("default").split("#", 1)[0]!;
    const imported = await mintCompactDelegation({
      audience: delegateDid,
      expSecs: Math.floor(Date.now() / 1000) + 3600,
      host: RESTORE_HOST,
    });
    const node = new TinyCloudNode({
      host: RESTORE_HOST,
      wasmBindings: new NodeWasmBindings(),
      replication: { enabled: true, prefixes: ["notes/"], storage, profileDir: profileDir() },
    });
    await node.restoreSession({
      delegationHeader: imported.delegation.delegationHeader,
      delegationCid: imported.delegation.cid,
      spaceId: imported.spaceId,
      jwk: JSON.parse(manager.jwk("default")!),
      verificationMethod: delegateDid,
    });
    expect(node.spaceId).toBe(imported.spaceId);
    expect(node.isSessionOnly).toBe(true);
    expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "gate_unavailable" });
  });

  test("restores without a stamp when replication is disabled", async () => {
    const proof = await signedRestorableSession();
    const node = new TinyCloudNode({
      host: RESTORE_HOST,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
    });

    await node.restoreSession(proof);

    expect(node.address).toBe(proof.address);
  });
});

describe("browser replica gate without a profile directory", () => {
  test("restores the exact IndexedDB stamp and shreds both keys on sign-out", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const proof = await signedRestorableSession();
      const principal = pkhDid(proof.address, proof.chainId);
      const stamp = await lifecycle.establishSessionStamp(principal, {
        consentAnchor: { source: "siwe", at: Date.parse(proof.siwe.match(/Issued At: (.+)/)![1]!) },
      });
      let boundStamp: unknown;
      class CapturingRuntime extends StubRuntime {
        override async bind(input: unknown) { boundStamp = (input as { stamp?: unknown }).stamp; }
      }
      registerReplicationLoaders({
        ...loaders(),
        runtime: async () => ({ ReplicationRuntime: CapturingRuntime }) as never,
        gate: async () => { throw new Error("Browser restore must not load the file gate."); },
      });
      const browserStorage = {
        kind: "indexeddb" as const,
        lifecycle,
        async open() { throw new Error("Browser restore must not open a partition."); },
        async purge() {},
      };
      const node = new TinyCloudNode({
        host: RESTORE_HOST,
        signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
        wasmBindings: new NodeWasmBindings(),
        replication: { enabled: true, prefixes: ["notes/"], storage: browserStorage },
      });

      await node.restoreSession({ ...proof, replicaStamp: stamp });
      expect(boundStamp).toEqual(stamp);
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
      await node.signOut();
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
      expect(JSON.parse(entries.get("tinycloud-replica:deny-tombstone")!)).toMatchObject({ epoch: stamp.lifecycleEpoch + 1 });
      expect(node.address).toBeUndefined();
    });
  });

  test("failed startup recovery gates restore but still forwards sign-out denial", async () => {
    await withBrowserOrigin(async (lifecycle, entries) => {
      const proof = await signedRestorableSession();
      const stamp = await lifecycle.establishSessionStamp(pkhDid(proof.address, proof.chainId), {
        consentAnchor: { source: "siwe", at: Date.parse(proof.siwe.match(/Issued At: (.+)/)![1]!) },
      });
      const unavailable = {
        ...lifecycle,
        restoreSessionStamp: async () => { throw Object.assign(new Error("Startup recovery failed."), { code: "REPLICA_GATED", gate: "gate_unavailable" }); },
        checkDelivery: () => ({ status: "gated" as const, gate: "gate_unavailable" as const }),
        deliverable: () => false,
      };
      registerReplicationLoaders({
        ...loaders(),
        gate: async () => { throw new Error("Browser sign-out must not load the file gate."); },
      });
      const node = new TinyCloudNode({
        host: RESTORE_HOST,
        signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
        wasmBindings: new NodeWasmBindings(),
        replication: {
          enabled: true,
          prefixes: ["notes/"],
          storage: { kind: "indexeddb", lifecycle: unavailable, async open() { throw new Error("Replica must stay gated."); }, async purge() {} },
        },
      });

      await node.restoreSession({ ...proof, replicaStamp: stamp });
      expect(node.address).toBe(proof.address);
      expect((await node.replication!.status())[0]).toMatchObject({ state: "gated", gate: "gate_unavailable" });
      await node.signOut();
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
      expect(JSON.parse(entries.get("tinycloud-replica:deny-tombstone")!)).toMatchObject({ epoch: stamp.lifecycleEpoch + 1 });
    });
  });

  test("fresh browser consent requires a verified finite owner SIWE with exact-space get and sync", async () => {
    await withBrowserOrigin(async (lifecycle) => {
      const node = new TinyCloudNode({
        host: RESTORE_HOST,
        signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
        wasmBindings: new NodeWasmBindings(),
        replication: {
          enabled: true,
          prefixes: ["notes/"],
          storage: { kind: "indexeddb", lifecycle, async open() { throw new Error("No partition open expected."); }, async purge() {} },
        },
      });
      const establish = async (proof: Awaited<ReturnType<typeof signedRestorableSession>>) =>
        (node as any).establishReplicaStamp({ ...proof, sessionKey: "default" });
      expect(await establish(await signedRestorableSession())).toBeUndefined();
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
      expect(await establish(await signedRestorableSession({ expirationless: true }))).toBeUndefined();
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });
      expect(await establish(await signedRestorableSession({
        abilities: { kv: { "notes/": ["tinycloud.kv/get"], "other/": ["tinycloud.kv/sync"] } },
      }))).toBeUndefined();
      expect(await establish(await signedRestorableSession({
        abilities: { kv: { "notes/": ["tinycloud.kv/get", "tinycloud.kv/sync"] } },
        caveat: { maxValueSize: 1 },
      }))).toBeUndefined();
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: false, accountKey: false });

      const prefixProof = await signedRestorableSession({
        abilities: { kv: { "notes/": ["tinycloud.kv/get", "tinycloud.kv/sync"] } },
      });
      const prefixStamp = await establish(prefixProof);
      expect(prefixStamp).toMatchObject({ incarnation: expect.any(String), lifecycleEpoch: 0 });
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });

      const proof = await signedRestorableSession({ abilities: { kv: { "": ["tinycloud.kv/get", "tinycloud.kv/sync"] } } });
      const stamp = await establish(proof);
      expect(typeof stamp.incarnation).toBe("string");
      expect(stamp.lifecycleEpoch).toBe(0);
      expect(await lifecycle.restoreSessionStamp(pkhDid(proof.address, proof.chainId), stamp)).toEqual(stamp);
      expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
    });
  });

  test("OpenKey approval uses the original prepared SIWE before exposing a fresh replica stamp", async () => {
    await withBrowserOrigin(async (lifecycle) => {
      const signer = new PrivateKeySigner(PROOF_PRIVATE_KEY);
      let ownerSignCalls = 0;
      const identityOnlySigner = {
        getAddress: () => signer.getAddress(),
        getChainId: () => signer.getChainId(),
        signMessage: async () => {
          ownerSignCalls++;
          throw new Error("Owner wallet signing requires a separate OpenKey approval.");
        },
      };
      const node = new TinyCloudNode({
        host: RESTORE_HOST,
        signer: identityOnlySigner,
        wasmBindings: new NodeWasmBindings(),
        autoBootstrapAccount: false,
        includeAccountRegistryPermissions: false,
        capabilityRequest: {
          manifests: [],
          resources: [{
            service: "tinycloud.kv",
            space: "default",
            path: "notes/",
            actions: ["tinycloud.kv/get", "tinycloud.kv/sync"],
          }],
          delegationTargets: [],
          registryRecords: [],
          expiryMs: 86_400_000,
          includePublicSpace: false,
        },
        replication: {
          enabled: true,
          prefixes: ["notes/"],
          storage: { kind: "indexeddb", lifecycle, async open() { throw new Error("No partition open expected."); }, async purge() {} },
        },
      });
      const priorFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/info")) {
          return new Response(JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/delegate") && init?.method === "POST") {
          return new Response(JSON.stringify({ activated: [], skipped: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected OpenKey test fetch: ${url}`);
      };
      try {
        let approvedSiwe: string | undefined;
        let preparedDid: string | undefined;
        let preparedCalls = 0;
        let retryCalls = 0;
        await node.signInWithOpenKey(async ({ siwe, jwk, verificationMethod }) => {
          preparedCalls++;
          expect(node.replicaStamp).toBeUndefined();
          expect(JSON.stringify(jwk)).toBeTruthy();
          approvedSiwe = siwe;
          preparedDid = verificationMethod;
          expect(verificationMethod).toMatch(/^did:key:/);
          const selectedActionKeys: string[] = [];
          const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
          for (const [resource, actions] of Object.entries(extractRecapAttenuations(siwe))) {
            const { space, path } = parseCanonicalRecapResource(resource);
            const grouped = new Map<string, string[]>();
            for (const ability of Object.keys(actions)) {
              const service = ability.slice(0, ability.indexOf("/"));
              if (ability !== "tinycloud.capabilities/read") {
                selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
              }
              grouped.set(service, [...(grouped.get(service) ?? []), ability]);
            }
            for (const [service, granted] of grouped) {
              permissions.push({ service, space, path, actions: granted });
            }
          }
          return {
            protocolVersion: 1,
            address: await signer.getAddress(),
            signature: await signer.signMessage(`${siwe} rejected`),
            signedMessage: siwe,
            selectedActionKeys,
            permissions,
          };
        }, {
          retryResult: async (error, original, attempt) => {
            retryCalls++;
            expect(error.message).toContain("OpenKey signature verification failed");
            expect(attempt).toBe(1);
            expect(original.siwe).toBe(approvedSiwe);
            expect(original.verificationMethod).toBe(preparedDid);
            const selectedActionKeys: string[] = [];
            const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
            for (const [resource, actions] of Object.entries(extractRecapAttenuations(original.siwe))) {
              const { space, path } = parseCanonicalRecapResource(resource);
              const grouped = new Map<string, string[]>();
              for (const ability of Object.keys(actions)) {
                const service = ability.slice(0, ability.indexOf("/"));
                if (ability !== "tinycloud.capabilities/read") {
                  selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
                }
                grouped.set(service, [...(grouped.get(service) ?? []), ability]);
              }
              for (const [service, granted] of grouped) {
                permissions.push({ service, space, path, actions: granted });
              }
            }
            return {
              protocolVersion: 1,
              address: await signer.getAddress(),
              signature: await signer.signMessage(original.siwe),
              signedMessage: original.siwe,
              selectedActionKeys,
              permissions,
            };
          },
        });
        expect(preparedCalls).toBe(1);
        expect(retryCalls).toBe(1);
        expect(node.session?.siwe).toBe(approvedSiwe);
        expect(node.sessionDid).toBe(preparedDid);
        expect(node.replicaStamp).toBeDefined();
        expect(await inspectReplicaKeyPresence()).toEqual({ gateHmac: true, accountKey: true });
        await node.waitForAccountRegistrySync();
        expect(ownerSignCalls).toBe(0);
        const local = new TinyCloudNode({
          host: RESTORE_HOST,
          signer,
          wasmBindings: new NodeWasmBindings(),
          autoBootstrapAccount: false,
          replication: {
            enabled: true,
            prefixes: ["notes/"],
            storage: { kind: "indexeddb", lifecycle, async open() { throw new Error("No partition open expected."); }, async purge() {} },
          },
        });
        (local as any).bootstrapAccountIfNeeded = async () => true;
        await local.signIn();
        expect(local.session?.siwe).not.toBe(approvedSiwe);
        expect(local.replicaStamp).toEqual(node.replicaStamp);
        await node.signOut();
        expect(node.replicaStamp).toBeUndefined();
      } finally {
        globalThis.fetch = priorFetch;
      }
    });
  });
});

function readGateFile(dir: string): { principalHash: string | null; lifecycleEpoch: number } {
  return JSON.parse(readFileSync(join(dir, GATE_FILE), "utf8"));
}

describe("replica gate: sign-out", () => {
  test("denies the gate for the leaving principal and bumps the lifecycle epoch", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const replicaStamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });
    const before = readGateFile(dir);

    await node.signOut();

    const after = readGateFile(dir);
    expect(after.principalHash).toBeNull();
    expect(after.lifecycleEpoch).toBe(before.lifecycleEpoch + 1);
  });

  test("sign-out emits one committed lifecycle denial to the callback and retiring context", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const stamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    const emitted: ReplicationEvent[] = [];
    const observed: unknown[] = [];
    const node = replicatedNode(dir, (event) => emitted.push(event));
    await node.restoreSession({ ...proof, replicaStamp: stamp });
    const context = Reflect.get(node, "_serviceContext") as { on(name: string, listener: (data: unknown) => void): void };
    context.on("replication.lifecycle", (data) => observed.push(data));

    await node.signOut();

    expect(readGateFile(dir).principalHash).toBeNull();
    expect(emitted.filter((event) => event.type === "replication.lifecycle")).toEqual([
      expect.objectContaining({ type: "replication.lifecycle", action: "denied", reason: "sign_out" }),
    ]);
    expect(observed).toEqual([expect.objectContaining({ action: "denied", reason: "sign_out" })]);
    expect(JSON.stringify(emitted)).not.toContain(principal);
    expect(JSON.stringify(emitted)).not.toContain(proof.spaceId);
  });

  test("account-switch denial emits once and a stale retry cannot claim a second denial", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const stamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    const emitted: ReplicationEvent[] = [];
    const node = replicatedNode(dir, (event) => emitted.push(event));
    await node.restoreSession({ ...proof, replicaStamp: stamp });
    const deny = Reflect.get(node, "denyReplicaGate") as (input: {
      reason: "account_switch"; principal: string; next: string;
    }) => Promise<{ status: string }>;
    const input = { reason: "account_switch" as const, principal, next: pkhDid(OTHER_ADDRESS, proof.chainId) };

    expect(await deny.call(node, input)).toMatchObject({ status: "denied" });
    expect(await deny.call(node, input)).toMatchObject({ status: "stale" });
    expect(emitted.filter((event) => event.type === "replication.lifecycle")).toEqual([
      expect.objectContaining({ type: "replication.lifecycle", action: "denied", reason: "account_switch" }),
    ]);
    expect(JSON.stringify(emitted)).not.toContain(principal);
  });

  test("durably denies before awaiting registry cleanup and refuses pending reads", async () => {
    const dir = profileDir();
    const guard = profileGuard(dir);
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const replicaStamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    const replicaStorage = createSqliteReplicaStorage({ dir: join(dir, "replicas"), guard });
    const identity = { host: RESTORE_HOST, space: proof.spaceId, principal };
    await replicaStorage.pendingWrites(identity, { stamp: replicaStamp }).update((state) => { state.seq = 1; });
    const node = new TinyCloudNode({
      host: RESTORE_HOST,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
      replication: { enabled: true, prefixes: ["notes/"], storage: replicaStorage, profileDir: dir, profileGuard: guard },
    });
    await node.restoreSession({ ...proof, replicaStamp });

    let cleanupObservedDenial = false;
    Reflect.set(node, "accountRegistryTail", {
      then(resolve: () => void, reject: (error: unknown) => void) {
        (async () => {
          cleanupObservedDenial = readGateFile(dir).principalHash === null;
          await expect(replicaStorage.pendingWrites(identity, { stamp: replicaStamp }).read())
            .rejects.toMatchObject({ code: "REPLICA_GATED" });
          resolve();
        })().catch(reject);
      },
    });

    await node.signOut();
    expect(cleanupObservedDenial).toBe(true);
    expect(node.restorableSession).toBeUndefined();
  });

  test("node sign-out records an identity pending intent before replica erase", async () => {
    const dir = profileDir();
    const guard = profileGuard(dir);
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const replicaStamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    const replicaStorage = createSqliteReplicaStorage({ dir: join(dir, "replicas"), guard });
    const identity = { host: RESTORE_HOST, space: proof.spaceId, principal };
    await replicaStorage.pendingWrites(identity, { stamp: replicaStamp }).update((state) => { state.seq = 1; });
    const node = new TinyCloudNode({
      host: RESTORE_HOST,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
      replication: { enabled: true, prefixes: ["notes/"], storage: replicaStorage, profileDir: dir, profileGuard: guard },
    });
    await node.restoreSession({ ...proof, replicaStamp });

    await node.signOut();

    const gate = JSON.parse(readFileSync(join(dir, GATE_FILE), "utf8"));
    expect(gate.principalHash).toBeNull();
    expect(gate.intents).toEqual([expect.objectContaining({ kind: "pending", id: expect.stringMatching(/^pending:/) })]);
    expect(node.restorableSession).toBeUndefined();
  });

  test("refuses an unlocked profile denial while still ending the network session", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const replicaStamp = await replicaGate.establishSessionStamp(dir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.now(),
    });
    const node = new TinyCloudNode({
      host: RESTORE_HOST,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
      replication: { enabled: true, prefixes: ["notes/"], storage, profileDir: dir },
    });
    await node.restoreSession({ ...proof, replicaStamp });
    const before = readGateFile(dir);

    await expect(node.signOut()).rejects.toThrow("Replica gate was not denied");
    expect(node.restorableSession).toBeUndefined();
    expect(readGateFile(dir)).toEqual(before);
  });

  test("throws when the gate cannot be denied", async () => {
    const dir = profileDir();
    const proof = await signedRestorableSession();
    const principal = pkhDid(proof.address, proof.chainId);
    const replicaStamp = await replicaGate.establishSessionStamp(dir, principal, { siweIssuedAt: Date.now() });
    const node = replicatedNode(dir);
    await node.restoreSession({ ...proof, replicaStamp });
    writeFileSync(join(dir, GATE_FILE), "{not json");

    await expect(node.signOut()).rejects.toThrow("Replica gate was not denied");
  });

  test("leaves no gate behind when replication is disabled", async () => {
    const proof = await signedRestorableSession();
    const node = new TinyCloudNode({
      host: RESTORE_HOST,
      signer: new PrivateKeySigner(PROOF_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
    });
    await node.restoreSession(proof);

    await expect(node.signOut()).resolves.toBeUndefined();
  });
});
