import { describe, expect, test } from "bun:test";
import { ServiceContext } from "@tinycloud/sdk-core";
import {
  canonicalReplicationIdentity,
  createMemoryPendingStore,
  type KVReadThrough,
  type KVReplicaHandle,
  type KVReplicaStorage,
  type LocalReplicaStatus,
  type PendingWriteStore,
  type ReplicationAuthority,
  type ReplicationScheduler,
} from "@tinycloud/sdk-services";
import { ReplicationRuntime } from "./runtime";

const address = "0x0000000000000000000000000000000000000001";
const space = `tinycloud:pkh:eip155:1:${address}:default`;
const identity = canonicalReplicationIdentity({
  host: "https://node.example",
  space,
  principal: `did:pkh:eip155:1:${address}`,
});
const now = 1_700_000_000_000;
const expiringAt = now + 240_000;
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

function harness(options: {
  prefixes?: string[];
  mode?: "background" | "foreground";
  initialGrant?: (prefix: string) => LocalReplicaStatus["grant"];
  sessionGrant?: ReplicationAuthority["sessionGrant"];
  plan?: ReplicationAuthority["plan"];
  mint?: ReplicationAuthority["mint"];
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
  const runtime = (prefixes = options.prefixes ?? ["notes"]) => new ReplicationRuntime({
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
      prefixes: ["notes"],
      mode: "background",
      scheduler: clock,
      initialGrant: () => ({ cid: "bafy-installed", parentCid: "bafy-parent", expiresAt: expiringAt, state: "active", unconstrained: true }),
      plan: () => ({ path: "runtime", parentCid: "bafy-parent", expiresAt: expiringAt }),
    });
    const runtime = env.runtime();
    runtime.bind({ context: new ServiceContext({ invoke: async () => ({} as never), hosts: [identity.host], fetch: async () => new Response() }), session, address, chainId: 1, authority: env.authority, primaryKV: [] });
    const status = await runtime.control.status();
    expect(status.map((entry) => entry.prefix)).toEqual(["notes"]);
    await runtime.control.sync();
    expect(env.syncs).toContain("notes");
    const beforeInterval = env.syncs.length;
    expect(scheduledDelay).toBeGreaterThan(0);
    const intervalSync = env.nextSync();
    interval?.();
    await intervalSync;
    expect(env.syncs.length).toBeGreaterThan(beforeInterval);
    expect(await runtime.control.purge()).toEqual({ purged: ["notes"], failed: [] });
    expect(env.purges).toEqual(["notes"]);
    await runtime.control.close();
  });

  test("partial authority opens only covered prefixes and preserves pending state on re-sign-in", async () => {
    const env = harness({
      prefixes: ["notes", "photos"],
      sessionGrant: (prefix) => prefix === "notes"
        ? { ucan: "session-grant", device: { did: "did:key:zSession", jwk: {} } }
        : { refused: "NOT_COVERED" },
      plan: (prefix) => prefix === "notes"
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
    expect(status.map((entry) => entry.prefix)).toEqual(["notes", "photos"]);
    await runtime.control.sync().catch(() => undefined);
    expect(env.events.some((event) => event.type === "replication.state" && event.replica === "notes" && event.state === "grant_installed")).toBe(true);
    expect(env.events.some((event) => event.type === "replication.state" && event.replica === "photos" && event.state === "grant_missing")).toBe(true);
    expect(env.opened).toContain("notes");
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
      initialGrant: () => ({ cid: "bafy-installed", parentCid: "bafy-old-parent", expiresAt: expiringAt, state: "active", unconstrained: true }),
      plan: () => ({ path: "runtime", parentCid: "bafy-parent", expiresAt: expiringAt }),
      mint: async () => { throw new Error("offline"); },
    });
    const runtime = env.runtime();
    runtime.bind({ context: new ServiceContext({ invoke: async () => ({} as never), hosts: [identity.host], fetch: async () => new Response() }), session, address, chainId: 1, authority: env.authority, primaryKV: [] });
    const status = await runtime.control.status();
    await runtime.control.sync();
    expect(env.events.some((event) => event.type === "replication.state" && event.replica === "notes" && event.state === "grant_installed")).toBe(true);
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
});
