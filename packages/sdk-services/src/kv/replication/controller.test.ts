import { describe, expect, test } from "bun:test";
import { ok, type Result } from "../../types";
import { begin, settle } from "./pendingWrites";
import type { KVListOptions, KVResponse } from "../types";
import { canonicalReplicationIdentity } from "./identity";
import { createKVReplication } from "./controller";
import { encodeTcr1 } from "./listLocal";
import { createMemoryPendingStore } from "./memoryPendingStore";
import type { KVListPage, KVReplicaHandle, KVReplicaStorage, LocalReplicaStatus, PendingWriteStore, ReplicationEvent, ResolvedReplicationOptions } from "./types";
import { RequestTimeoutError } from "../../errors";

const identity = canonicalReplicationIdentity({ host: "https://node.example", space: "tinycloud:pkh:eip155:1:0xabc:default", principal: "did:pkh:eip155:1:0xabc" });
const status = (epoch = 0): LocalReplicaStatus => ({ coverage: "complete", lastSyncAt: new Date(1_000_000).toISOString(), syncedThroughEpoch: epoch, authority: { state: "valid", expiresAt: null }, grant: { cid: "grant", parentCid: null, expiresAt: null, state: "active", unconstrained: true }, counts: { keys: 1, contentMissing: 0, tombstones: 0 }, bytes: 1, lastError: null });
const options: ResolvedReplicationOptions = { enabled: true, prefixes: ["notes"], allowSecrets: false, syncIntervalMs: 60_000, maxStalenessMs: 120_000, staleSyncTimeoutMs: 10_000, verify: false };

function setup({ durable = true, initialEpoch = 0, onSync, statusOverrides = {}, localGetStatus = "present", syncOutcome = "synced", mode = "foreground", purgeImpl, verify = false, openError, runtimeMint, sessionOnly = false, sessionRefused = false, setTimeoutImpl = () => () => undefined }: {
  durable?: boolean;
  initialEpoch?: number;
  onSync?: (epoch: number, signal: AbortSignal) => Promise<void> | void;
  statusOverrides?: Partial<LocalReplicaStatus>;
  localGetStatus?: "present" | "absent" | "deleted" | "content_missing" | "throw";
  syncOutcome?: "synced" | "busy" | "network_error" | "node_error";
  mode?: "background" | "foreground";
  purgeImpl?: (target: { sessionDeviceDid?: string }) => void | Promise<void>;
  verify?: boolean;
  openError?: string;
  runtimeMint?: (signal: AbortSignal) => Promise<{ ucan: string; parentCid: string; expiresAt: number }>;
  sessionOnly?: boolean;
  sessionRefused?: boolean;
  setTimeoutImpl?: (fn: () => void, ms: number) => () => void;
} = {}) {
  let now = 1_000_000;
  let listReads = 0;
  let localStatus = { ...status(initialEpoch), ...statusOverrides };
  let localReads = 0;
  let syncs = 0;
  let opens = 0;
  let networkCalls = 0;
  const events: ReplicationEvent[] = [];
  const memory = createMemoryPendingStore(identity);
  const pending = durable ? ({ ...memory, durable: true } as PendingWriteStore) : memory;
  const handle = {
    spec: { identity, space: identity.space, prefix: "notes", allowSecrets: false }, deviceDid: identity.principal,
    async get(key: string) {
      localReads++;
      if (localGetStatus === "throw") throw Object.assign(new Error("local read failed"), { code: "INTEGRITY_ERROR" });
      const meta = { asOf: new Date(now).toISOString(), coverage: localStatus.coverage, authority: localStatus.authority.state, syncedThroughEpoch: localStatus.syncedThroughEpoch };
      if (localGetStatus !== "present") return { status: localGetStatus, key, meta };
      return { status: "present" as const, key, value: new TextEncoder().encode('"local"'), etag: '"blake3-local"', metadata: { "content-type": "application/json" }, meta };
    },
    async list() { listReads++; return { keys: ["notes/a"], meta: { asOf: new Date(now).toISOString(), coverage: "complete" as const, authority: "valid" as const, syncedThroughEpoch: localStatus.syncedThroughEpoch } }; },
    async grant() { return localStatus.grant; }, async installGrant() { return localStatus.grant!; },
    async sync({ signal, syncStartEpoch }: { signal: AbortSignal; syncStartEpoch: number }) {
      syncs++;
      await onSync?.(syncStartEpoch, signal);
      if (syncOutcome === "busy") return { status: "busy" as const };
      if (syncOutcome === "network_error" || syncOutcome === "node_error") throw Object.assign(new Error("sync failed"), { code: syncOutcome === "network_error" ? "NETWORK_ERROR" : "PROTOCOL_ERROR" });
      localStatus = { ...localStatus, syncedThroughEpoch: syncStartEpoch, lastSyncAt: new Date(now).toISOString() };
      return { status: "synced" as const, pages: 1, changes: 1, deleted: 0, fetched: 1, contentMissing: 0, coverage: "complete" as const, syncedThroughEpoch: syncStartEpoch };
    },
    async status() { return localStatus; }, async close() {},
  } as unknown as KVReplicaHandle;
  const storage: KVReplicaStorage = { kind: "sqlite", async open() { opens++; if (openError) throw Object.assign(new Error("open failed"), { code: openError }); return handle; }, async purge(target) { await purgeImpl?.(target); }, pendingWrites() { return pending; } };
  const controller = createKVReplication({ options: { ...options, verify }, mode, storage, identity, session: { id: "session", did: identity.principal, space: identity.space }, authority: { sessionOnly, sessionGrant: () => sessionRefused || runtimeMint ? { refused: "NOT_COVERED" } : ({ ucan: "token", device: { did: identity.principal, jwk: {} } }), plan: () => { if (sessionOnly) throw new Error("session-only authority consulted the plan"); return runtimeMint ? ({ path: "runtime", parentCid: "parent", expiresAt: now + 60_000 }) : ({ refused: "NOT_COVERED" }); }, async mint(_deviceDid, _prefix, signal) { return runtimeMint ? runtimeMint(signal) : Promise.reject(new Error("unexpected mint")); } }, pending, scheduler: { now: () => now, setTimeout: setTimeoutImpl }, emit: (event) => events.push(event) });
  return { controller, pending, events, counters: () => ({ localReads, syncs, opens, networkCalls }), listReads: () => listReads, network: async (): Promise<Result<KVResponse<unknown>>> => { networkCalls++; return ok({ data: "network", headers: { get: () => null } }); }, setNow: (value: number) => { now = value; }, setStatus: (value: LocalReplicaStatus) => { localStatus = value; } };
}

const readRequest = (network: () => Promise<Result<KVResponse<unknown>>>) => ({ space: identity.space, key: "notes/a", path: "notes/a", options: undefined, signal: new AbortController().signal, network });
const listRequest = (options: KVListOptions | undefined, network: () => Promise<Result<KVListPage>>) => ({ space: identity.space, listPath: "notes", options, signal: new AbortController().signal, network });

describe("KVReplication fallback and pending behavior", () => {
  test("session-only refusal ignores an installed grant and serves the network", async () => {
    const env = setup({ sessionOnly: true, sessionRefused: true });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("network");
    expect(env.counters().localReads).toBe(0);
    expect(env.counters().networkCalls).toBe(1);
    expect(env.events.some((event) => event.type === "replication.state" && event.state === "grant_missing")).toBe(true);
    expect(env.events.some((event) => event.type === "replication.read" && event.source === "network" && event.reason === "grant_missing")).toBe(true);
  });
  test("a previously installed grant cannot outlive the current session authority", async () => {
    const env = setup({ sessionRefused: true });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("network");
    expect(env.counters().localReads).toBe(0);
    expect(env.counters().networkCalls).toBe(1);
    expect(env.events.some((event) => event.type === "replication.state" && event.state === "grant_missing")).toBe(true);
    expect(env.events.some((event) => event.type === "replication.read" && event.source === "network" && event.reason === "grant_missing")).toBe(true);
  });

  const cases = [
    { name: "coverage incomplete", setup: () => setup({ statusOverrides: { coverage: "bootstrapping" } }), reason: "coverage_incomplete", localReads: 0, networkCalls: 1 },
    { name: "expired authority", setup: () => setup({ statusOverrides: { authority: { state: "expired", expiresAt: null } } }), reason: "grant_expired", localReads: 0, networkCalls: 1 },
    { name: "revoked authority", setup: () => setup({ statusOverrides: { authority: { state: "revoked", expiresAt: null } } }), reason: "grant_revoked", localReads: 0, networkCalls: 1 },
    { name: "not-yet-valid authority", setup: () => setup({ statusOverrides: { authority: { state: "not-yet-valid", expiresAt: null } } }), reason: "grant_not_yet_valid", localReads: 0, networkCalls: 1 },
    { name: "missing grant", setup: () => setup({ statusOverrides: { grant: null } }), reason: "grant_missing", localReads: 0, networkCalls: 1 },
    { name: "runtime unsupported", setup: () => setup({ openError: "RUNTIME_UNSUPPORTED" }), reason: "runtime_unsupported", localReads: 0, networkCalls: 1 },
    { name: "replica unavailable", setup: () => setup({ openError: "STORAGE_ERROR" }), reason: "replica_unavailable", localReads: 0, networkCalls: 1 },
    { name: "missing content", setup: () => setup({ localGetStatus: "content_missing" }), reason: "content_missing", localReads: 1, networkCalls: 1 },
    { name: "local storage error", setup: () => setup({ localGetStatus: "throw" }), reason: "replica_error", localReads: 1, networkCalls: 1 },
    { name: "busy stale sync", setup: () => setup({ syncOutcome: "busy" }), reason: "stale", localReads: 0, networkCalls: 1, stale: true, code: "REPLICA_BUSY" },
    { name: "non-network stale sync", setup: () => setup({ syncOutcome: "node_error" }), reason: "stale", localReads: 0, networkCalls: 1, stale: true, code: "PROTOCOL_ERROR" },
    { name: "offline stale sync", setup: () => setup({ syncOutcome: "network_error" }), reason: "hit", localReads: 1, networkCalls: 0, stale: true, syncError: "NETWORK_ERROR" },
    { name: "invalid sync timestamp", setup: () => setup({ statusOverrides: { lastSyncAt: "invalid" } }), reason: "hit", localReads: 1, networkCalls: 0, stale: true },
  ] as const;
  for (const scenario of cases) {
    test(scenario.name, async () => {
      const env = scenario.setup();
      if ("stale" in scenario && scenario.stale) env.setNow(1_200_001);
      const result = await env.controller.get(readRequest(env.network));
      expect(result.ok && result.data.data).toBe(scenario.reason === "hit" ? "local" : "network");
      expect(env.counters().localReads).toBe(scenario.localReads);
      expect(env.counters().networkCalls).toBe(scenario.networkCalls);
      const event = env.events.find((item) => item.type === "replication.read");
      expect(event?.type === "replication.read" && event.reason).toBe(scenario.reason);
      if ("code" in scenario) expect(event?.type === "replication.read" && event.code).toBe(scenario.code);
      if ("syncError" in scenario) expect(event?.type === "replication.read" && event.syncError).toBe(scenario.syncError);
    });
  }

  test("a network answer equal to an ambiguous write never resolves its record", async () => {
    const env = setup();
    await env.pending.update((state) => {
      begin(state, "op-1", [{ key: "notes/a", op: "put" }], new Date(1_000_000).toISOString());
      settle(state, "op-1", "ambiguous", new Date(1_000_000).toISOString(), "TIMEOUT");
    });
    const result = await env.controller.get(readRequest(async () => ok({ data: "local", headers: { get: () => null } })));
    expect(result.ok && result.data.data).toBe("local");
    expect((await env.pending.read()).records[0]?.state).toBe("ambiguous");
    expect(env.counters().localReads).toBe(0);
  });

  test("a sync with no committed records does not update pending state", async () => {
    const env = setup();
    let updates = 0;
    const originalUpdate = env.pending.update.bind(env.pending);
    env.pending.update = async (mutate) => { updates++; return originalUpdate(mutate); };
    await env.controller.sync();
    expect(updates).toBe(0);
  });

  test("clearPending removes only ambiguous and old in-flight records, with an event", async () => {
    const env = setup();
    await env.pending.update((state) => {
      begin(state, "old", [{ key: "notes/old", op: "put" }], new Date(0).toISOString());
      begin(state, "young", [{ key: "notes/young", op: "put" }], new Date(1_000_000).toISOString());
      begin(state, "ambiguous", [{ key: "notes/ambiguous", op: "delete" }], new Date(1_000_000).toISOString());
      begin(state, "committed", [{ key: "notes/committed", op: "put" }], new Date(0).toISOString());
      settle(state, "ambiguous", "ambiguous", new Date(1_000_000).toISOString(), "TIMEOUT");
      settle(state, "committed", "committed", new Date(0).toISOString());
    });
    expect(await env.controller.clearPending()).toBe(2);
    expect((await env.pending.read()).records.map((record) => record.state)).toEqual(["in_flight", "committed"]);
    expect(env.events.some((event) => event.type === "replication.state" && event.state === "pending_cleared" && event.count === 2)).toBe(true);
  });

  test("a tcr1 continuation with a pending key restarts without a network call", async () => {
    const env = setup();
    await env.pending.update((state) => begin(state, "pending", [{ key: "notes/b", op: "put" }], new Date(1_000_000).toISOString()));
    const result = await env.controller.list({
      space: identity.space,
      listPath: "notes",
      options: { cursor: encodeTcr1(identity.space, "notes", "notes/a") },
      signal: new AbortController().signal,
      network: async () => { throw new Error("cursor restart must not use network"); },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.meta?.replication).toBe("cursor_restart");
    expect(env.counters().localReads).toBe(0);
  });
});
describe("KVReplication list parity and cursor rules", () => {
  const networkPage = async (): Promise<Result<KVListPage>> => ok({ keys: ["network/a"], truncated: false });

  test("serves covered local pages without consulting the network", async () => {
    const env = setup();
    const result = await env.controller.list(listRequest(undefined, networkPage));
    expect(result.ok && result.data.keys).toEqual(["notes/a"]);
    expect(env.listReads()).toBe(2);
    expect(env.counters().networkCalls).toBe(0);
  });

  const networkCases = [
    { name: "network cursor", options: { cursor: "node-cursor" }, reason: "network_cursor" },
    { name: "raw list", options: { raw: true }, reason: "unsupported_option" },
  ] as const;
  for (const scenario of networkCases) {
    test(`${scenario.name} uses the network`, async () => {
      const env = setup();
      let networkCalls = 0;
      const result = await env.controller.list(listRequest(scenario.options, async () => { networkCalls++; return networkPage(); }));
      expect(result.ok && result.data.keys).toEqual(["network/a"]);
      expect(networkCalls).toBe(1);
      expect(env.listReads()).toBe(0);
      expect(env.counters().opens).toBe(0);
      expect(env.events.some((event) => event.type === "replication.read" && event.reason === scenario.reason)).toBe(true);
    });
  }

  test("network-only lists emit NETWORK_REQUESTED without opening or syncing", async () => {
    const env = setup();
    let networkCalls = 0;
    const result = await env.controller.list(listRequest({ source: "network" }, async () => { networkCalls++; return networkPage(); }));
    expect(result.ok).toBe(true);
    expect(networkCalls).toBe(1);
    expect(env.listReads()).toBe(0);
    expect(env.counters()).toEqual({ localReads: 0, syncs: 0, opens: 0, networkCalls: 0 });
    const event = env.events.find((item) => item.type === "replication.read" && item.reason === "NETWORK_REQUESTED");
    expect(event?.type === "replication.read" ? [event.outcome, event.latencyMs] : undefined).toEqual(["found", 0]);
  });

  test("a tcr1 cursor for another space restarts without local or network access", async () => {
    const env = setup();
    let networkCalls = 0;
    const result = await env.controller.list(listRequest({ cursor: encodeTcr1("another-space", "notes", "notes/a") }, async () => { networkCalls++; return networkPage(); }));
    expect(result.ok).toBe(false);
    expect(networkCalls).toBe(0);
    expect(env.listReads()).toBe(0);
    expect(env.counters().opens).toBe(0);
    expect(env.events.some((event) => event.type === "replication.read" && event.reason === "cursor_restart")).toBe(true);
  });
});

describe("pending record evidence boundaries", () => {
  test("sync content and absence never resolve in-flight or ambiguous records", async () => {
    const env = setup();
    await env.pending.update((state) => {
      begin(state, "flight", [{ key: "notes/a", op: "put" }], new Date(1_000_000).toISOString());
      begin(state, "ambiguous", [{ key: "notes/b", op: "delete" }], new Date(1_000_000).toISOString());
      settle(state, "ambiguous", "ambiguous", new Date(1_000_000).toISOString(), "TIMEOUT");
    });
    await env.controller.sync();
    expect((await env.pending.read()).records.map((record) => record.state)).toEqual(["in_flight", "ambiguous"]);
  });

  test("status keeps pinned records ordered and capped, and reports preexisting pins once", async () => {
    const env = setup();
    await env.pending.update((state) => {
      begin(state, "pins", Array.from({ length: 101 }, (_, index) => ({ key: `notes/${String(index).padStart(3, "0")}`, op: "put" as const })), new Date(1_000_000).toISOString());
      settle(state, "pins", "ambiguous", new Date(1_000_000).toISOString(), "TIMEOUT");
    });
    const status = await env.controller.status();
    expect(status[0]?.pinned).toHaveLength(100);
    expect(status[0]?.pinned[0]?.key).toBe("notes/000");
    expect(status[0]?.pinned.at(-1)?.key).toBe("notes/099");
    await env.controller.get(readRequest(env.network));
    expect(env.events.filter((event) => event.type === "replication.state" && event.state === "pinned")).toHaveLength(1);
  });
});
describe("KVReplication inline verification", () => {
  test("reports divergence but returns the replica answer", async () => {
    const env = setup({ verify: true });
    let verificationCalls = 0;
    const value = await env.controller.get(readRequest(async () => {
      verificationCalls++;
      return ok({ data: "network", headers: { etag: '"network-etag"', get: () => null } });
    }));
    expect(value.ok && value.data.data).toBe("local");
    expect(verificationCalls).toBe(1);
    const divergence = env.events.find((event) => event.type === "replication.divergence");
    expect(divergence?.type === "replication.divergence" && divergence.kind).toBe("value");
    expect(env.events.some((event) => event.type === "replication.read" && event.verify === "diverged")).toBe(true);
  });
  test("caller cancellation during verification overrides the local result", async () => {
    const env = setup({ verify: true });
    const abort = new AbortController();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const resultPromise = env.controller.get({
      ...readRequest(async () => {
        started();
        return new Promise((_resolve, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true }));
      }),
      signal: abort.signal,
    });
    await requestStarted;
    abort.abort(Object.assign(new Error("deadline"), { code: "TIMEOUT" }));
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("TIMEOUT");
    expect(env.events.some((event) => event.type === "replication.read" && event.verify === "aborted")).toBe(true);
  });
});

describe("KVReplication purge lifecycle", () => {
  test("purge aborts an in-flight sync synchronously before its promise is awaited", async () => {
    let signalFromSync: AbortSignal | undefined;
    let started!: () => void;
    const syncStarted = new Promise<void>((resolve) => { started = resolve; });
    const env = setup({
      onSync: (_epoch, signal) => {
        signalFromSync = signal;
        started();
        return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    });
    const syncing = env.controller.sync().catch(() => undefined);
    await syncStarted;
    const purging = env.controller.purge({ timeoutMs: 50 });
    expect(signalFromSync?.aborted).toBe(true);
    expect(await purging).toEqual({ purged: ["notes"], failed: [] });
    await syncing;
  });

  test("purge never rejects when storage throws or exceeds its injected timeout", async () => {
    const immediateTimeout = (fn: () => void) => { fn(); return () => undefined; };
    const throwing = setup({ purgeImpl: () => { throw new Error("storage failure"); }, setTimeoutImpl: immediateTimeout });
    expect(await throwing.controller.purge({ timeoutMs: 20 })).toEqual({ purged: [], failed: [{ prefix: "notes", code: "REPLICA_UNAVAILABLE" }] });
    const hanging = setup({ purgeImpl: () => new Promise<void>(() => {}), setTimeoutImpl: immediateTimeout });
    expect(await hanging.controller.purge({ timeoutMs: 5 })).toEqual({ purged: [], failed: [{ prefix: "notes", code: "TIMEOUT" }] });
  });
});
describe("shared identity epoch fences independent devices", () => {
  test("syncing one device cannot let a fresh-but-behind peer serve old data", async () => {
    const memory = createMemoryPendingStore(identity);
    const pending = { ...memory, durable: true } as PendingWriteStore;
    const events: ReplicationEvent[][] = [];
    let networkCalls = 0;
    let localReads = 0;
    const createController = (deviceDid: string, busy: boolean) => {
      let replicaStatus = status(0);
      const handle = {
        spec: { identity, space: identity.space, prefix: "notes", allowSecrets: false },
        deviceDid,
        async grant() { return replicaStatus.grant; },
        async installGrant() { return replicaStatus.grant!; },
        async status() { return replicaStatus; },
        async get(key: string) {
          localReads++;
          return { status: "present" as const, key, value: new TextEncoder().encode('"old"'), etag: '"old"', metadata: {}, meta: { asOf: new Date(1_000_000).toISOString(), coverage: "complete" as const, authority: "valid" as const, syncedThroughEpoch: 0 } };
        },
        async list() { return { keys: [], meta: { asOf: null, coverage: "complete" as const, authority: "valid" as const, syncedThroughEpoch: 0 } }; },
        async sync({ syncStartEpoch }: { signal: AbortSignal; syncStartEpoch: number }) {
          if (busy) return { status: "busy" as const };
          replicaStatus = { ...replicaStatus, syncedThroughEpoch: syncStartEpoch };
          return { status: "synced" as const, pages: 1, changes: 1, deleted: 0, fetched: 1, contentMissing: 0, coverage: "complete" as const, syncedThroughEpoch: syncStartEpoch };
        },
        async close() {},
      } as unknown as KVReplicaHandle;
      const storage: KVReplicaStorage = { kind: "sqlite", async open() { return handle; }, async purge() {}, pendingWrites() { return pending; } };
      const recorded: ReplicationEvent[] = [];
      events.push(recorded);
      return createKVReplication({
        options, mode: "foreground", storage, identity,
        session: { id: `session-${deviceDid}`, did: identity.principal, space: identity.space },
        authority: { sessionGrant: () => ({ ucan: "token", device: { did: deviceDid, jwk: {} } }), plan: () => ({ refused: "NOT_COVERED" }), async mint() { throw new Error("unexpected mint"); } },
        pending, scheduler: { now: () => 1_000_000, setTimeout: () => () => undefined }, emit: (event) => recorded.push(event),
      });
    };
    const staleDevice = createController("did:key:device-a", true);
    const writingDevice = createController("did:key:device-b", false);
    const write = await writingDevice.write({ op: "put", space: identity.space, entries: [{ path: "notes/a", body: "new" }], signal: new AbortController().signal, network: async () => ok(undefined) });
    expect(write.ok).toBe(true);
    await writingDevice.sync();
    const read = await staleDevice.get(readRequest(async () => {
      networkCalls++;
      return ok({ data: "new", headers: { get: () => null } });
    }));
    expect(read.ok && read.data.data).toBe("new");
    expect(localReads).toBe(0);
    expect(networkCalls).toBe(1);
    expect(events[0]?.some((event) => event.type === "replication.sync" && event.outcome === "busy")).toBe(true);
  });
});



describe("KVReplication controller catch-up fence", () => {
  test("passes committedEpoch as syncStartEpoch and only serves at the resulting fence", async () => {
    const env = setup();
    await env.pending.update((state) => { state.committedEpoch = 4; });
    const value = await env.controller.get(readRequest(env.network));
    expect(value.ok && value.data.data).toBe("local");
    expect(env.counters()).toEqual({ localReads: 1, syncs: 1, opens: 1, networkCalls: 0 });
    expect(env.events.some((event) => event.type === "replication.sync" && event.outcome === "ok")).toBe(true);
  });

  test("a concurrent commit after sync start fences the replica from local service", async () => {
    let env: ReturnType<typeof setup>;
    env = setup({ onSync: async () => { await env.pending.update((state) => { state.committedEpoch++; }); } });
    env.setNow(1_200_001);
    const value = await env.controller.get(readRequest(env.network));
    expect(value.ok && value.data.data).toBe("network");
    expect(env.counters().localReads).toBe(0);
    expect(env.events.some((event) => event.type === "replication.read" && event.reason === "REPLICA_BEHIND_OWN_WRITES")).toBe(true);
  });

  test("a non-durable store requires this process's successful sync proof", async () => {
    const env = setup({ durable: false, initialEpoch: 10 });
    const value = await env.controller.get(readRequest(env.network));
    expect(value.ok && value.data.data).toBe("local");
    expect(env.counters().syncs).toBe(1);
    expect(env.counters().localReads).toBe(1);
  });

  test("network-only observation does not open, sync, or read the replica", async () => {
    const env = setup();
    const value = await env.controller.get({ ...readRequest(env.network), options: { source: "network" } });
    expect(value.ok).toBe(true);
    expect(env.counters()).toEqual({ localReads: 0, syncs: 0, opens: 0, networkCalls: 1 });
    const event = env.events.find((item) => item.type === "replication.read" && item.reason === "NETWORK_REQUESTED");
    expect(event?.type === "replication.read" ? [event.outcome, event.latencyMs] : undefined).toEqual(["found", 0]);
  });
});
describe("A2 lifecycle review regressions", () => {
  test("an unproven tcr1 continuation restarts after offline catch-up failure", async () => {
    const env = setup({ durable: false, syncOutcome: "network_error" });
    let networkCalls = 0;
    const result = await env.controller.list({
      space: identity.space,
      listPath: "notes",
      options: { cursor: encodeTcr1(identity.space, "notes", "notes/a") },
      signal: new AbortController().signal,
      network: async () => { networkCalls++; return ok({ keys: [], truncated: false }); },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && [result.error.code, result.error.meta?.replication]).toEqual(["INVALID_INPUT", "cursor_restart"]);
    expect(networkCalls).toBe(0);
  });

  test("purge includes the session device even before a prefix was opened", async () => {
    let target: { sessionDeviceDid?: string } | undefined;
    const env = setup({ purgeImpl: (value) => { target = value; } });
    expect(await env.controller.purge()).toEqual({ purged: ["notes"], failed: [] });
    await env.controller.get(readRequest(env.network));
    expect(env.counters().opens).toBe(0);
    expect(env.counters().networkCalls).toBe(1);

    expect(target?.sessionDeviceDid).toBe(identity.principal);
  });
  test("RUNTIME_UNSUPPORTED is disabled while storage failures retry after injected-clock backoff", async () => {
    const unsupported = setup({ openError: "RUNTIME_UNSUPPORTED" });
    await unsupported.controller.get(readRequest(unsupported.network));
    unsupported.setNow(1_000_000 + 600_000);
    await unsupported.controller.get(readRequest(unsupported.network));
    expect(unsupported.counters().opens).toBe(1);
    expect(unsupported.events.filter((event) => event.type === "replication.read").at(-1)).toMatchObject({ reason: "runtime_unsupported", code: "RUNTIME_UNSUPPORTED" });

    const unavailable = setup({ openError: "STORAGE_ERROR" });
    await unavailable.controller.get(readRequest(unavailable.network));
    await unavailable.controller.get(readRequest(unavailable.network));
    expect(unavailable.counters().opens).toBe(1);
    unavailable.setNow(1_005_000);
    await unavailable.controller.get(readRequest(unavailable.network));
    expect(unavailable.counters().opens).toBe(2);
    expect(unavailable.events.filter((event) => event.type === "replication.read").at(-1)).toMatchObject({ reason: "replica_unavailable", code: "STORAGE_ERROR" });
  });
  test("stale sync timeout drains the abort and serves offline get and list", async () => {
    for (const op of ["get", "list"] as const) {
      const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
      let syncStarted!: () => void;
      const started = new Promise<void>((resolve) => { syncStarted = resolve; });
      const env = setup({
        onSync: (_epoch, signal) => {
          syncStarted();
          return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        },
        setTimeoutImpl: (fn, ms) => {
          const timer = { fn, ms, cancelled: false };
          timers.push(timer);
          return () => { timer.cancelled = true; };
        },
      });
      env.setNow(1_200_001);
      const request = op === "get"
        ? env.controller.get(readRequest(env.network))
        : env.controller.list(listRequest(undefined, async () => ok({ keys: [], truncated: false })));
      await started;
      const timeout = timers.find((timer) => timer.ms === options.staleSyncTimeoutMs && !timer.cancelled);
      expect(timeout).toBeDefined();
      timeout!.fn();
      const result = await request;
      expect(result.ok).toBe(true);
      expect(op === "get" ? env.counters().localReads : env.listReads()).toBe(op === "get" ? 1 : 2);
      expect(env.counters().networkCalls).toBe(0);
      expect(env.events.some((event) => event.type === "replication.read" && event.source === "replica" && event.syncError === "TIMEOUT")).toBe(true);
    }
  });

  test("a sync that misses the abort drain bound goes to the network", async () => {
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => { syncStarted = resolve; });
    const env = setup({
      onSync: () => { syncStarted(); return new Promise<void>(() => {}); },
      setTimeoutImpl: (fn, ms) => {
        const timer = { fn, ms, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
    });
    env.setNow(1_200_001);
    const request = env.controller.get(readRequest(env.network));
    await started;
    timers.find((timer) => timer.ms === options.staleSyncTimeoutMs && !timer.cancelled)!.fn();
    for (let tick = 0; tick < 10 && !timers.some((timer) => timer.ms === 3_000 && !timer.cancelled); tick++) await Promise.resolve();
    timers.find((timer) => timer.ms === 3_000 && !timer.cancelled)!.fn();
    const result = await request;
    expect(result.ok && result.data.data).toBe("network");
    expect(env.counters().localReads).toBe(0);
    expect(env.counters().networkCalls).toBe(1);
    expect(env.events.some((event) => event.type === "replication.read" && event.source === "network" && event.code === "DRAIN_TIMEOUT")).toBe(true);
  });

  test("caller deadline during stale sync still returns TIMEOUT", async () => {
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => { syncStarted = resolve; });
    const env = setup({ onSync: (_epoch, signal) => {
      syncStarted();
      return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    env.setNow(1_200_001);
    const requestAbort = new AbortController();
    const request = env.controller.get({ ...readRequest(env.network), signal: requestAbort.signal });
    await started;
    requestAbort.abort(new RequestTimeoutError(20));
    const result = await request;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("TIMEOUT");
    expect(env.counters().localReads).toBe(0);
  });

  test("caller timeout remains TIMEOUT when the foreground sync exceeds the drain bound", async () => {
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => { syncStarted = resolve; });
    const env = setup({
      onSync: () => { syncStarted(); return new Promise<void>(() => {}); },
      setTimeoutImpl: (fn, ms) => {
        const timer = { fn, ms, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
    });
    env.setNow(1_200_001);
    const requestAbort = new AbortController();
    const request = env.controller.get({ ...readRequest(env.network), signal: requestAbort.signal });
    await started;
    requestAbort.abort(new RequestTimeoutError(20));
    for (let tick = 0; tick < 10 && !timers.some((timer) => timer.ms === 3_000 && !timer.cancelled); tick++) await Promise.resolve();
    timers.find((timer) => timer.ms === 3_000 && !timer.cancelled)!.fn();
    const result = await request;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("TIMEOUT");
    expect(env.counters().localReads).toBe(0);
  });

  test("a replica behind its own committed write never serves offline", async () => {
    const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => { syncStarted = resolve; });
    const env = setup({
      onSync: (_epoch, signal) => {
        syncStarted();
        return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
      setTimeoutImpl: (fn, ms) => {
        const timer = { fn, ms, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      },
    });
    await env.pending.update((state) => { state.committedEpoch = 1; });
    env.setNow(1_200_001);
    const request = env.controller.get(readRequest(env.network));
    await started;
    timers.find((timer) => timer.ms === options.staleSyncTimeoutMs && !timer.cancelled)!.fn();
    const result = await request;
    expect(result.ok && result.data.data).toBe("network");
    expect(env.counters().localReads).toBe(0);
    expect(env.counters().networkCalls).toBe(1);
    expect(env.events.some((event) => event.type === "replication.read" && event.reason === "REPLICA_BEHIND_OWN_WRITES")).toBe(true);
  });



  test("foreground stale-read cancellation drains sync and preserves TIMEOUT or ABORTED", async () => {
    for (const cancellation of [
      { code: "TIMEOUT", abort: (controller: AbortController) => controller.abort(new RequestTimeoutError(20)) },
      { code: "ABORTED", abort: (controller: AbortController) => controller.abort() },
    ]) {
      let finishSync!: () => void;
      let started!: () => void;
      const syncing = new Promise<void>((resolve) => { finishSync = resolve; });
      const syncStarted = new Promise<void>((resolve) => { started = resolve; });
      let settled = false;
      const env = setup({ onSync: (_epoch, signal) => {
        started();
        return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
          settled = true;
          finishSync();
          reject(signal.reason);
        }, { once: true }));
      } });
      env.setNow(1_200_001);
      const requestAbort = new AbortController();
      const resultPromise = env.controller.get({ ...readRequest(env.network), signal: requestAbort.signal });
      await syncStarted;
      cancellation.abort(requestAbort);
      const result = await resultPromise;
      await syncing;
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe(cancellation.code);
      expect(settled).toBe(true);
    }
  });

  test("concurrent sync callers share one job and close aborts that job", async () => {
    let syncSignal: AbortSignal | undefined;
    let started!: () => void;
    const syncStarted = new Promise<void>((resolve) => { started = resolve; });
    const env = setup({ onSync: (_epoch, signal) => {
      syncSignal = signal;
      started();
      return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const first = env.controller.sync().catch(() => undefined);
    const second = env.controller.sync().catch(() => undefined);
    await syncStarted;
    await env.controller.close();
    await Promise.all([first, second]);
    expect(env.counters().syncs).toBe(1);
    expect(syncSignal?.aborted).toBe(true);
  });

  test("pending.read rejection removes the caller abort listener", async () => {
    const env = setup();
    let listeners = 0;
    const signal = new AbortController().signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof signal.addEventListener>) => {
      if (args[0] === "abort") listeners++;
      return add(...args);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((...args: Parameters<typeof signal.removeEventListener>) => {
      if (args[0] === "abort") listeners--;
      return remove(...args);
    }) as typeof signal.removeEventListener;
    env.pending.read = async () => { throw new Error("pending store failed"); };
    await expect(env.controller.sync({ signal })).rejects.toThrow("pending store failed");
    expect(listeners).toBe(0);
  });

  test("list cancellation returns TIMEOUT rather than a DOMException code", async () => {
    let started!: () => void;
    const syncStarted = new Promise<void>((resolve) => { started = resolve; });
    const env = setup({ onSync: (_epoch, signal) => {
      started();
      return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    env.setNow(1_200_001);
    const requestAbort = new AbortController();
    const resultPromise = env.controller.list({
      ...listRequest(undefined, async () => ok({ keys: [], truncated: false })),
      signal: requestAbort.signal,
    });
    await syncStarted;
    requestAbort.abort(new RequestTimeoutError(20));
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("TIMEOUT");
  });

  test("list caller abort returns ABORTED rather than the DOMException numeric code", async () => {
    let started!: () => void;
    const syncStarted = new Promise<void>((resolve) => { started = resolve; });
    const env = setup({ onSync: (_epoch, signal) => {
      started();
      return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    env.setNow(1_200_001);
    const requestAbort = new AbortController();
    const resultPromise = env.controller.list({
      ...listRequest(undefined, async () => ok({ keys: [], truncated: false })),
      signal: requestAbort.signal,
    });
    await syncStarted;
    requestAbort.abort();
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("ABORTED");
  });

  test("close aborts an in-flight authority mint and drains its open", async () => {
    const { promise: mintStarted, resolve: markMintStarted } = Promise.withResolvers<void>();
    let mintSignal: AbortSignal | undefined;
    const env = setup({ runtimeMint: (signal) => {
      mintSignal = signal;
      markMintStarted();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const opening = env.controller.get(readRequest(env.network));
    await mintStarted;
    await env.controller.close();
    await opening;
    expect(mintSignal?.aborted).toBe(true);
  });

  test("purge aborts an in-flight authority mint", async () => {
    const { promise: mintStarted, resolve: markMintStarted } = Promise.withResolvers<void>();
    let mintSignal: AbortSignal | undefined;
    const env = setup({ runtimeMint: (signal) => {
      mintSignal = signal;
      markMintStarted();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const opening = env.controller.get(readRequest(env.network));
    await mintStarted;
    expect(await env.controller.purge()).toEqual({ purged: ["notes"], failed: [] });
    await opening;
    expect(mintSignal?.aborted).toBe(true);
  });
});
