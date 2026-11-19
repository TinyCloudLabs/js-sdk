import { describe, expect, test } from "bun:test";
import { ok, type Result } from "../../types";
import type { KVResponse } from "../types";
import { canonicalReplicationIdentity } from "./identity";
import { createKVReplication } from "./controller";
import { createMemoryPendingStore } from "./memoryPendingStore";
import type {
  KVReplicaHandle,
  KVReplicaSpec,
  KVReplicaStorage,
  LocalReplicaStatus,
  PendingWriteStore,
  ReplicationEvent,
  ResolvedReplicationOptions,
} from "./types";

const identity = canonicalReplicationIdentity({ host: "https://node.example", space: "tinycloud:pkh:eip155:1:0xabc:default", principal: "did:pkh:eip155:1:0xabc" });
const NOW = 1_000_000;
const status: LocalReplicaStatus = {
  coverage: "complete",
  lastSyncAt: new Date(NOW).toISOString(),
  syncedThroughEpoch: 0,
  authority: { state: "valid", expiresAt: null },
  grant: { cid: "grant", parentCid: null, expiresAt: null, state: "active", unconstrained: true },
  counts: { keys: 1, contentMissing: 1, tombstones: 0 },
  bytes: 0,
  lastError: null,
};
const baseOptions: ResolvedReplicationOptions = { enabled: true, prefixes: ["notes/"], allowSecrets: false, syncIntervalMs: 60_000, maxStalenessMs: 120_000, staleSyncTimeoutMs: 10_000, verify: false };

/** A replica whose only entry was synced lazily: the name is held, the value is not. */
function setup(contentFetch?: "eager" | "lazy") {
  const opened: KVReplicaSpec[] = [];
  let localReads = 0;
  let networkCalls = 0;
  const events: ReplicationEvent[] = [];
  const pending = { ...createMemoryPendingStore(identity), durable: true } as PendingWriteStore;
  const handle = {
    spec: { identity, space: identity.space, prefix: "notes/", allowSecrets: false },
    deviceDid: identity.principal,
    replicaId: "opaque-partition",
    async get(key: string) {
      localReads += 1;
      const meta = { asOf: new Date(NOW).toISOString(), coverage: "complete", authority: "valid", syncedThroughEpoch: 0 };
      return { status: "content_missing" as const, key, etag: '"blake3-lazy"', metadata: {}, meta };
    },
    async grant() { return status.grant; },
    async installGrant() { return status.grant!; },
    async sync({ syncStartEpoch }: { syncStartEpoch: number }) {
      return { status: "synced" as const, pages: 1, changes: 1, deleted: 0, fetched: 0, contentMissing: 1, coverage: "complete" as const, syncedThroughEpoch: syncStartEpoch };
    },
    async status() { return status; },
    async close() {},
  } as unknown as KVReplicaHandle;
  const storage: KVReplicaStorage = {
    kind: "sqlite",
    async open(spec) { opened.push(spec); return handle; },
    async purge() {},
    pendingWrites() { return pending; },
  };
  const authority = {
    sessionOnly: false,
    canRenew: false,
    consentAnchor: () => null,
    sessionGrant: () => ({ ucan: "token", device: { did: identity.principal, jwk: {} } }),
    plan: () => ({ refused: "NOT_COVERED" as const }),
    async mint() { return Promise.reject(new Error("unexpected mint")); },
  };
  const controller = createKVReplication({
    options: { ...baseOptions, ...(contentFetch === undefined ? {} : { contentFetch }) },
    mode: "foreground",
    storage,
    identity,
    session: { id: "session", did: identity.principal, space: identity.space },
    authority,
    pending,
    scheduler: { now: () => NOW, setTimeout: () => () => undefined },
    emit: (event) => events.push(event),
  });
  const network = async (): Promise<Result<KVResponse<unknown>>> => {
    networkCalls += 1;
    return ok({ data: "network", headers: { get: () => null } });
  };
  const read = () => controller.get({ space: identity.space, key: "notes/a", path: "notes/a", options: undefined, signal: new AbortController().signal, network });
  return { read, opened, events, counters: () => ({ localReads, networkCalls }) };
}

describe("contentFetch reaches the storage handle and reads of values not held go to the network", () => {
  test("lazy: the value of a name-only entry is served by the network, not as a miss or a local result", async () => {
    const env = setup("lazy");
    const result = await env.read();
    expect(result.ok && result.data.data).toBe("network");
    expect(env.counters()).toEqual({ localReads: 1, networkCalls: 1 });
    expect(env.opened.map((spec) => spec.contentFetch)).toEqual(["lazy"]);
    expect(env.events.filter((event) => event.type === "replication.read")).toEqual([
      expect.objectContaining({ op: "get", source: "network", reason: "content_missing", outcome: "found" }),
    ]);
  });

  test("eager (named or default): the handle is opened as before", async () => {
    const named = setup("eager");
    await named.read();
    expect(named.opened.map((spec) => spec.contentFetch)).toEqual(["eager"]);
    const unset = setup();
    await unset.read();
    expect(unset.opened).toHaveLength(1);
    expect("contentFetch" in unset.opened[0]!).toBe(false);
  });
});
