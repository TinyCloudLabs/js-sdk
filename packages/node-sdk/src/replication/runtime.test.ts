import { describe, expect, test } from "bun:test";
import { ServiceContext, ok, type KVReadThrough, type KVReplicaHandle, type KVReplicaStorage, type PendingWriteStore, type ReplicationScheduler } from "@tinycloud/sdk-services";
import { createMemoryPendingStore } from "@tinycloud/sdk-services/kv/replication";
import type { ServiceSession } from "@tinycloud/sdk-core";
import { ReplicationRuntime } from "./runtime";

const address = "0x0000000000000000000000000000000000000001";
const primarySpace = `tinycloud:pkh:eip155:1:${address}:default`;
const session: ServiceSession = {
  delegationHeader: { Authorization: "Bearer session" },
  delegationCid: "bafySession",
  spaceId: primarySpace,
  verificationMethod: "did:key:zSession",
  jwk: {},
};
const authority = {
  sessionGrant: () => ({ refused: "NOT_COVERED" as const }),
  plan: () => ({ refused: "NOT_COVERED" as const }),
  async mint() { throw new Error("unexpected mint"); },
};
const clock: ReplicationScheduler = {
  now: () => 1_700_000_000_000,
  setTimeout: () => () => undefined,
};

function context(host: string): ServiceContext {
  return new ServiceContext({
    invoke: async () => ({} as never),
    hosts: [host],
    fetch: async () => new Response("not used"),
  });
}

describe("node ReplicationRuntime binding", () => {
  test("binds by canonical host/session identity and shares pending state on session replacement", async () => {
    let pendingStores = 0;
    const storage = {
      kind: "sqlite",
      async open() { throw new Error("lazy runtime must not open storage during bind"); },
      async purge() {},
      pendingWrites(identity: Parameters<typeof createMemoryPendingStore>[0]) {
        pendingStores++;
        return createMemoryPendingStore(identity);
      },
    } as KVReplicaStorage;
    const runtime = new ReplicationRuntime({ enabled: true, prefixes: ["notes/"], storage }, clock);
    let attached: KVReadThrough | null = null;
    const kv = { setReadThrough(value: KVReadThrough | null) { attached = value; } };
    const binding = (host: string, delegationCid: string) => ({
      context: context(host),
      session: { ...session, delegationCid },
      address,
      chainId: 1,
      authority,
      primaryKV: [{ space: primarySpace, kv }],
    });

    await runtime.bind(binding("HTTPS://Node.Example:443/", "bafyFirst"));
    expect(attached).not.toBeNull();
    const first = await runtime.control.status();
    expect(first.map((entry) => entry.prefix)).toEqual(["notes/"]);
    await runtime.bind(binding("https://node.example", "bafyReplacement"));
    expect(pendingStores).toBe(1);
    expect(await runtime.control.status()).toMatchObject([{ prefix: "notes/", pending: { inFlight: 0, committed: 0, ambiguous: 0 } }]);

    runtime.attach("another-space", kv);
    expect(attached).toBeNull();
    runtime.attach(primarySpace, kv);
    expect(attached).not.toBeNull();
    runtime.unbind();
    expect(attached).toBeNull();
    expect(await runtime.control.status()).toEqual([]);
    await runtime.control.sync();
  });

  test("gate-issued stamps bind pending writes and quota-limited opens across session replacement", async () => {
    const first = { incarnation: "gate", lifecycleEpoch: 1 };
    const second = { incarnation: "gate", lifecycleEpoch: 2 };
    let active = first;
    let pendingStores = 0;
    let syncs = 0;
    let firstPending: PendingWriteStore | undefined;
    const refusal = (gate: string) => Object.assign(new Error(`Replica gate refused: ${gate}`), { code: "REPLICA_GATED", gate });
    const check = (stamp: typeof first | undefined) => {
      if (!stamp) throw refusal("not_established");
      if (stamp.incarnation !== active.incarnation || stamp.lifecycleEpoch !== active.lifecycleEpoch) throw refusal("stamp_stale");
    };
    const grant = {
      cid: "installed", parentCid: null, expiresAt: clock.now() + 120_000,
      installedAt: clock.now(), effectiveExpiresAt: clock.now() + 120_000,
      consentDeadline: clock.now() + 604_800_000, state: "active" as const, unconstrained: true,
    };
    const storage: KVReplicaStorage = {
      kind: "indexeddb",
      lifecycle: {
        kind: "indexeddb",
        checkDelivery(stamp) {
          return !stamp ? { status: "gated", gate: "not_established" }
            : stamp.incarnation === active.incarnation && stamp.lifecycleEpoch === active.lifecycleEpoch
              ? { status: "allow" } : { status: "gated", gate: "stamp_stale" };
        },
        consentDeadline: () => clock.now() + 604_800_000,
      } as NonNullable<KVReplicaStorage["lifecycle"]>,
      pendingWrites(identity, options) {
        check(options?.stamp);
        pendingStores++;
        const bound = options!.stamp!;
        const store = createMemoryPendingStore(identity);
        const gated = {
          ...store,
          read: async () => { check(bound); return store.read(); },
          update: async (mutate: Parameters<PendingWriteStore["update"]>[0]) => { check(bound); return store.update(mutate); },
        };
        if (bound.lifecycleEpoch === first.lifecycleEpoch) firstPending = gated;
        return gated;
      },
      async open(spec) {
        check(spec.stamp);
        if (spec.grantPolicy?.grantTtlMs !== 120_000 ||
            spec.quota?.maxBytes !== 4_096 || spec.quota.minFreeBytes !== 512) {
          throw Object.assign(new Error("Configured grant and quota policy required"), { code: "REPLICA_INVALID_ARGUMENT" });
        }
        return {
          spec, deviceDid: "did:key:replica",
          async grant() { return grant; },
          async installGrant() { throw new Error("Installed grant must be reused"); },
          async sync({ syncStartEpoch }) {
            check(spec.stamp);
            syncs++;
            return { status: "synced", pages: 0, changes: 0, deleted: 0, fetched: 0, contentMissing: 0, coverage: "complete", syncedThroughEpoch: syncStartEpoch };
          },
          async close() {},
        } as KVReplicaHandle;
      },
      async purge() {},
    };
    const runtime = new ReplicationRuntime({
      enabled: true, prefixes: ["notes/"], storage, grantTtlMs: 120_000, maxBytes: 4_096, minFreeBytes: 512,
    }, clock);
    const sessionAuthority = {
      sessionOnly: true,
      sessionGrant: () => ({ ucan: "current-session", device: { did: "did:key:replica", jwk: {} } }),
      plan: () => { throw new Error("Session-only authority must not plan"); },
      mint: async () => { throw new Error("Session-only authority must not mint"); },
    };
    const bind = (stamp: typeof first) => runtime.bind({
      context: context("https://gate.example"), session, address, chainId: 1, stamp,
      authority: sessionAuthority, primaryKV: [],
    });

    await bind(first);
    await runtime.control.sync();
    active = second;
    await expect(firstPending!.read()).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "stamp_stale" });
    await bind(second);
    await runtime.control.sync();
    expect(pendingStores).toBe(2);
    expect(syncs).toBe(2);
    await expect(runtime.bind({
      context: context("https://gate.example"), session, address, chainId: 1,
      authority: sessionAuthority, primaryKV: [],
    })).rejects.toMatchObject({ code: "REPLICA_GATED", gate: "not_established" });
    await runtime.control.close();
  });

  test("isolates pending stores when the bind host changes", async () => {
    const identities: string[] = [];
    const storage = {
      kind: "sqlite",
      async open() { throw new Error("unexpected open"); },
      async purge() {},
      pendingWrites(identity: Parameters<typeof createMemoryPendingStore>[0]) {
        identities.push(JSON.stringify(identity));
        return createMemoryPendingStore(identity);
      },
    } as KVReplicaStorage;
    const runtime = new ReplicationRuntime({ enabled: true, prefixes: ["notes/"], storage }, clock);
    const bind = (host: string) => runtime.bind({
      context: context(host), session, address, chainId: 1, authority,
      primaryKV: [{ space: primarySpace, kv: { setReadThrough() {} } }],
    });

    await bind("https://one.example");
    await bind("https://two.example");
    expect(identities).toHaveLength(2);
    expect(identities[0]).not.toBe(identities[1]);
    expect(JSON.parse(identities[0]!).host).toBe("https://one.example");
    expect(JSON.parse(identities[1]!).host).toBe("https://two.example");
  });
  test("bind and unbind chains wait for every outstanding controller close", async () => {
    let opened = 0;
    let releaseA!: () => void;
    const closeA = new Promise<void>((resolve) => { releaseA = resolve; });
    const storage: KVReplicaStorage = {
      kind: "sqlite",
      async open(spec) {
        opened++;
        return {
          spec,
          deviceDid: "did:key:replica",
          async get(key) { return { status: "absent", key, meta: { asOf: new Date(0).toISOString(), coverage: "complete", authority: "valid", syncedThroughEpoch: 0 } }; },
          async list() { return { keys: [], meta: { asOf: new Date(0).toISOString(), coverage: "complete", authority: "valid", syncedThroughEpoch: 0 } }; },
          async grant() { return null; },
          async installGrant() { throw new Error("unexpected grant install"); },
          async sync({ syncStartEpoch }) { return { status: "synced", pages: 0, changes: 0, deleted: 0, fetched: 0, contentMissing: 0, coverage: "complete", syncedThroughEpoch: syncStartEpoch }; },
          async status() { return { coverage: "complete", lastSyncAt: new Date(0).toISOString(), syncedThroughEpoch: 0, authority: { state: "valid", expiresAt: Date.now() + 60_000 }, grant: null, counts: { keys: 0, contentMissing: 0, tombstones: 0 }, bytes: 0, lastError: null }; },
          async close() { if (spec.identity.host === "https://a.example") await closeA; },
        } as KVReplicaHandle;
      },
      async purge() {},
      pendingWrites: createMemoryPendingStore,
    };
    const runtime = new ReplicationRuntime({ enabled: true, prefixes: ["notes/"], storage }, clock);
    const bind = (host: string) => runtime.bind({
      context: context(host),
      session,
      address,
      chainId: 1,
      authority,
      primaryKV: [],
    });

    await bind("https://a.example");
    await runtime.control.sync();
    expect(opened).toBe(1);
    await bind("https://b.example");
    await bind("https://c.example");
    const syncingC = runtime.control.sync();
    await Promise.resolve();
    expect(opened).toBe(1);

    releaseA();
    await syncingC;
    expect(opened).toBe(2);
    await runtime.control.close();
  });

  test("clearPending reaches the last identity store after unbind", async () => {
    let pending: ReturnType<typeof createMemoryPendingStore> | undefined;
    const storage = {
      kind: "sqlite",
      async open() { throw new Error("unexpected open"); },
      async purge() {},
      pendingWrites(identity: Parameters<typeof createMemoryPendingStore>[0]) {
        pending = createMemoryPendingStore(identity);
        return pending;
      },
    } as KVReplicaStorage;
    const runtime = new ReplicationRuntime({ enabled: true, prefixes: ["notes/"], storage }, clock);
    await runtime.bind({
      context: context("https://clear.example"),
      session,
      address,
      chainId: 1,
      authority,
      primaryKV: [],
    });
    await pending!.update((state) => {
      state.seq++;
      state.records.push({
        opId: "ambiguous",
        seq: state.seq,
        key: "notes/a",
        op: "put",
        state: "ambiguous",
        epoch: null,
        at: new Date(0).toISOString(),
        settledAt: new Date(0).toISOString(),
      });
    });
    await runtime.unbind();
    expect(await runtime.control.clearPending()).toBe(1);
    expect((await pending!.read()).records).toEqual([]);
  });

  test("purge requested during bind stops the controller before timers can start", async () => {
    let timers = 0;
    let purges = 0;
    const scheduled: ReplicationScheduler = {
      now: () => clock.now(),
      setTimeout() {
        timers++;
        return () => { timers--; };
      },
    };
    const storage: KVReplicaStorage = {
      kind: "sqlite",
      async open() { throw new Error("purged controller must not open"); },
      async purge() { purges++; },
      pendingWrites: createMemoryPendingStore,
    };
    const runtime = new ReplicationRuntime({ enabled: true, prefixes: ["notes/"], storage, mode: "background" }, scheduled);
    const binding = runtime.bind({
      context: context("https://purge-bind.example"),
      session,
      address,
      chainId: 1,
      authority,
      primaryKV: [],
    });
    const purging = runtime.control.purge();
    expect(timers).toBe(0);
    await Promise.all([binding, purging]);
    expect(timers).toBe(0);
    expect(purges).toBe(1);
    await runtime.control.close();
  });
  test("a committed browser expiry reaches only the bound opened controller", async () => {
    const stamp = { incarnation: "current", lifecycleEpoch: 2 };
    const events: Array<{ type: string; action?: string; replicaId?: string }> = [];
    const subscribers = new Set<(stamp: typeof stamp) => void>();
    let stale = false;
    let redundantDenials = 0;
    let localReads = 0;
    let attached: KVReadThrough | null = null;
    const storage: KVReplicaStorage = {
      kind: "indexeddb",
      lifecycle: {
        kind: "indexeddb",
        consentDeadline: () => clock.now() + 60_000,
        checkDelivery: () => stale ? { status: "gated", gate: "stamp_stale" } : { status: "allow" },
        subscribeConsentExpired(listener: (stamp: typeof stamp) => void) {
          subscribers.add(listener);
          return () => { subscribers.delete(listener); };
        },
        async deny() { redundantDenials++; return { status: "denied", lifecycleEpoch: 3, intents: 1 }; },
      } as unknown as NonNullable<KVReplicaStorage["lifecycle"]>,
      async open(spec) {
        return {
          spec,
          deviceDid: "did:key:replica",
          replicaId: "opaque-run",
          async get(key) {
            localReads++;
            return {
              status: "present", key, value: new TextEncoder().encode('"local"'),
              etag: '"local"', metadata: { "content-type": "application/json" },
              meta: { asOf: new Date(clock.now()).toISOString(), coverage: "complete", authority: "valid", syncedThroughEpoch: 0 },
            };
          },
          async grant() {
            return { cid: "installed", parentCid: null, expiresAt: clock.now() + 60_000, state: "active", unconstrained: true,
              installedAt: clock.now(), effectiveExpiresAt: clock.now() + 60_000, consentDeadline: clock.now() + 60_000 };
          },
          async installGrant() { return this.grant(); },
          async status() {
            return { coverage: "complete", lastSyncAt: new Date(clock.now()).toISOString(), syncedThroughEpoch: 0,
              authority: { state: "valid", expiresAt: clock.now() + 60_000 }, grant: await this.grant(),
              counts: { keys: 1, contentMissing: 0, tombstones: 0 }, bytes: 1, lastError: null };
          },
          async close() {},
        } as KVReplicaHandle;
      },
      async purge() {},
      pendingWrites(identity) { return Object.assign(createMemoryPendingStore(identity), { durable: true }); },
    };
    const runtime = new ReplicationRuntime({
      enabled: true, prefixes: ["notes/"], storage, mode: "foreground",
      onEvent(event) { events.push(event); },
    }, clock);
    const binding = {
      context: context("https://expiry.example"), session, address, chainId: 1, stamp,
      authority: {
        ...authority,
        consentAnchor: () => ({ source: "siwe" as const, at: clock.now() }),
        sessionGrant: () => ({ ucan: "token", device: { did: "did:key:replica", jwk: {} } }),
      },
      primaryKV: [{ space: primarySpace, kv: { setReadThrough(value: KVReadThrough | null) { attached = value; } } }],
    };
    const network = async () => ok({ data: "network", headers: { get: () => null } });
    const read = () => attached!.get({ space: primarySpace, key: "notes/a", path: "notes/a",
      options: undefined, signal: new AbortController().signal, network });

    await runtime.bind(binding);
    expect(subscribers.size).toBe(1);
    const beforeExpiry = await read();
    expect(beforeExpiry.ok && beforeExpiry.data.data).toBe("local");
    expect(localReads).toBe(1);
    stale = true;
    for (const notify of subscribers) notify(stamp);
    const afterExpiry = await read();
    expect(afterExpiry.ok && afterExpiry.data.data).toBe("network");
    expect(localReads).toBe(1);
    expect(events.filter((event) => event.type === "replication.grant" && event.action === "consent_deadline_reached"))
      .toEqual([expect.objectContaining({ replicaId: "opaque-run" })]);
    expect(events.filter((event) => event.type === "replication.lifecycle" && event.action === "denied"))
      .toHaveLength(1);
    expect(redundantDenials).toBe(0);

    await runtime.bind(binding);
    expect(subscribers.size).toBe(1);
    await runtime.unbind();
    expect(subscribers.size).toBe(0);
    await runtime.control.close();
  });
});
