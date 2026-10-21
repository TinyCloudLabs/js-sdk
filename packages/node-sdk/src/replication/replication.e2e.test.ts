import { createPrivateKey, sign as signEd25519 } from "node:crypto";
import { ucanCid } from "@tinycloud/replica";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ServiceContext, pkhDid } from "@tinycloud/sdk-core";
import {
  type KVReadThrough,
  type KVReplicaHandle,
  type KVReplicaStorage,
  type LocalReplicaStatus,
  type PendingWriteStore,
  type ReplicationAuthority,
  type ReplicationEvent,
  type ReplicationScheduler,
} from "@tinycloud/sdk-services";
import { canonicalReplicationIdentity, createMemoryPendingStore } from "@tinycloud/sdk-services/kv/replication";
import { ReplicationRuntime } from "./runtime";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import "./node-loader";
import { getNodeReplicationLoaders } from "./module-registry";
import { TinyCloudNode } from "../TinyCloudNode";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, rmdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteReplicaStorage } from "./sqlite";

const address = "0x0000000000000000000000000000000000000001";
const space = `tinycloud:pkh:eip155:1:${address}:default`;
const identity = canonicalReplicationIdentity({
  host: "https://node.example",
  space,
  principal: `did:pkh:eip155:1:${address}`,
});
const now = 1_700_000_000_000;
const REAL_NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const expiringAt = now + 240_000;
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

const session = {
  delegationHeader: { Authorization: "Bearer session" },
  delegationCid: "bafy-session",
  spaceId: space,
  verificationMethod: "did:key:z6MkSession",
  jwk: {},
};
const scheduler: ReplicationScheduler = {
  now: () => now,
  setTimeout: () => () => undefined,
};

const RESTORE_PRIVATE_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";

async function replicationRestorableSession() {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(RESTORE_PRIVATE_KEY);
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const spaceId = wasm.makeSpaceId(address, chainId, "default");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 4 * 60_000);
  const verificationMethod = manager.getDID("default");
  const prepared = wasm.prepareSession({
    abilities: { kv: { "notes/": ["tinycloud.kv/get", "tinycloud.kv/sync"] } },
    address,
    chainId,
    domain: "replication.test",
    issuedAt: now.toISOString(),
    expirationTime: expiresAt.toISOString(),
    spaceId,
    jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const restored = wasm.completeSessionSetup({ ...prepared, signature });
  return {
    proof: {
      delegationHeader: restored.delegationHeader,
      delegationCid: restored.delegationCid,
      spaceId,
      jwk,
      verificationMethod,
      address,
      chainId,
      siwe: prepared.siwe,
      signature,
      expiresAt: expiresAt.toISOString(),
    },
    address,
    chainId,
  };
}

function harness(options: {
  prefixes?: string[];
  mode?: "background" | "foreground";
  initialGrant?: (prefix: string) => LocalReplicaStatus["grant"];
  sessionGrant?: ReplicationAuthority["sessionGrant"];
  plan?: ReplicationAuthority["plan"];
  mint?: ReplicationAuthority["mint"];
  ownerAnchor?: boolean;
  scheduler?: ReplicationScheduler;
} = {}) {
  const pendingByIdentity = new Map<string, PendingWriteStore>();
  const opened: string[] = [];
  const syncs: string[] = [];
  const syncWaiters: Array<() => void> = [];
  const purges: string[] = [];
  const events: import("@tinycloud/sdk-services").ReplicationEvent[] = [];
  let pendingCreates = 0;
  let mintCalls = 0;
  const statuses = new Map<string, LocalReplicaStatus>();
  const storage: KVReplicaStorage = {
    kind: "sqlite",
    async open(spec) {
      opened.push(spec.prefix);
      const grant = options.initialGrant?.(spec.prefix) ?? null;
      const state: LocalReplicaStatus = statuses.get(spec.prefix) ?? {
        coverage: "complete",
        lastSyncAt: new Date(now).toISOString(),
        syncedThroughEpoch: 0,
        authority: { state: "valid", expiresAt: expiringAt },
        grant,
        counts: { keys: 0, contentMissing: 0, tombstones: 0 },
        bytes: 0,
        lastError: null,
      };
      statuses.set(spec.prefix, state);
      const handle = {
        spec,
        deviceDid: spec.device?.did ?? identity.principal,
        async get(key: string) {
          return { status: "absent" as const, key, meta: { asOf: new Date(now).toISOString(), coverage: state.coverage, authority: state.authority.state, syncedThroughEpoch: state.syncedThroughEpoch } };
        },
        async list() {
          return { keys: [], meta: { asOf: new Date(now).toISOString(), coverage: state.coverage, authority: state.authority.state, syncedThroughEpoch: state.syncedThroughEpoch } };
        },
        async grant() { return state.grant; },
        async installGrant() {
          state.grant = { cid: "bafy-installed", parentCid: "bafy-parent", expiresAt: expiringAt, state: "active", unconstrained: true };
          return state.grant;
        },
        async sync({ syncStartEpoch }: { signal: AbortSignal; syncStartEpoch: number }) {
          syncs.push(spec.prefix);
          syncWaiters.splice(0).forEach((resolve) => resolve());
          state.syncedThroughEpoch = syncStartEpoch;
          state.lastSyncAt = new Date(now).toISOString();
          return { status: "synced" as const, pages: 1, changes: 0, deleted: 0, fetched: 0, contentMissing: 0, coverage: "complete" as const, syncedThroughEpoch: syncStartEpoch };
        },
        async status() { return state; },
        async close() {},
      } as unknown as KVReplicaHandle;
      return handle;
    },
    async purge(target) { purges.push(target.prefix); },
    pendingWrites(id) {
      const key = JSON.stringify(id);
      let pending = pendingByIdentity.get(key);
      if (!pending) {
        pendingCreates++;
        pending = createMemoryPendingStore(id);
        pendingByIdentity.set(key, pending);
      }
      return pending;
    },
  };
  const authority: ReplicationAuthority = {
    consentAnchor: () => options.ownerAnchor ? { at: now, source: "siwe" } : null,
    sessionGrant: options.sessionGrant ?? (() => ({ refused: "NOT_COVERED" })),
    plan: options.plan ?? (() => ({ refused: "NOT_COVERED" })),
    async mint(deviceDid, prefix, signal) {
      mintCalls++;
      if (options.mint) return options.mint(deviceDid, prefix, signal);
      throw new Error("offline");
    },
  };
  const context = new ServiceContext({
    invoke: async () => ({} as never),
    hosts: [identity.host],
    fetch: async () => new Response("not used"),
  });
  context.setSession(session);
  const runtime = (prefixes = options.prefixes ?? ["notes/"]) => new ReplicationRuntime({
    enabled: true,
    prefixes,
    storage,
    onEvent: (event) => events.push(event),
    mode: options.mode ?? "foreground",
  }, options.scheduler ?? scheduler);
  const binding = (instance: ReplicationRuntime, sessionId = session.delegationCid) => {
    const kv: { setReadThrough(readThrough: KVReadThrough | null): void; current?: KVReadThrough | null } = {
      setReadThrough(readThrough) { this.current = readThrough; },
    };
    instance.bind({
      context,
      session: { ...session, delegationCid: sessionId },
      address,
      chainId: 1,
      authority,
      primaryKV: [{ space, kv }],
    });
    return kv;
  };
  return { storage, authority, statuses, opened, syncs, purges, events, runtime, binding, nextSync: () => new Promise<void>((resolve) => syncWaiters.push(resolve)), counts: () => ({ pendingCreates, mintCalls }) };
}

describe("node replication integration", () => {
  test("status, explicit sync and purge use the bound control; intervals catch up on the injected scheduler", async () => {
    let interval: (() => void) | undefined;
    let scheduledDelay = 0;
    const clock: ReplicationScheduler = {
      now: () => now,
      setTimeout(fn, ms) { interval = fn; scheduledDelay = ms; return () => { if (interval === fn) interval = undefined; }; },
    };
    const env = harness({
      prefixes: ["notes/"],
      mode: "background",
      scheduler: clock,
      initialGrant: () => ({ cid: "bafy-installed", parentCid: "bafy-parent", expiresAt: expiringAt, state: "active", unconstrained: true }),
      plan: () => ({ path: "runtime", parentCid: "bafy-parent", expiresAt: expiringAt }),
    });
    const runtime = env.runtime();
    runtime.bind({ context: new ServiceContext({ invoke: async () => ({} as never), hosts: [identity.host], fetch: async () => new Response() }), session, address, chainId: 1, authority: env.authority, primaryKV: [] });
    const status = await runtime.control.status();
    expect(status.map((entry) => entry.prefix)).toEqual(["notes/"]);
    await runtime.control.sync();
    expect(env.syncs).toContain("notes/");
    const beforeInterval = env.syncs.length;
    expect(scheduledDelay).toBeGreaterThan(0);
    const intervalSync = env.nextSync();
    const fireInterval = interval;
    interval = undefined;
    fireInterval?.();
    await intervalSync;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(env.syncs.length).toBeGreaterThan(beforeInterval);
    const purging = runtime.control.purge();
    expect(interval).toBeUndefined();
    expect(await purging).toEqual({ purged: ["notes/"], failed: [] });
    expect(env.purges).toEqual(["notes/"]);
    await runtime.control.close();
  });

  test("partial authority opens only covered prefixes and preserves pending state on re-sign-in", async () => {
    const env = harness({
      ownerAnchor: true,
      prefixes: ["notes/", "photos/"],
      sessionGrant: (prefix) => prefix === "notes/"
        ? { ucan: "session-grant", device: { did: "did:key:zSession", jwk: {} } }
        : { refused: "NOT_COVERED" },
      plan: (prefix) => prefix === "notes/"
        ? { path: "session", parentCid: "bafy-parent", expiresAt: expiringAt }
        : { refused: "NOT_COVERED" },
    });
    const runtime = env.runtime();
    const kv = env.binding(runtime);
    const noteStore = env.storage.pendingWrites!(identity);
    await noteStore.update((state) => {
      state.seq++;
      state.records.push({
        opId: "ambiguous-write",
        seq: state.seq,
        key: "notes/a",
        op: "put",
        state: "ambiguous",
        epoch: null,
        at: new Date(now).toISOString(),
        settledAt: new Date(now).toISOString(),
        code: "NETWORK_ERROR",
      });
    });
    const status = await runtime.control.status();
    expect(status.map((entry) => entry.prefix)).toEqual(["notes/", "photos/"]);
    await runtime.control.sync().catch(() => undefined);
    expect(env.events.some((event) => event.type === "replication.state" && event.replica === "notes/" && event.state === "grant_installed")).toBe(true);
    expect(env.events.some((event) => event.type === "replication.state" && event.replica === "photos/" && event.state === "grant_missing")).toBe(true);
    expect(env.opened).toContain("notes/");
    runtime.bind({
      context: new ServiceContext({ invoke: async () => ({} as never), hosts: [identity.host], fetch: async () => new Response() }),
      session: { ...session, delegationCid: "bafy-replacement" },
      address,
      chainId: 1,
      authority: env.authority,
      primaryKV: [{ space, kv }],
    });
    expect(env.counts().pendingCreates).toBe(1);
    const pendingAfterRestore = await env.storage.pendingWrites!(identity).read();
    expect(pendingAfterRestore.records).toMatchObject([
      { opId: "ambiguous-write", state: "ambiguous", key: "notes/a" },
    ]);
    await runtime.control.close();
  });

  test("unconstrained installed grants survive an offline mint failure near expiry", async () => {
    const env = harness({
      ownerAnchor: true,
      initialGrant: () => ({ cid: "bafy-installed", parentCid: "bafy-old-parent", expiresAt: expiringAt, state: "active", unconstrained: true }),
      plan: () => ({ path: "runtime", parentCid: "bafy-parent", expiresAt: expiringAt }),
      mint: async () => { throw new Error("offline"); },
    });
    const runtime = env.runtime();
    runtime.bind({ context: new ServiceContext({ invoke: async () => ({} as never), hosts: [identity.host], fetch: async () => new Response() }), session, address, chainId: 1, authority: env.authority, primaryKV: [] });
    const status = await runtime.control.status();
    await runtime.control.sync();
    expect(env.events.some((event) => event.type === "replication.state" && event.replica === "notes/" && event.state === "grant_installed")).toBe(true);
    expect(env.counts().mintCalls).toBe(1);
    await runtime.control.close();
  });

  test("ten restored runtimes near the four-minute grant boundary make zero delegate mints", async () => {
    const env = harness({
      initialGrant: () => ({ cid: "bafy-installed", parentCid: "bafy-parent", expiresAt: expiringAt, state: "active", unconstrained: true }),
      plan: () => ({ path: "runtime", parentCid: "bafy-parent", expiresAt: expiringAt }),
    });
    for (let index = 0; index < 10; index++) {
      const runtime = env.runtime();
      runtime.bind({ context: new ServiceContext({ invoke: async () => ({} as never), hosts: [identity.host], fetch: async () => new Response() }), session: { ...session, delegationCid: `bafy-restore-${index}` }, address, chainId: 1, authority: env.authority, primaryKV: [] });
      await runtime.control.status();
      await runtime.control.close();
    }
    expect(env.counts().mintCalls).toBe(0);
  });
  test("ten TinyCloudNode restores near the four-minute grant boundary issue zero POST /delegate calls", async () => {
    const { proof } = await replicationRestorableSession();
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-restored-owner-"));
    const gate = await getNodeReplicationLoaders().gate();
    const replicaStamp = await gate.establishSessionStamp(profileDir, pkhDid(proof.address, proof.chainId), {
      siweIssuedAt: Date.parse(proof.siwe.match(/^Issued At: (.+)$/m)![1]!),
    });
    const lifecycle = createSqliteReplicaStorage({
      dir: join(profileDir, "replicas"),
      guard: profileGuard(profileDir),
    }).lifecycle;
    const originalFetch = globalThis.fetch;
    let delegatePosts = 0;
    let opened = 0;
    const expiresAt = Date.parse(proof.expiresAt);
    const installedAt = Date.now() - 10_000;
    const consentDeadline = Date.parse(proof.siwe.match(/^Issued At: (.+)$/m)![1]!) + 7 * 24 * 60 * 60_000;
    const parentCid = proof.delegationCid;
    const host = "https://replication.restore.test";
    globalThis.fetch = async (input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method.toUpperCase() === "POST" && new URL(String(input)).pathname.endsWith("/delegate")) {
        delegatePosts++;
      }
      return new Response("{}", { status: 500 });
    };
    try {
      for (let index = 0; index < 10; index++) {
        const grant = {
          cid: `bafy-installed-${index}`,
          parentCid,
          installedAt,
          effectiveExpiresAt: expiresAt,
          consentDeadline,
          expiresAt,
          state: "active" as const,
          unconstrained: true,
        };
        const replicaStatus: LocalReplicaStatus = {
          coverage: "complete",
          lastSyncAt: new Date().toISOString(),
          syncedThroughEpoch: 0,
          authority: { state: "valid", expiresAt: new Date(expiresAt).toISOString() },
          grant,
          counts: { keys: 0, contentMissing: 0, tombstones: 0 },
          bytes: 0,
          lastError: null,
        };
        const storage: KVReplicaStorage = {
          kind: "sqlite",
          lifecycle,
          async open(spec) {
            opened++;
            const handle: KVReplicaHandle = {
              spec,
              deviceDid: spec.device?.did ?? `did:key:replica-${index}`,
              async get(key) {
                return { status: "absent", key, meta: { asOf: new Date().toISOString(), coverage: "complete", authority: "valid", syncedThroughEpoch: 0 } };
              },
              async list() {
                return { keys: [], meta: { asOf: new Date().toISOString(), coverage: "complete", authority: "valid", syncedThroughEpoch: 0 } };
              },
              async grant() { return grant; },
              async installGrant() { return grant; },
              async sync({ syncStartEpoch }) {
                return { status: "synced", pages: 0, changes: 0, deleted: 0, fetched: 0, contentMissing: 0, coverage: "complete", syncedThroughEpoch: syncStartEpoch };
              },
              async status() { return replicaStatus; },
              async close() {},
            };
            return handle;
          },
          async purge() {},
          pendingWrites: createMemoryPendingStore,
        };
        const node = new TinyCloudNode({
          host,
          autoBootstrapAccount: false,
          wasmBindings: new NodeWasmBindings(),
          replication: { enabled: true, prefixes: ["notes/"], storage, mode: "foreground", profileDir },
        });
        await node.restoreSession({ ...proof, replicaStamp, tinycloudHosts: [host] });
        const control = node.replication;
        if (!control) throw new Error("replication control missing after restore");
        await control.sync();
        expect((await control.status()).map((entry) => entry.prefix)).toEqual(["notes/"]);
        await control.close();
      }
      expect(opened).toBe(10);
      expect(delegatePosts).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(profileDir, { recursive: true, force: true });
    }
  });
  test("two hosts sharing one storage directory keep separate replica partitions", async () => {
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-replication-e2e-"));
    const root = join(profileDir, "replicas");
    const storage = createSqliteReplicaStorage({
      dir: root,
      guard: profileGuard(profileDir),
      createDevice: async () => ({ did: "did:key:replica-e2e", jwk: {} }),
    });
    const anchor = { source: "siwe" as const, at: Date.now() };
    const stamp = await storage.lifecycle!.establishSessionStamp(identity.principal, { consentAnchor: anchor });
    const open = (host: string) => storage.open({
      identity: canonicalReplicationIdentity({ ...identity, host }),
      space,
      prefix: "notes/",
      allowSecrets: false,
      stamp,
      grantPolicy: { grantTtlMs: 60_000, consentAnchor: anchor },
    });
    const first = await open("https://one.example");
    const second = await open("https://two.example");
    try {
      expect(first.spec.identity.host).toBe("https://one.example");
      expect(second.spec.identity.host).toBe("https://two.example");
      expect(await readdir(root)).toHaveLength(2);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await rm(profileDir, { recursive: true, force: true });
    }
  });
  test("signed graph retirement unbinds before metadata-light compact delegate activation", async () => {
    const signed = await replicationRestorableSession();
    const profileDir = await mkdtemp(join(tmpdir(), "tc858-restored-compact-"));
    const gate = await getNodeReplicationLoaders().gate();
    const replicaStamp = await gate.establishSessionStamp(profileDir, pkhDid(signed.address, signed.chainId), {
      siweIssuedAt: Date.parse(signed.proof.siwe.match(/^Issued At: (.+)$/m)![1]!),
    });
    const lifecycle = createSqliteReplicaStorage({
      dir: join(profileDir, "replicas"),
      guard: profileGuard(profileDir),
    }).lifecycle;
    const wasm = new NodeWasmBindings();
    const delegateManager = wasm.createSessionManager();
    const delegateKeyId = delegateManager.createSessionKey("delegate-session");
    const delegateJwk = JSON.parse(delegateManager.jwk(delegateKeyId)!);
    const delegateVerificationMethod = delegateManager.getDID(delegateKeyId);
    const delegateSpace = wasm.makeSpaceId(signed.address, signed.chainId, "shared");
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "EdDSA", typ: "JWT" });
    const payload = encode({
      iss: signed.proof.verificationMethod,
      aud: delegateVerificationMethod,
      exp: Math.floor(Date.now() / 1000) + 3_600,
      prf: [signed.proof.delegationCid],
      att: {
        [`${delegateSpace}/kv/notes/`]: {
          "tinycloud.kv/get": null,
          "tinycloud.kv/sync": null,
        },
      },
    });
    const signingKey = createPrivateKey({ key: signed.proof.jwk as JsonWebKey, format: "jwk" });
    const signature = signEd25519(null, Buffer.from(`${header}.${payload}`), signingKey).toString("base64url");
    const token = `${header}.${payload}.${signature}`;
    const opened: KVReplicaHandle[] = [];
    const closed: string[] = [];
    let persistedStatus: LocalReplicaStatus | undefined;
    const storage: KVReplicaStorage = {
      kind: "sqlite",
      lifecycle,
      async open(spec) {
        const state: LocalReplicaStatus = {
          coverage: "complete",
          lastSyncAt: new Date().toISOString(),
          syncedThroughEpoch: 0,
          authority: { state: "valid", expiresAt: Date.now() + 60_000 },
          grant: null,
          counts: { keys: 0, contentMissing: 0, tombstones: 0 },
          bytes: 0,
          lastError: null,
        };
        persistedStatus = state;
        const grant = {
          cid: "bafy-installed",
          parentCid: spec.identity.space === space ? signed.proof.delegationCid : "bafy-compact-parent",
          expiresAt: Date.now() + 60_000,
          state: "active" as const,
          unconstrained: true,
        };
        const handle: KVReplicaHandle = {
          spec,
          deviceDid: spec.device?.did ?? "did:key:replica",
          async get(key) { return { status: "absent", key, meta: { asOf: new Date().toISOString(), coverage: "complete", authority: "valid", syncedThroughEpoch: 0 } }; },
          async list() { return { keys: [], meta: { asOf: new Date().toISOString(), coverage: "complete", authority: "valid", syncedThroughEpoch: 0 } }; },
          async grant() { return spec.identity.space === space ? grant : null; },
          async installGrant() { state.grant = grant; persistedStatus = state; return grant; },
          async sync({ syncStartEpoch }) { state.syncedThroughEpoch = syncStartEpoch; persistedStatus = state; return { status: "synced", pages: 0, changes: 0, deleted: 0, fetched: 0, contentMissing: 0, coverage: "complete", syncedThroughEpoch: syncStartEpoch }; },
          async status() { return state; },
          async close() { closed.push(spec.identity.host); },
        };
        opened.push(handle);
        return handle;
      },
      async inspectStatus() { return persistedStatus; },
      async purge() {},
      pendingWrites: createMemoryPendingStore,
    };
    const node = new TinyCloudNode({
      host: "https://signed-restore.example",
      autoBootstrapAccount: false,
      wasmBindings: wasm,
      replication: { enabled: true, prefixes: ["notes/"], storage, mode: "foreground", profileDir },
    });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input) => new Response(JSON.stringify(
        String(input).endsWith("/info")
          ? { protocol: wasm.protocolVersion(), version: "test", features: ["kv-sync-v1"] }
          : { activated: [space, delegateSpace], skipped: [] },
      ), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      await node.restoreSession({ ...signed.proof, replicaStamp, tinycloudHosts: ["https://signed-restore.example"] });
      await node.replication!.sync();
      expect(opened).toHaveLength(1);
      await node.restoreSession({
        delegationHeader: { Authorization: `Bearer ${token}` },
        delegationCid: ucanCid(token),
        spaceId: delegateSpace,
        jwk: delegateJwk,
        verificationMethod: delegateVerificationMethod,
        tinycloudHosts: ["https://signed-restore.example"],
        replicaStamp,
      });
      expect(closed).toEqual(["https://signed-restore.example"]);
      expect(opened).toHaveLength(1);
      expect((await node.replication!.status()).map((entry) => entry.prefix)).toEqual(["notes/"]);
      expect(opened).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      await node.replication?.close();
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});
describe.skipIf(!REAL_NODE_BIN)("node-sdk replication against a real node", () => {
  let dataDir: string;
  let host: string;
  let child: ChildProcess | undefined;
  async function guardedProfile(name: string) {
    const profileDir = await mkdtemp(join(tmpdir(), name));
    const guard = profileGuard(profileDir);
    return {
      profileDir,
      guard,
      storage: createSqliteReplicaStorage({ dir: join(profileDir, "replicas"), guard }),
    };
  }


  async function startNode(): Promise<void> {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") return reject(new Error("could not allocate a node port"));
        server.close(() => resolve(address.port));
      });
    });
    host = `http://127.0.0.1:${port}`;
    const nodeSecret = randomBytes(48).toString("base64url");
    const process = spawn(REAL_NODE_BIN!, [], {
      cwd: dataDir,
      env: {
        ...globalThis.process.env,
        TINYCLOUD_STORAGE__DATADIR: join(dataDir, "data"),
        TINYCLOUD_PORT: String(port),
        TINYCLOUD_ADDRESS: "127.0.0.1",
        ROCKET_PORT: String(port),
        ROCKET_ADDRESS: "127.0.0.1",
        TINYCLOUD_KEYS__TYPE: "Static",
        TINYCLOUD_KEYS__SECRET: nodeSecret,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = process;
    const launched = Promise.withResolvers<void>();
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Rocket has launched")) launched.resolve();
    };
    process.stdout!.on("data", onData);
    process.stderr!.on("data", onData);
    process.once("error", (error) => launched.reject(error));
    process.once("exit", (code) => {
      if (code !== null) launched.reject(new Error(`real TinyCloud node exited (${code}) before launch`));
    });
    await launched.promise;
  }

  async function stopNode(): Promise<void> {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null) return;
    const exited = Promise.withResolvers<void>();
    running.once("exit", () => exited.resolve());
    running.kill("SIGTERM");
    await exited.promise;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "tc858-real-node-"));
    await startNode();
  }, 60_000);

  afterAll(async () => {
    await stopNode();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("default SQLite owner grants sync, scoped writes are read-your-writes, and offline reads fail closed", async () => {
    const profile = await guardedProfile("tc858-real-replica-");
    const events: import("@tinycloud/sdk-services").ReplicationEvent[] = [];
    const node = new TinyCloudNode({
      host,
      signer: new PrivateKeySigner(RESTORE_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
      domain: "replication.test",
      autoCreateSpace: true,
      autoBootstrapAccount: false,
      enablePublicSpace: false,
      replication: {
        enabled: true,
        prefixes: ["notes/"],
        storage: profile.storage,
        profileDir: profile.profileDir,
        profileGuard: profile.guard,
        mode: "foreground",
        onEvent: (event) => events.push(event),
      },
    });
    try {
      await node.signIn();
      expect(node.replicaStamp).toMatchObject({ incarnation: expect.any(String), lifecycleEpoch: 0 });
      const primarySpace = node.restorableSession!.spaceId;
      expect((await node.kv.put("notes/seed", "seed-v0")).ok).toBe(true);
      await node.replication!.sync();

      const status = await node.replication!.status();
      expect(status).toMatchObject([{ prefix: "notes/", grant: { unconstrained: true } }]);
      expect(events.some((event) =>
        event.type === "replication.state" &&
        event.state === "grant_installed" &&
        event.strategy === "minted"
      )).toBe(true);
      expect((await node.kv.get("notes/seed")).data?.data).toBe("seed-v0");
      expect(events.some((event) =>
        event.type === "replication.read" &&
        event.key === "notes/seed" &&
        event.source === "replica" &&
        event.reason === "hit"
      )).toBe(true);

      const spaceKv = node.space(primarySpace).kv;
      expect((await spaceKv.put("notes/space-ryw", "space-v1")).ok).toBe(true);
      expect((await node.kv.get("notes/space-ryw")).data?.data).toBe("space-v1");
      const scoped = node.kvForSpace(primarySpace);
      expect((await scoped.put("notes/ryw", "scoped-v1")).ok).toBe(true);
      expect((await node.kv.get("notes/ryw")).data?.data).toBe("scoped-v1");
      await node.replication!.sync();

      const restoredSession = node.restorableSession!;
      await node.restoreSession({ ...restoredSession, replicaStamp: node.replicaStamp, tinycloudHosts: [host] });
      const restoredSpaceKv = node.space(primarySpace).kv;
      expect((await restoredSpaceKv.put("notes/restored-ryw", "restored-v1")).ok).toBe(true);
      expect((await node.kv.get("notes/restored-ryw")).data?.data).toBe("restored-v1");
      await node.replication!.sync();

      const serviceContext = (node as unknown as { _serviceContext: ServiceContext })._serviceContext;
      (serviceContext as unknown as { _fetch: typeof fetch })._fetch = async () => {
        throw Object.assign(new Error("network unavailable"), { code: "NETWORK_ERROR" });
      };
      expect((await node.kv.get("notes/seed")).data?.data).toBe("seed-v0");
      const uncovered = await node.kv.get("outside/secret");
      expect(uncovered.ok ? undefined : uncovered.error.code).toBe("NETWORK_ERROR");
    } finally {
      await node.replication?.close();
      await rm(profile.profileDir, { recursive: true, force: true });
    }
  }, 120_000);
  test("folder replica serves descendants locally and falls back for its ancestor LIST", async () => {
    const profile = await guardedProfile("tc858-folder-prefix-");
    const events: ReplicationEvent[] = [];
    const node = new TinyCloudNode({
      host,
      signer: new PrivateKeySigner(RESTORE_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
      domain: "replication.test",
      autoCreateSpace: true,
      autoBootstrapAccount: false,
      enablePublicSpace: false,
      replication: {
        enabled: true,
        prefixes: ["notes/"],
        storage: profile.storage,
        profileDir: profile.profileDir,
        profileGuard: profile.guard,
        mode: "foreground",
        onEvent: (event) => events.push(event),
      },
    });
    try {
      await node.signIn();
      expect(node.replicaStamp).toMatchObject({ incarnation: expect.any(String), lifecycleEpoch: 0 });
      const write = await node.kv.put("notes/a", "descendant");
      expect(write.ok, JSON.stringify(write.ok ? undefined : write.error)).toBe(true);
      await node.replication!.sync();
      expect(await node.replication!.status()).toMatchObject([
        { prefix: "notes/", state: "ready", coverage: "complete", grant: { unconstrained: true } },
      ]);

      const ancestorList = await node.kv.withPrefix("notes").list();
      expect(ancestorList.ok).toBe(true);
      expect(ancestorList.ok && ancestorList.data.keys).toContain("a");
      expect(events.some((event) => event.type === "replication.read" && event.key === "notes" && event.source === "network")).toBe(true);

      const service = node as unknown as { _serviceContext: ServiceContext };
      const serviceContext = service._serviceContext;
      const fetchContext = serviceContext as unknown as { _fetch: typeof fetch };
      fetchContext._fetch = async () => {
        throw Object.assign(new Error("network unavailable"), { code: "NETWORK_ERROR" });
      };
      expect((await node.kv.get("notes/a")).data?.data).toBe("descendant");
      expect(events.some((event) =>
        event.type === "replication.read" && event.key === "notes/a" &&
        event.source === "replica" && event.reason === "hit"
      )).toBe(true);
    } finally {
      await node.replication?.close();
      await rm(profile.profileDir, { recursive: true, force: true });
    }
  }, 120_000);
  test("compact delegates stay inside their signed scope across isolated owner profiles", async () => {
    const ownerProfile = await guardedProfile("tc858-delegate-owner-");
    const otherProfile = await guardedProfile("tc858-delegate-other-");
    const config = (key: string, prefixes: string[], profile: Awaited<ReturnType<typeof guardedProfile>>) => new TinyCloudNode({
      host,
      signer: new PrivateKeySigner(key),
      wasmBindings: new NodeWasmBindings(),
      domain: "replication.test",
      autoCreateSpace: true,
      autoBootstrapAccount: false,
      enablePublicSpace: false,
      replication: {
        enabled: true, prefixes, storage: profile.storage, profileDir: profile.profileDir,
        profileGuard: profile.guard, mode: "foreground",
      },
    });
    const owner = config(RESTORE_PRIVATE_KEY, ["notes/"], ownerProfile);
    const otherOwner = config("6cbed15c177e29b05bd3d60c4e1dd63e172b4b3b0b34f5a38e7f92e2c79ef801", ["notes/"], otherProfile);
    const wasm = new NodeWasmBindings();
    const manager = wasm.createSessionManager();
    const keyId = manager.createSessionKey("scope-limited");
    const delegateJwk = JSON.parse(manager.jwk(keyId)!);
    const delegateVerificationMethod = manager.getDID(keyId);
    const originalFetch = globalThis.fetch;
    let delegatePosts = 0;
    let ownerSpace = "";
    let otherSpace = "";
    let compact: {
      delegationHeader: { Authorization: string };
      delegationCid: string;
      spaceId: string;
      jwk: object;
      verificationMethod: string;
      tinycloudHosts: string[];
      replicaStamp: NonNullable<TinyCloudNode["replicaStamp"]>;
    };
    const delegateEvents: import("@tinycloud/sdk-services").ReplicationEvent[] = [];
    const delegate = new TinyCloudNode({
      host,
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
      enablePublicSpace: false,
      replication: {
        enabled: true,
        prefixes: ["notes/"],
        storage: ownerProfile.storage,
        profileDir: ownerProfile.profileDir,
        profileGuard: ownerProfile.guard,
        mode: "foreground",
        onEvent: (event) => delegateEvents.push(event),
      },
    });
    const mismatched = new TinyCloudNode({
      host,
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
      enablePublicSpace: false,
      replication: {
        enabled: true, prefixes: ["notes/"], storage: ownerProfile.storage,
        profileDir: ownerProfile.profileDir, profileGuard: ownerProfile.guard, mode: "foreground",
      },
    });
    try {
      await owner.signIn();
      const ownerStamp = owner.replicaStamp;
      if (!ownerStamp) throw new Error("Verified owner sign-in did not establish a replica stamp.");
      ownerSpace = owner.restorableSession!.spaceId;
      expect((await owner.kv.put("notes/secret", "owner-x")).ok).toBe(true);
      expect((await owner.kv.put("other/x", "owner-x-other")).ok).toBe(true);
      await owner.replication!.sync();

      await otherOwner.signIn();
      expect(otherOwner.replicaStamp).toMatchObject({ incarnation: expect.any(String), lifecycleEpoch: 0 });
      otherSpace = otherOwner.restorableSession!.spaceId;
      expect(otherSpace).not.toBe(ownerSpace);
      expect((await otherOwner.kv.put("notes/secret", "owner-y")).ok).toBe(true);
      await otherOwner.replication!.sync();

      const grant = await owner.delegateTo(delegateVerificationMethod.split("#")[0]!, [{
        service: "tinycloud.kv",
        space: ownerSpace,
        path: "other/",
        actions: ["tinycloud.kv/get"],
      }]);
      compact = {
        delegationHeader: grant.delegation.delegationHeader,
        delegationCid: grant.delegation.cid,
        spaceId: ownerSpace,
        jwk: delegateJwk,
        verificationMethod: delegateVerificationMethod,
        replicaStamp: ownerStamp,
        tinycloudHosts: [host],
      };
      await owner.replication!.close();
      await otherOwner.replication!.close();
      // Isolate the /delegate counter: sign-in's background registry sync can still be
      // hosting the account space (a /delegate POST) after the first writes.
      await owner.waitForAccountRegistrySync();
      await otherOwner.waitForAccountRegistrySync();

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/delegate")) delegatePosts++;
        return originalFetch(input, init);
      }) as typeof fetch;
      await delegate.restoreSession(compact);
      const unauthorized = await delegate.kv.get("notes/secret");
      expect(unauthorized.ok ? undefined : unauthorized.error.code).toBe("AUTH_UNAUTHORIZED");
      expect(delegatePosts).toBe(0);
      expect(delegateEvents.some((event) =>
        event.type === "replication.read" && event.key === "notes/secret" &&
        event.source === "replica" && event.reason === "hit"
      )).toBe(false);

      await mismatched.restoreSession({ ...compact, spaceId: otherSpace });
      expect(await mismatched.replication!.status()).toMatchObject([{
        prefix: "notes/",
        state: "gated",
        gate: "principal_mismatch",
        errorCode: "REPLICA_GATED",
      }]);
      const crossOwner = await mismatched.kv.get("notes/secret");
      expect(crossOwner.ok ? undefined : crossOwner.error.code).toBe("AUTH_UNAUTHORIZED");
      expect(delegatePosts).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([owner.replication?.close(), otherOwner.replication?.close(), delegate.replication?.close(), mismatched.replication?.close()]);
      await Promise.all([
        rm(ownerProfile.profileDir, { recursive: true, force: true }),
        rm(otherProfile.profileDir, { recursive: true, force: true }),
      ]);
    }
  }, 120_000);

  test("compact delegate cannot reuse an owner's grant, but can serve its own installed signed grant offline", async () => {
    const profile = await guardedProfile("tc858-delegate-offline-");
    const owner = new TinyCloudNode({
      host,
      signer: new PrivateKeySigner(RESTORE_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
      domain: "replication.test",
      autoCreateSpace: true,
      autoBootstrapAccount: false,
      enablePublicSpace: false,
      replication: {
        enabled: true, prefixes: ["notes/"], storage: profile.storage,
        profileDir: profile.profileDir, profileGuard: profile.guard, mode: "foreground",
      },
    });
    const wasm = new NodeWasmBindings();
    const manager = wasm.createSessionManager();
    const keyId = manager.createSessionKey("offline-delegate");
    const compactSession = JSON.parse(manager.jwk(keyId)!);
    const verificationMethod = manager.getDID(keyId);
    const offlineEvents: import("@tinycloud/sdk-services").ReplicationEvent[] = [];
    const offlineOptions = {
      host,
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
      enablePublicSpace: false,
      replication: {
        enabled: true,
        prefixes: ["notes/"],
        storage: profile.storage,
        profileDir: profile.profileDir,
        profileGuard: profile.guard,
        mode: "foreground" as const,
        onEvent: (event: import("@tinycloud/sdk-services").ReplicationEvent) => offlineEvents.push(event),
      },
    };
    const onlineDelegate = new TinyCloudNode(offlineOptions);
    const offline = new TinyCloudNode(offlineOptions);
    const installedOffline = new TinyCloudNode(offlineOptions);
    const originalFetch = globalThis.fetch;
    try {
      await owner.signIn();
      const ownerStamp = owner.replicaStamp;
      if (!ownerStamp) throw new Error("Verified owner sign-in did not establish a replica stamp.");
      const signedOwner = owner.restorableSession!;
      if (typeof signedOwner.siwe !== "string" || typeof signedOwner.address !== "string" ||
          typeof signedOwner.chainId !== "number") throw new Error("Signed owner proof is required.");
      const spaceId = signedOwner.spaceId;
      expect((await owner.kv.put("notes/covered", "cached")).ok).toBe(true);
      await owner.replication!.sync();
      const ownerSyncedEpoch = (await owner.replication!.status())[0]?.syncedThroughEpoch;
      if (ownerSyncedEpoch === undefined || !Number.isSafeInteger(ownerSyncedEpoch)) {
        throw new Error("Owner replica must have a committed sync fence.");
      }
      const grant = await owner.delegateTo(verificationMethod.split("#")[0]!, [{
        service: "tinycloud.kv",
        space: spaceId,
        path: "notes/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/sync"],
      }]);
      await onlineDelegate.restoreSession({
        delegationHeader: grant.delegation.delegationHeader,
        delegationCid: grant.delegation.cid,
        spaceId,
        jwk: compactSession,
        verificationMethod,
        tinycloudHosts: [host],
        replicaStamp: ownerStamp,
      });
      await expect(onlineDelegate.replication!.sync()).rejects.toMatchObject({ name: "ReplicaError", code: "GRANT_MISSING" });
      await onlineDelegate.replication!.close();
      // Isolate the /delegate counter from sign-in's background registry sync (see above).
      await owner.waitForAccountRegistrySync();
      let delegatePosts = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/delegate")) delegatePosts++;
        throw Object.assign(new TypeError("network unavailable"), { code: "ECONNREFUSED" });
      }) as typeof fetch;
      await offline.restoreSession({
        delegationHeader: grant.delegation.delegationHeader,
        delegationCid: grant.delegation.cid,
        spaceId,
        jwk: compactSession,
        verificationMethod,
        tinycloudHosts: [host],
        replicaStamp: ownerStamp,
      });
      expect(delegatePosts).toBe(0);
      const withoutInstall = await offline.kv.get("notes/covered");
      expect(withoutInstall.ok).toBe(false);
      expect(offlineEvents.some((event) =>
        event.type === "replication.read" && event.key === "notes/covered" &&
        event.source === "network" && event.reason === "grant_missing" && event.outcome === "error"
      )).toBe(true);
      expect(offlineEvents.some((event) =>
        event.type === "replication.read" && event.key === "notes/covered" &&
        event.source === "replica" && event.reason === "hit"
      )).toBe(false);

      globalThis.fetch = originalFetch;
      await owner.replication!.close();
      await offline.replication!.close();
      const handle = await profile.storage.open({
        identity: canonicalReplicationIdentity({
          host, space: spaceId, principal: pkhDid(signedOwner.address, signedOwner.chainId),
        }),
        space: spaceId,
        prefix: "notes/",
        allowSecrets: false,
        stamp: ownerStamp,
        device: { did: verificationMethod, jwk: compactSession },
        grantPolicy: {
          grantTtlMs: 24 * 60 * 60_000,
          consentAnchor: { source: "siwe", at: Date.parse(signedOwner.siwe.match(/^Issued At: (.+)$/m)![1]!) },
        },
      });
      try {
        const installed = await handle.installGrant(grant.delegation.delegationHeader.Authorization);
        expect(installed).toMatchObject({ parentCid: expect.any(String), unconstrained: true });
        await handle.sync({ signal: new AbortController().signal, syncStartEpoch: ownerSyncedEpoch });
        expect((await handle.get("notes/covered")).status).toBe("present");
      } finally {
        await handle.close();
      }
      globalThis.fetch = async () => {
        throw Object.assign(new TypeError("network unavailable"), { code: "ECONNREFUSED" });
      };
      const eventCursor = offlineEvents.length;
      await installedOffline.restoreSession({
        delegationHeader: grant.delegation.delegationHeader,
        delegationCid: grant.delegation.cid,
        spaceId,
        jwk: compactSession,
        verificationMethod,
        tinycloudHosts: [host],
        replicaStamp: ownerStamp,
      });
      const read = await installedOffline.kv.get("notes/covered");
      expect(read.data?.data).toBe("cached");
      expect(offlineEvents.slice(eventCursor).some((event) =>
        event.type === "replication.read" && event.key === "notes/covered" &&
        event.source === "replica" && event.reason === "hit"
      )).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([owner.replication?.close(), onlineDelegate.replication?.close(), offline.replication?.close(), installedOffline.replication?.close()]);
      await rm(profile.profileDir, { recursive: true, force: true });
    }
  }, 120_000);

  test("developer mode: one real sync cycle records only sanitized sync rows, one per HTTP attempt", async () => {
    const profile = await guardedProfile("tc848-sync-log-");
    const events: ReplicationEvent[] = [];
    const node = new TinyCloudNode({
      host,
      signer: new PrivateKeySigner(RESTORE_PRIVATE_KEY),
      wasmBindings: new NodeWasmBindings(),
      domain: "replication.test",
      autoCreateSpace: true,
      autoBootstrapAccount: false,
      enablePublicSpace: false,
      requestLog: true,
      replication: {
        enabled: true,
        prefixes: ["notes/"],
        storage: profile.storage,
        profileDir: profile.profileDir,
        profileGuard: profile.guard,
        mode: "foreground",
        onEvent: (event) => events.push(event),
      },
    });
    // Count HTTP attempts issued during the sync window only. Fetch is captured when the node's
    // services are built, so the counter is installed before `new TinyCloudNode` and restored in `finally`.
    const originalFetch = globalThis.fetch;
    let counting = false;
    let attempts = 0;
    const countedUrls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (counting) {
        attempts += 1;
        countedUrls.push(`${init?.method ?? "GET"} ${String(input)}`);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await node.signIn();
      expect((await node.kv.put("notes/sync-log-seed", "sync-log-v0")).ok).toBe(true);
      const baseline = node.requests!.snapshot().length;
      counting = true;
      await node.replication!.sync();
      counting = false;

      const windowRows = node.requests!.snapshot().slice(baseline);
      const syncRows = windowRows.filter((event) => event.service === "sync");
      expect(syncRows.length).toBeGreaterThan(0);
      expect(windowRows.every((event) => event.service === "sync")).toBe(true);
      for (const row of syncRows) {
        expect(row.path).toBeNull();
        expect(row.space).toBeNull();
      }
      const serialized = JSON.stringify(syncRows);
      expect(serialized).not.toContain("notes/");
      expect(serialized).not.toContain("sync-log-seed");
      // One row per logical call, carrying its HTTP attempts (a retried call is one row, attempts > 1).
      // Summing attempts still requires every counted HTTP attempt to appear in some row.
      console.log("TC848_DIAG " + JSON.stringify({ countedUrls, rows: windowRows.map((r) => ({ service: r.service, op: r.op, code: r.code, attempts: r.attempts })) }));
      expect(syncRows.reduce((total, row) => total + row.attempts, 0)).toBe(attempts);
    } finally {
      counting = false;
      globalThis.fetch = originalFetch;
      await node.replication?.close();
      await rm(profile.profileDir, { recursive: true, force: true });
    }
  }, 120_000);
});
