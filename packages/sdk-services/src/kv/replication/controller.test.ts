import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "../../types";
import { begin, settle } from "./pendingWrites";
import type { KVListOptions, KVResponse } from "../types";
import { canonicalReplicationIdentity } from "./identity";
import { createKVReplication } from "./controller";
import { encodeTcr1 } from "./listLocal";
import { createMemoryPendingStore } from "./memoryPendingStore";
import type { AuthorityRefusal, KVListPage, KVReplicaHandle, KVReplicaSpec, KVReplicaStorage, LocalReplicaStatus, ReplicaInspectedStatus, PendingWriteStore, ReplicationEvent, ResolvedReplicationOptions } from "./types";
import { RequestTimeoutError, wrapError } from "../../errors";
import { CONSENT_WINDOW_MS, DEFAULT_GRANT_TTL_MS } from "./contractConstants";

const identity = canonicalReplicationIdentity({ host: "https://node.example", space: "tinycloud:pkh:eip155:1:0xabc:default", principal: "did:pkh:eip155:1:0xabc" });
const status = (epoch = 0): LocalReplicaStatus => ({ coverage: "complete", lastSyncAt: new Date(1_000_000).toISOString(), syncedThroughEpoch: epoch, authority: { state: "valid", expiresAt: null }, grant: { cid: "grant", parentCid: null, expiresAt: null, state: "active", unconstrained: true }, counts: { keys: 1, contentMissing: 0, tombstones: 0 }, bytes: 1, lastError: null });
const options: ResolvedReplicationOptions = { enabled: true, prefixes: ["notes/"], allowSecrets: false, syncIntervalMs: 60_000, maxStalenessMs: 120_000, staleSyncTimeoutMs: 10_000, verify: false };
function lastEvent(events: readonly ReplicationEvent[], matches: (event: ReplicationEvent) => boolean): ReplicationEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    if (matches(events[index]!)) return events[index];
  }
  return undefined;
}


function setup({ durable = true, pendingStore, initialEpoch = 0, onSync, statusOverrides = {}, localGetStatus = "present", localListKeys = ["notes/a"], localGetErrorCode = "INTEGRITY_ERROR", beforeLocalGet, syncOutcome = "synced", mode = "foreground", purgeImpl, verify = false, openError, runtimeMint, sessionOnly = false, sessionRefused = false, sessionRefusal, canRenew = false, planPath = "runtime", setTimeoutImpl = () => () => undefined, beforePendingRead, afterPendingRead, statusImpl, inspectStatus, prefixes = options.prefixes, nodeFeatures, allowSecrets = false, delivery, onDeny, consentAnchor, durableDeadline, anchorError = false }: {
  durable?: boolean;
  pendingStore?: PendingWriteStore;
  initialEpoch?: number;
  onSync?: (epoch: number, signal: AbortSignal) => Promise<void> | void;
  statusOverrides?: Partial<LocalReplicaStatus>;
  localGetStatus?: "present" | "absent" | "deleted" | "content_missing" | "throw";
  localListKeys?: string[];
  localGetErrorCode?: string;
  beforeLocalGet?: () => void;
  syncOutcome?: "synced" | "busy" | "network_error" | "node_error";
  mode?: "background" | "foreground";
  purgeImpl?: (target: { sessionDeviceDid?: string }) => void | Promise<void>;
  verify?: boolean;
  openError?: string;
  runtimeMint?: (signal: AbortSignal, options?: { expiryMs: number }) => Promise<{ ucan: string; parentCid: string; expiresAt: number }>;
  sessionOnly?: boolean;
  sessionRefused?: boolean;
  sessionRefusal?: () => AuthorityRefusal["refused"] | null;
  canRenew?: boolean;
  planPath?: "session" | "runtime";
  setTimeoutImpl?: (fn: () => void, ms: number) => () => void;
  beforePendingRead?: () => void | Promise<void>;
  afterPendingRead?: () => void | Promise<void>;
  statusImpl?: (call: number) => Promise<LocalReplicaStatus> | LocalReplicaStatus;
  inspectStatus?: (signal: AbortSignal) => Promise<LocalReplicaStatus | ReplicaInspectedStatus | undefined>;
  prefixes?: string[];
  nodeFeatures?: readonly string[];
  allowSecrets?: boolean;
  delivery?: () => { status: "allow" } | { status: "consent_expired"; code: "CONSENT_EXPIRED" } | { status: "gated"; gate: "stamp_stale" };
  onDeny?: (input: { reason: string; principal: string }) => void | Promise<void>;
  consentAnchor?: { at: number; source: "siwe" | "first_install" };
  durableDeadline?: number | null;
  anchorError?: boolean;
} = {}) {
  let now = 1_000_000;
  let listReads = 0;
  let localStatus = {
    ...status(initialEpoch),
    ...(delivery ? { grant: { ...status().grant!, installedAt: 1_000_000, effectiveExpiresAt: 1_000_000 + DEFAULT_GRANT_TTL_MS, consentDeadline: 1_000_000 + CONSENT_WINDOW_MS } } : {}),
    ...statusOverrides,
  };
  let localReads = 0;
  let syncs = 0;
  let opens = 0;
  let installs = 0;
  let statusCalls = 0;
  let networkCalls = 0;
  const events: ReplicationEvent[] = [];
  let openedSpec: KVReplicaSpec | undefined;
  const memory = createMemoryPendingStore(identity);
  const pending = pendingStore ?? (durable ? ({ ...memory, durable: true } as PendingWriteStore) : memory);
  const pendingRead = pending.read.bind(pending);
  let pendingReads = 0;
  pending.read = async () => {
    pendingReads++;
    await beforePendingRead?.();
    const snapshot = await pendingRead();
    await afterPendingRead?.();
    return snapshot;
  };
  const handle = {
    spec: { identity, space: identity.space, prefix: "notes/", allowSecrets: false }, deviceDid: identity.principal, replicaId: "opaque-partition",
    async get(key: string) {
      localReads++;
      beforeLocalGet?.();
      if (localGetStatus === "throw") throw Object.assign(new Error("local read failed"), { code: localGetErrorCode });
      const meta = { asOf: new Date(now).toISOString(), coverage: localStatus.coverage, authority: localStatus.authority.state, syncedThroughEpoch: localStatus.syncedThroughEpoch };
      if (localGetStatus !== "present") return { status: localGetStatus, key, meta };
      return { status: "present" as const, key, value: new TextEncoder().encode('"local"'), etag: '"blake3-local"', metadata: { "content-type": "application/json" }, meta };
    },
    async list({ prefix, after, limit }: { prefix: string; after?: string; limit?: number }) {
      listReads++;
      const keys = localListKeys.filter((key) => key.startsWith(prefix) && (after === undefined || key > after));
      return { keys: limit === undefined ? keys : keys.slice(0, limit), meta: { asOf: new Date(now).toISOString(), coverage: localStatus.coverage, authority: localStatus.authority.state, syncedThroughEpoch: localStatus.syncedThroughEpoch } };
    },
    async grant() { return localStatus.grant; }, async installGrant() { installs++; return localStatus.grant!; },
    async sync({ signal, syncStartEpoch }: { signal: AbortSignal; syncStartEpoch: number }) {
      syncs++;
      await onSync?.(syncStartEpoch, signal);
      if (syncOutcome === "busy") return { status: "busy" as const };
      if (syncOutcome === "network_error" || syncOutcome === "node_error") throw Object.assign(new Error("sync failed"), { code: syncOutcome === "network_error" ? "NETWORK_ERROR" : "PROTOCOL_ERROR" });
      localStatus = { ...localStatus, syncedThroughEpoch: syncStartEpoch, lastSyncAt: new Date(now).toISOString() };
      return { status: "synced" as const, pages: 1, changes: 1, deleted: 0, fetched: 1, contentMissing: 0, coverage: "complete" as const, syncedThroughEpoch: syncStartEpoch };
    },
    async status() { statusCalls++; return statusImpl ? statusImpl(statusCalls) : localStatus; }, async close() {},
  } as unknown as KVReplicaHandle;
  const storage: KVReplicaStorage = {
    kind: delivery ? "indexeddb" : "sqlite",
    ...(delivery ? { lifecycle: {
      kind: "indexeddb" as const,
      consentDeadline: () => durableDeadline === undefined ? 1_000_000 + CONSENT_WINDOW_MS : durableDeadline,
      checkDelivery: delivery,
      async deny(input: { reason: string; principal: string }) { await onDeny?.(input); return { status: "denied" as const, lifecycleEpoch: 1, intents: 1 }; },
    } as unknown as NonNullable<KVReplicaStorage["lifecycle"]> } : {}),
    async open(spec) { opens++; openedSpec = spec; if (openError) throw Object.assign(new Error("open failed"), { code: openError }); return handle; },
    ...(inspectStatus ? { inspectStatus: async (_spec: KVReplicaSpec, { signal }: { signal: AbortSignal }) => inspectStatus(signal) } : {}),
    async purge(target) { await purgeImpl?.(target); },
    pendingWrites() { return pending; },
  };
  const authority = {
    sessionOnly,
    canRenew,
    consentAnchor: () => { if (anchorError) throw new Error("authority proof unavailable"); return consentAnchor ?? null; },
    sessionGrant: () => {
      const refusal = sessionRefusal?.();
      return refusal ? { refused: refusal } : sessionRefused || runtimeMint
        ? { refused: "NOT_COVERED" as const }
        : { ucan: "token", device: { did: identity.principal, jwk: {} } };
    },
    plan: () => {
      if (sessionOnly) throw new Error("session-only authority consulted the plan");
      return runtimeMint ? { path: planPath, parentCid: "parent", expiresAt: now + 60_000 } : { refused: "NOT_COVERED" as const };
    },
    async mint(_deviceDid: string, _prefix: string, signal: AbortSignal, options?: { expiryMs: number }) {
      return runtimeMint ? runtimeMint(signal, options) : Promise.reject(new Error("unexpected mint"));
    },
  };
  const scheduler = { now: () => now, setTimeout: setTimeoutImpl };
  const createController = () => createKVReplication({ options: { ...options, prefixes, verify, allowSecrets }, mode, storage, identity, session: { id: "session", did: identity.principal, space: identity.space }, authority, pending, scheduler, emit: (event) => events.push(event), nodeFeatures, ...(delivery ? { stamp: { incarnation: "test-incarnation", lifecycleEpoch: 0 } } : {}) });
  const controller = createController();
  return { controller, createController, storage, pending, events, peerCommit: (info: { at: number; syncedThroughEpoch: number; changes: number; coverage: "complete" }) => openedSpec?.onPeerCommit?.(info), counters: () => ({ localReads, syncs, opens, installs, networkCalls }), listReads: () => listReads, network: async (): Promise<Result<KVResponse<unknown>>> => { networkCalls++; return ok({ data: "network", headers: { get: () => null } }); }, setNow: (value: number) => { now = value; }, setStatus: (value: LocalReplicaStatus) => { localStatus = value; } };
}

const readRequest = (network: () => Promise<Result<KVResponse<unknown>>>) => ({ space: identity.space, key: "notes/a", path: "notes/a", options: undefined, signal: new AbortController().signal, network });
const listRequest = (options: KVListOptions | undefined, network: () => Promise<Result<KVListPage>>) => ({ space: identity.space, listPath: "notes/", options, signal: new AbortController().signal, network });

describe("rejected network read-through events", () => {
  test("a stale gate reports one failed network event per get/list without opening", async () => {
    const env = setup({ delivery: () => ({ status: "gated", gate: "stamp_stale" }) });
    const offline = Object.assign(new Error("offline by fixture"), { code: "NETWORK_ERROR" });
    let requests = 0;
    const network = async (): Promise<never> => { requests++; throw offline; };
    await expect(env.controller.get(readRequest(network))).rejects.toBe(offline);
    await expect(env.controller.list(listRequest(undefined, network))).rejects.toBe(offline);
    expect(requests).toBe(2);
    expect(env.counters()).toMatchObject({ opens: 0, localReads: 0, installs: 0 });
    expect(env.listReads()).toBe(0);
    expect(env.events.filter((event) => event.type === "replication.read")).toEqual([
      expect.objectContaining({ op: "get", source: "network", reason: "replica_gated", code: "REPLICA_GATED", outcome: "error" }),
      expect.objectContaining({ op: "list", source: "network", reason: "replica_gated", code: "REPLICA_GATED", outcome: "error" }),
    ]);
  });

  test("a gate refusal at open retains the failed-network event and never reads local bytes", async () => {
    const env = setup({ delivery: () => ({ status: "allow" }), openError: "REPLICA_GATED", consentAnchor: { at: 1_000_000, source: "siwe" } });
    const offline = Object.assign(new Error("offline by fixture"), { code: "NETWORK_ERROR" });
    let requests = 0;
    const network = async (): Promise<never> => { requests++; throw offline; };
    await expect(env.controller.get(readRequest(network))).rejects.toBe(offline);
    await expect(env.controller.list(listRequest(undefined, network))).rejects.toBe(offline);
    expect(requests).toBe(2);
    expect(env.counters()).toMatchObject({ opens: 2, localReads: 0, installs: 0 });
    expect(env.listReads()).toBe(0);
    expect(env.events.filter((event) => event.type === "replication.read")).toEqual([
      expect.objectContaining({ op: "get", source: "network", reason: "replica_gated", code: "REPLICA_GATED", outcome: "error" }),
      expect.objectContaining({ op: "list", source: "network", reason: "replica_gated", code: "REPLICA_GATED", outcome: "error" }),
    ]);
  });

  test("a compact current-session refusal reports its own code when network rejects", async () => {
    const env = setup({ sessionOnly: true, sessionRefusal: () => "NOT_COVERED", delivery: () => ({ status: "allow" }) });
    const offline = Object.assign(new Error("offline by fixture"), { code: "NETWORK_ERROR" });
    const network = async (): Promise<never> => { throw offline; };
    await expect(env.controller.get(readRequest(network))).rejects.toBe(offline);
    await expect(env.controller.list(listRequest(undefined, network))).rejects.toBe(offline);
    expect(env.counters()).toMatchObject({ opens: 0, localReads: 0, installs: 0 });
    expect(env.events.filter((event) => event.type === "replication.read")).toEqual([
      expect.objectContaining({ op: "get", source: "network", reason: "grant_missing", code: "NOT_COVERED", outcome: "error" }),
      expect.objectContaining({ op: "list", source: "network", reason: "grant_missing", code: "NOT_COVERED", outcome: "error" }),
    ]);
  });
  test("a compact refusal discovered after local get never retries a rejected network fallback", async () => {
    let refused: AuthorityRefusal["refused"] | null = null;
    const env = setup({
      sessionOnly: true,
      sessionRefusal: () => refused,
      delivery: () => ({ status: "allow" }),
      beforeLocalGet: () => { refused = "SESSION_EXPIRING"; },
    });
    const offline = Object.assign(new Error("offline by fixture"), { code: "NETWORK_ERROR" });
    let requests = 0;
    const network = async (): Promise<never> => { requests++; throw offline; };
    await expect(env.controller.get(readRequest(network))).rejects.toBe(offline);
    expect(requests).toBe(1);
    expect(env.counters()).toMatchObject({ localReads: 1 });
    expect(env.events.filter((event) => event.type === "replication.read")).toEqual([
      expect.objectContaining({ op: "get", source: "network", reason: "grant_missing", code: "SESSION_EXPIRING", outcome: "error" }),
    ]);
  });

  test("a compact refusal discovered after local list never retries a rejected network fallback", async () => {
    let refused: AuthorityRefusal["refused"] | null = null;
    const env = setup({
      sessionOnly: true,
      sessionRefusal: () => refused,
      delivery: () => ({ status: "allow" }),
      statusImpl: async () => { refused = "CAVEATED_AUTHORITY"; return status(); },
    });
    const offline = Object.assign(new Error("offline by fixture"), { code: "NETWORK_ERROR" });
    let requests = 0;
    const network = async (): Promise<never> => { requests++; throw offline; };
    await expect(env.controller.list(listRequest(undefined, network))).rejects.toBe(offline);
    expect(requests).toBe(1);
    expect(env.listReads()).toBe(1);
    expect(env.events.filter((event) => event.type === "replication.read")).toEqual([
      expect.objectContaining({ op: "list", source: "network", reason: "grant_missing", code: "CAVEATED_AUTHORITY", outcome: "error" }),
    ]);
  });

  for (const [code, reason] of [["REPLICA_GATED", "replica_gated"], ["GRANT_EXPIRED", "grant_expired"]] as const) {
    test(`an opened replica ${code} refusal reports failed get/list network reads`, async () => {
      const env = setup({
        delivery: () => ({ status: "allow" }),
        consentAnchor: { at: 1_000_000, source: "siwe" },
        statusImpl: async () => { throw Object.assign(new Error("local status gated"), { code }); },
      });
      const offline = Object.assign(new Error("offline by fixture"), { code: "NETWORK_ERROR" });
      let requests = 0;
      const network = async (): Promise<never> => { requests++; throw offline; };
      await expect(env.controller.get(readRequest(network))).rejects.toBe(offline);
      await expect(env.controller.list(listRequest(undefined, network))).rejects.toBe(offline);
      expect(requests).toBe(2);
      expect(env.counters()).toMatchObject({ opens: 1, localReads: 0 });
      expect(env.listReads()).toBe(0);
      expect(env.events.filter((event) => event.type === "replication.read")).toEqual([
        expect.objectContaining({ op: "get", source: "network", reason, code, outcome: "error" }),
        expect.objectContaining({ op: "list", source: "network", reason, code, outcome: "error" }),
      ]);
    });
  }
  test("a gate revoked during pending-state read keeps the gated reason on offline get/list", async () => {
    const env = setup({
      delivery: () => ({ status: "allow" }),
      consentAnchor: { at: 1_000_000, source: "siwe" },
      beforePendingRead: () => { throw Object.assign(new Error("pending gate stale"), { code: "REPLICA_GATED" }); },
    });
    const offline = Object.assign(new Error("offline by fixture"), { code: "NETWORK_ERROR" });
    let requests = 0;
    const network = async (): Promise<never> => { requests++; throw offline; };
    await expect(env.controller.get(readRequest(network))).rejects.toBe(offline);
    await expect(env.controller.list(listRequest(undefined, network))).rejects.toBe(offline);
    expect(requests).toBe(2);
    expect(env.counters()).toMatchObject({ localReads: 0 });
    expect(env.listReads()).toBe(0);
    expect(env.events.filter((event) => event.type === "replication.read")).toEqual([
      expect.objectContaining({ op: "get", source: "network", reason: "replica_gated", code: "REPLICA_GATED", outcome: "error" }),
      expect.objectContaining({ op: "list", source: "network", reason: "replica_gated", code: "REPLICA_GATED", outcome: "error" }),
    ]);
  });
  test("a pending write discovered after local list reports one network error without retry", async () => {
    const offline = Object.assign(new Error("offline by fixture"), { code: "NETWORK_ERROR" });
    let requests = 0;
    const env = setup({
      beforePendingRead: async () => {
        if (env.listReads() !== 1) return;
        await env.pending.update((state) => { begin(state, "late", [{ key: "notes/a", op: "put" }], new Date(1_000_000).toISOString()); });
      },
    });
    const network = async (): Promise<never> => { requests++; throw offline; };
    await expect(env.controller.list(listRequest(undefined, network))).rejects.toBe(offline);
    expect(requests).toBe(1);
    expect(env.events.filter((event) => event.type === "replication.read")).toEqual([
      expect.objectContaining({ op: "list", source: "network", reason: "pending_write", outcome: "error", pendingState: "in_flight" }),
    ]);
  });

  test("a pending get fallback reports a thrown network error once", async () => {
    const env = setup();
    await env.pending.update((state) => { begin(state, "pending", [{ key: "notes/a", op: "put" }], new Date(1_000_000).toISOString()); });
    const offline = Object.assign(new Error("offline by fixture"), { code: "NETWORK_ERROR" });
    let requests = 0;
    const network = async (): Promise<never> => { requests++; throw offline; };
    await expect(env.controller.get(readRequest(network))).rejects.toBe(offline);
    expect(requests).toBe(1);
    expect(env.events.filter((event) => event.type === "replication.read")).toEqual([
      expect.objectContaining({ op: "get", source: "network", reason: "pending_write", outcome: "error", pendingState: "in_flight" }),
    ]);
  });

  test("a gated read-through reports an error Result once for get and list", async () => {
    const env = setup({ delivery: () => ({ status: "gated", gate: "stamp_stale" }) });
    const failure = err(wrapError("kv", Object.assign(new Error("offline"), { code: "NETWORK_ERROR" })));
    let requests = 0;
    const network = async () => { requests++; return failure; };
    expect(await env.controller.get(readRequest(network))).toBe(failure);
    expect(await env.controller.list(listRequest(undefined, network))).toBe(failure);
    expect(requests).toBe(2);
    expect(env.events.filter((event) => event.type === "replication.read")).toEqual([
      expect.objectContaining({ op: "get", source: "network", reason: "replica_gated", code: "REPLICA_GATED", outcome: "error" }),
      expect.objectContaining({ op: "list", source: "network", reason: "replica_gated", code: "REPLICA_GATED", outcome: "error" }),
    ]);
  });

});

describe("consent deadline delivery", () => {
  test("an expired unopened session never opens a replica or fabricates a grant event", async () => {
    let decision: "allow" | "consent_expired" | "gated" = "consent_expired";
    const denials: Array<{ reason: string; principal: string }> = [];
    const env = setup({
      delivery: () => decision === "allow" ? { status: "allow" } : decision === "consent_expired" ? { status: "consent_expired", code: "CONSENT_EXPIRED" } : { status: "gated", gate: "stamp_stale" },
      onDeny: (input) => { denials.push(input); decision = "gated"; },
    });
    const first = await env.controller.get(readRequest(env.network));
    expect(first.ok && first.data.data).toBe("network");
    expect(env.counters()).toMatchObject({ opens: 0, localReads: 0, networkCalls: 1 });
    expect(env.events.filter((event) => event.type === "replication.grant")).toEqual([]);
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.read", source: "network", reason: "grant_expired", code: "CONSENT_EXPIRED" }));
    expect(denials).toEqual([{ reason: "consent_expired", principal: identity.principal }]);

    await env.controller.get(readRequest(env.network));
    expect(env.counters()).toMatchObject({ opens: 0, localReads: 0, networkCalls: 2 });
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.read", source: "network", reason: "replica_gated", code: "REPLICA_GATED" }));
    expect(denials).toHaveLength(1);
  });

  test("a gate timer that shreds first still reports only the opened stamped grant", async () => {
    let stale = false;
    let redundantDenials = 0;
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      delivery: () => stale ? { status: "gated", gate: "stamp_stale" } : { status: "allow" },
      onDeny: () => { redundantDenials++; },
    });
    expect((await env.controller.get(readRequest(env.network))).ok).toBe(true);
    stale = true;
    env.controller.observeConsentExpired({ incarnation: "other", lifecycleEpoch: 0 });
    expect(env.events.some((event) => event.type === "replication.grant" && event.action === "consent_deadline_reached")).toBe(false);
    env.controller.observeConsentExpired({ incarnation: "test-incarnation", lifecycleEpoch: 0 });
    env.controller.observeConsentExpired({ incarnation: "test-incarnation", lifecycleEpoch: 0 });
    expect((await env.controller.get(readRequest(env.network))).ok).toBe(true);
    expect(env.events.filter((event) => event.type === "replication.grant" && event.action === "consent_deadline_reached")).toEqual([
      expect.objectContaining({ replicaId: "opaque-partition", code: "CONSENT_EXPIRED" }),
    ]);
    expect(env.events.filter((event) => event.type === "replication.lifecycle" && event.reason === "consent_expired")).toEqual([
      expect.objectContaining({ action: "denied" }),
    ]);
    expect(env.counters()).toMatchObject({ opens: 1, localReads: 1, networkCalls: 1 });
    expect(redundantDenials).toBe(0);
  });
  test("a committed gate expiry before the first open has no synthetic grant event", async () => {
    const env = setup({ delivery: () => ({ status: "gated", gate: "stamp_stale" }) });
    env.controller.observeConsentExpired({ incarnation: "test-incarnation", lifecycleEpoch: 0 });
    expect((await env.controller.get(readRequest(env.network))).ok).toBe(true);
    expect(env.counters()).toMatchObject({ opens: 0, localReads: 0, networkCalls: 1 });
    expect(env.events.some((event) => event.type === "replication.grant")).toBe(false);
    expect(env.events.filter((event) => event.type === "replication.lifecycle" && event.reason === "consent_expired")).toEqual([
      expect.objectContaining({ action: "denied" }),
    ]);
  });

  test("an opened replica stops delivery and reports its opaque id exactly once", async () => {
    let decision: "allow" | "consent_expired" | "gated" = "allow";
    let denials = 0;
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      delivery: () => decision === "allow" ? { status: "allow" } : decision === "consent_expired" ? { status: "consent_expired", code: "CONSENT_EXPIRED" } : { status: "gated", gate: "stamp_stale" },
      onDeny: () => { denials++; decision = "gated"; },
    });
    const local = await env.controller.get(readRequest(env.network));
    expect(local.ok && local.data.data).toBe("local");
    decision = "consent_expired";
    const expired = await env.controller.get(readRequest(env.network));
    expect(expired.ok && expired.data.data).toBe("network");
    expect(env.counters()).toMatchObject({ opens: 1, localReads: 1, networkCalls: 1 });
    expect(env.events.filter((event) => event.type === "replication.grant" && event.action === "consent_deadline_reached")).toEqual([
      expect.objectContaining({ replicaId: "opaque-partition", code: "CONSENT_EXPIRED" }),
    ]);
    expect(denials).toBe(1);

    await env.controller.get(readRequest(env.network));
    expect(env.counters()).toMatchObject({ opens: 1, localReads: 1, networkCalls: 2 });
    expect(env.events.filter((event) => event.type === "replication.grant" && event.action === "consent_deadline_reached")).toHaveLength(1);
    expect(denials).toBe(1);
  });
  test("a worker deadline race never leaks a local result and shares the single denial", async () => {
    let decision: "allow" | "consent_expired" | "gated" = "allow";
    let denials = 0;
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      delivery: () => decision === "allow" ? { status: "allow" } : decision === "consent_expired" ? { status: "consent_expired", code: "CONSENT_EXPIRED" } : { status: "gated", gate: "stamp_stale" },
      onDeny: () => { denials++; decision = "gated"; },
      localGetStatus: "throw",
      localGetErrorCode: "CONSENT_EXPIRED",
      beforeLocalGet: () => { decision = "consent_expired"; },
    });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("network");
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.read", source: "network", reason: "grant_expired", code: "CONSENT_EXPIRED" }));
    expect(env.events.filter((event) => event.type === "replication.grant" && event.action === "consent_deadline_reached")).toEqual([
      expect.objectContaining({ replicaId: "opaque-partition", code: "CONSENT_EXPIRED" }),
    ]);
    expect(denials).toBe(1);
  });
  test("the active deadline timer denies opened consent without waiting for a read", async () => {
    const timers: Array<{ run: () => void; ms: number }> = [];
    let expired = false;
    let denials = 0;
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      durableDeadline: 1_000_000 + CONSENT_WINDOW_MS,
      delivery: () => expired ? { status: "consent_expired", code: "CONSENT_EXPIRED" } : { status: "allow" },
      onDeny: () => { denials++; },
      setTimeoutImpl: (run, ms) => { timers.push({ run, ms }); return () => undefined; },
    });
    expect((await env.controller.get(readRequest(env.network))).ok).toBe(true);
    const deadline = timers.find((timer) => timer.ms === CONSENT_WINDOW_MS);
    expect(deadline).toBeDefined();
    env.setNow(1_000_000 + CONSENT_WINDOW_MS);
    expired = true;
    deadline!.run();
    expect(env.events.filter((event) => event.type === "replication.grant" && event.action === "consent_deadline_reached")).toEqual([
      expect.objectContaining({ replicaId: "opaque-partition", code: "CONSENT_EXPIRED" }),
    ]);
    expect(denials).toBe(1);
    expect(env.counters()).toMatchObject({ localReads: 1, networkCalls: 0 });
  });
  test("a restored stamped grant schedules the gate's earlier durable deadline, not first_install", async () => {
    const timers: number[] = [];
    const env = setup({
      durableDeadline: 1_000_000 + CONSENT_WINDOW_MS,
      sessionOnly: true,
      statusOverrides: { grant: { ...status().grant!, installedAt: 1_000_000, effectiveExpiresAt: 1_000_000 + DEFAULT_GRANT_TTL_MS, consentDeadline: 1_000_000 + 2 * CONSENT_WINDOW_MS } },
      delivery: () => ({ status: "allow" }),
      setTimeoutImpl: (_run, ms) => { timers.push(ms); return () => undefined; },
    });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("local");
    expect(timers).toContain(CONSENT_WINDOW_MS);
    expect(timers).not.toContain(2 * CONSENT_WINDOW_MS);
  });
  test("a newer same-principal SIWE cannot move the stamped gate's earlier deadline", async () => {
    const timers: number[] = [];
    const earlier = CONSENT_WINDOW_MS - 24 * 60 * 60_000;
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      durableDeadline: 1_000_000 + earlier,
      delivery: () => ({ status: "allow" }),
      setTimeoutImpl: (_run, ms) => { timers.push(ms); return () => undefined; },
    });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("local");
    expect(timers).toContain(earlier);
    expect(timers).not.toContain(CONSENT_WINDOW_MS);
  });
  test("policy-only expiry before open falls through as GRANT_EXPIRED until the durable gate deadline", async () => {
    const policyDeadline = 1_001_000;
    const gateDeadline = 1_000_000 + CONSENT_WINDOW_MS;
    let gateExpired = false;
    let denials = 0;
    const env = setup({
      consentAnchor: { at: policyDeadline - CONSENT_WINDOW_MS, source: "siwe" },
      durableDeadline: gateDeadline,
      delivery: () => gateExpired ? { status: "consent_expired", code: "CONSENT_EXPIRED" } : { status: "allow" },
      onDeny: () => { denials++; },
      openError: "GRANT_EXPIRED",
      sessionOnly: true,
    });

    env.setNow(policyDeadline + 1);
    expect((await env.controller.get(readRequest(env.network))).ok).toBe(true);
    expect(lastEvent(env.events, (event) => event.type === "replication.read")).toMatchObject({
      type: "replication.read", source: "network", reason: "grant_expired", code: "GRANT_EXPIRED",
    });
    expect(await env.controller.list(listRequest(undefined, async () => ok({ keys: ["network/a"] }))))
      .toMatchObject({ ok: true, data: { keys: ["network/a"] } });
    expect(lastEvent(env.events, (event) => event.type === "replication.read")).toMatchObject({
      type: "replication.read", op: "list", source: "network", reason: "grant_expired", code: "GRANT_EXPIRED",
    });
    expect(denials).toBe(0);
    expect(env.events.filter((event) => event.type === "replication.grant" && event.action === "consent_deadline_reached")).toEqual([]);

    env.setNow(gateDeadline);
    gateExpired = true;
    expect((await env.controller.get(readRequest(env.network))).ok).toBe(true);
    expect(lastEvent(env.events, (event) => event.type === "replication.read")).toMatchObject({
      type: "replication.read", source: "network", reason: "grant_expired", code: "CONSENT_EXPIRED",
    });
    expect(denials).toBe(1);
  });
  test("an opened policy-expired grant reports expiry without denying the still-valid gate", async () => {
    const policyDeadline = 1_001_000;
    let denials = 0;
    const env = setup({
      consentAnchor: { at: policyDeadline - CONSENT_WINDOW_MS, source: "siwe" },
      durableDeadline: 1_000_000 + CONSENT_WINDOW_MS,
      delivery: () => ({ status: "allow" }),
      onDeny: () => { denials++; },
      sessionOnly: true,
      statusOverrides: {
        grant: { ...status().grant!, installedAt: 1_000_000, effectiveExpiresAt: policyDeadline, consentDeadline: policyDeadline },
      },
    });
    expect((await env.controller.get(readRequest(env.network))).ok).toBe(true);
    env.setStatus({ ...status(), authority: { state: "expired", expiresAt: policyDeadline } });
    env.setNow(policyDeadline + 1);
    expect((await env.controller.get(readRequest(env.network))).ok).toBe(true);
    expect(lastEvent(env.events, (event) => event.type === "replication.read")).toMatchObject({
      type: "replication.read", source: "network", reason: "grant_expired",
    });
    expect(env.events.filter((event) => event.type === "replication.grant" && event.action === "expired")).toEqual([
      expect.objectContaining({ replicaId: "opaque-partition", code: "GRANT_EXPIRED" }),
    ]);
    expect(denials).toBe(0);
    expect(env.events.filter((event) => event.type === "replication.grant" && event.action === "consent_deadline_reached")).toEqual([]);
  });
  test("the durable deadline timer denies an unopened session without a grant event", async () => {
    const timers: Array<{ run: () => void; ms: number }> = [];
    let expired = false;
    let denials = 0;
    const env = setup({
      durableDeadline: 1_000_000 + CONSENT_WINDOW_MS,
      delivery: () => expired ? { status: "consent_expired", code: "CONSENT_EXPIRED" } : { status: "allow" },
      onDeny: () => { denials++; },
      setTimeoutImpl: (run, ms) => { timers.push({ run, ms }); return () => undefined; },
    });
    const deadline = timers.find((timer) => timer.ms === CONSENT_WINDOW_MS);
    expect(deadline).toBeDefined();
    env.setNow(1_000_000 + CONSENT_WINDOW_MS);
    expired = true;
    deadline!.run();
    expect(env.counters().opens).toBe(0);
    expect(env.events.filter((event) => event.type === "replication.grant")).toEqual([]);
    expect(denials).toBe(1);
  });
  test("an expired unopened list never reveals keys, and status reports the gated transition", async () => {
    let denials = 0;
    const env = setup({
      delivery: () => ({ status: "consent_expired", code: "CONSENT_EXPIRED" }),
      onDeny: () => { denials++; },
    });
    const listed = await env.controller.list(listRequest(undefined, async () => ok({ keys: ["network"] })));
    expect(listed).toMatchObject({ ok: true, data: { keys: ["network"] } });
    expect(env.listReads()).toBe(0);
    expect(env.counters().opens).toBe(0);
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.read", op: "list", source: "network", reason: "grant_expired", code: "CONSENT_EXPIRED" }));
    expect(env.events.filter((event) => event.type === "replication.grant")).toEqual([]);
    expect(await env.controller.status()).toMatchObject([
      { prefix: "notes/", state: "gated", reason: "replica_gated", gate: "stamp_stale", errorCode: "REPLICA_GATED" },
    ]);
    expect(denials).toBe(1);
  });
  test("a sync that crosses the deadline cannot report a delivered success", async () => {
    let expired = false;
    let denials = 0;
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      delivery: () => expired ? { status: "consent_expired", code: "CONSENT_EXPIRED" } : { status: "allow" },
      onDeny: () => { denials++; },
      onSync: () => { expired = true; },
    });
    await expect(env.controller.sync()).rejects.toMatchObject({ code: "CONSENT_EXPIRED" });
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.sync", outcome: "error", class: "lifecycle", code: "CONSENT_EXPIRED" }));
    expect(env.events.some((event) => event.type === "replication.sync" && event.outcome === "ok")).toBe(false);
    expect(denials).toBe(1);
  });
  test("an unavailable lifecycle preflight fails closed to network without throwing", async () => {
    const env = setup({
      delivery: () => { throw new Error("gate unavailable"); },
    });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("network");
    expect(env.counters()).toMatchObject({ opens: 0, localReads: 0, networkCalls: 1 });
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.read", source: "network", reason: "replica_gated", code: "REPLICA_GATED" }));
  });
  test("an authority proof failure cannot fail the network session or open a replica", async () => {
    const env = setup({
      anchorError: true,
      delivery: () => ({ status: "allow" }),
    });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("network");
    expect(env.counters()).toMatchObject({ opens: 0, localReads: 0, networkCalls: 1 });
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.read", source: "network", reason: "replica_gated", code: "REPLICA_GATED" }));
  });
  test("a verified get cannot return bytes or a divergence after consent expires during network comparison", async () => {
    let expired = false;
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      verify: true,
      delivery: () => expired ? { status: "consent_expired", code: "CONSENT_EXPIRED" } : { status: "allow" },
    });
    const result = await env.controller.get(readRequest(async () => {
      expired = true;
      return ok({ data: "network", headers: { get: () => null } });
    }));
    expect(result.ok && result.data.data).toBe("network");
    expect(env.events.some((event) => event.type === "replication.divergence")).toBe(false);
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.read", source: "network", reason: "grant_expired", code: "CONSENT_EXPIRED" }));
  });
  test("a verified list cannot return keys or a divergence after consent expires during network comparison", async () => {
    let expired = false;
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      verify: true,
      delivery: () => expired ? { status: "consent_expired", code: "CONSENT_EXPIRED" } : { status: "allow" },
    });
    const result = await env.controller.list(listRequest(undefined, async () => {
      expired = true;
      return ok({ keys: ["network"] });
    }));
    expect(result).toMatchObject({ ok: true, data: { keys: ["network"] } });
    expect(env.events.some((event) => event.type === "replication.divergence")).toBe(false);
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.read", source: "network", reason: "grant_expired", code: "CONSENT_EXPIRED" }));
  });
  test("verified get drops local bytes when compact session authority disappears during network comparison", async () => {
    let refused: AuthorityRefusal["refused"] | null = null;
    const env = setup({ sessionOnly: true, verify: true, sessionRefusal: () => refused, delivery: () => ({ status: "allow" }) });
    const result = await env.controller.get(readRequest(async () => {
      refused = "NOT_COVERED";
      return ok({ data: "network", headers: { get: () => null } });
    }));
    expect(result.ok && result.data.data).toBe("network");
    expect(env.events.some((event) => event.type === "replication.divergence")).toBe(false);
  });
  test("verified list drops local keys when compact session authority disappears during network comparison", async () => {
    let refused: AuthorityRefusal["refused"] | null = null;
    const env = setup({ sessionOnly: true, verify: true, sessionRefusal: () => refused, delivery: () => ({ status: "allow" }) });
    const result = await env.controller.list(listRequest(undefined, async () => {
      refused = "CAVEATED_AUTHORITY";
      return ok({ keys: ["network/a"] });
    }));
    expect(result).toMatchObject({ ok: true, data: { keys: ["network/a"] } });
    expect(env.events.some((event) => event.type === "replication.divergence")).toBe(false);
  });
  test("browser refuses local serving when its durable deadline is unavailable despite a signed anchor", async () => {
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      durableDeadline: null,
      delivery: () => ({ status: "allow" }),
    });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("network");
    expect(env.counters()).toMatchObject({ opens: 0, localReads: 0, networkCalls: 1 });
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.read", source: "network", reason: "replica_gated", code: "REPLICA_GATED" }));
  });
  test("browser mint duration is capped by the older durable deadline", async () => {
    const durations: number[] = [];
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      durableDeadline: 1_010_000,
      delivery: () => ({ status: "allow" }),
      runtimeMint: async (_signal, options) => {
        durations.push(options?.expiryMs ?? Number.NaN);
        return { ucan: "minted-token", parentCid: "parent", expiresAt: 1_010_000 };
      },
    });
    await env.controller.get(readRequest(env.network));
    expect(durations).toEqual([10_000]);
  });
  test("a first-install expiry bound cannot authorize a fresh browser mint", async () => {
    let mints = 0;
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "first_install" },
      delivery: () => ({ status: "allow" }),
      statusOverrides: { grant: null },
      runtimeMint: async () => {
        mints++;
        return { ucan: "minted-token", parentCid: "parent", expiresAt: 2_000_000 };
      },
    });
    const result = await env.controller.get(readRequest(env.network));
    expect(mints).toBe(0);
    expect(result.ok && result.data.data).toBe("network");
    expect(env.counters()).toMatchObject({ installs: 0, localReads: 0, networkCalls: 1 });
  });

  test("an unanchored node session cannot mint a fresh replica grant", async () => {
    let mints = 0;
    const env = setup({
      statusOverrides: { grant: null },
      runtimeMint: async () => {
        mints++;
        return { ucan: "minted-token", parentCid: "parent", expiresAt: 2_000_000 };
      },
    });
    const result = await env.controller.get(readRequest(env.network));
    expect(mints).toBe(0);
    expect(result.ok && result.data.data).toBe("network");
  });
  test("node mint uses the verified owner deadline when no durable gate deadline exists", async () => {
    const durations: number[] = [];
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      runtimeMint: async (_signal, options) => {
        durations.push(options?.expiryMs ?? Number.NaN);
        return { ucan: "minted-token", parentCid: "parent", expiresAt: 2_000_000 };
      },
    });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("local");
    expect(durations).toEqual([DEFAULT_GRANT_TTL_MS]);
  });
  test("a matching compact restore serves only an active installed grant covered by its current session", async () => {
    const env = setup({
      sessionOnly: true,
      durableDeadline: 1_000_000 + CONSENT_WINDOW_MS,
      delivery: () => ({ status: "allow" }),
    });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("local");
    expect(env.counters()).toMatchObject({ installs: 0, networkCalls: 0 });
  });
  test("a valid installed compact grant never overrides a current-session refusal", async () => {
    for (const refused of ["NOT_COVERED", "CAVEATED_AUTHORITY", "SESSION_EXPIRING"] as const) {
      const env = setup({
        sessionOnly: true,
        sessionRefusal: () => refused,
        delivery: () => ({ status: "allow" }),
      });
      const get = await env.controller.get(readRequest(env.network));
      const list = await env.controller.list(listRequest(undefined, async () => ok({ keys: ["network/a"] })));
      expect(get.ok && get.data.data).toBe("network");
      expect(list).toMatchObject({ ok: true, data: { keys: ["network/a"] } });
      expect(env.counters()).toMatchObject({ localReads: 0, installs: 0, networkCalls: 1 });
      expect(env.listReads()).toBe(0);
    }
  });
  test("a compact current-session refusal after open blocks further local get and list", async () => {
    let refused: AuthorityRefusal["refused"] | null = null;
    const env = setup({
      sessionOnly: true,
      sessionRefusal: () => refused,
      delivery: () => ({ status: "allow" }),
    });
    const local = await env.controller.get(readRequest(env.network));
    expect(local.ok && local.data.data).toBe("local");
    refused = "SESSION_EXPIRING";
    const network = await env.controller.get(readRequest(env.network));
    expect(network.ok && network.data.data).toBe("network");
    expect(await env.controller.list(listRequest(undefined, async () => ok({ keys: ["network/a"] }))))
      .toMatchObject({ ok: true, data: { keys: ["network/a"] } });
    expect(env.counters()).toMatchObject({ localReads: 1, networkCalls: 1 });
    expect(env.listReads()).toBe(0);
  });
  test("a compact authority refusal restarts an existing local list cursor without exposing keys", async () => {
    let refused: AuthorityRefusal["refused"] | null = null;
    const env = setup({
      sessionOnly: true,
      sessionRefusal: () => refused,
      delivery: () => ({ status: "allow" }),
    });
    const first = await env.controller.list(listRequest(undefined, async () => ok({ keys: ["network/a"] })));
    expect(first).toMatchObject({ ok: true, data: { keys: ["notes/a"] } });
    refused = "CAVEATED_AUTHORITY";
    let networkCalls = 0;
    const cursor = encodeTcr1(identity.space, "notes/", "notes/a");
    const next = await env.controller.list(listRequest({ cursor }, async () => {
      networkCalls++;
      return ok({ keys: ["network/a"] });
    }));
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.error.meta).toMatchObject({ replication: "cursor_restart" });
    expect(env.listReads()).toBe(1);
    expect(networkCalls).toBe(0);
  });
  test("a compact refusal after open cannot sync through the stored grant", async () => {
    let refused: AuthorityRefusal["refused"] | null = null;
    const env = setup({
      sessionOnly: true,
      sessionRefusal: () => refused,
      delivery: () => ({ status: "allow" }),
    });
    const local = await env.controller.get(readRequest(env.network));
    expect(local.ok && local.data.data).toBe("local");
    refused = "NOT_COVERED";
    await env.controller.sync().catch(() => undefined);
    expect(env.counters().syncs).toBe(0);
  });
  test("a stale installed compact grant cannot serve even with current-session coverage", async () => {
    for (const grant of [
      { ...status().grant!, installedAt: 1_000_000, consentDeadline: 1_000_000 + CONSENT_WINDOW_MS },
      { ...status().grant!, installedAt: 1_000_000, effectiveExpiresAt: 1_000_000, consentDeadline: 1_000_000 + CONSENT_WINDOW_MS },
    ]) {
      const env = setup({
        sessionOnly: true,
        statusOverrides: { grant },
        delivery: () => ({ status: "allow" }),
      });
      const result = await env.controller.get(readRequest(env.network));
      expect(result.ok && result.data.data).toBe("network");
      expect(env.counters()).toMatchObject({ localReads: 0, installs: 0, networkCalls: 1 });
    }
  });
  test("a full expirationless session cannot reuse an installed grant without a verified owner anchor", async () => {
    const env = setup({ delivery: () => ({ status: "allow" }) });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("network");
    expect(env.counters()).toMatchObject({ localReads: 0, installs: 0, networkCalls: 1 });
  });
  test("silent renewal requires a verified owner session plan for this prefix", async () => {
    for (const planPath of ["session", "runtime"] as const) {
      let mints = 0;
      const env = setup({
        consentAnchor: { at: 1_000_000, source: "siwe" },
        canRenew: true,
        planPath,
        statusOverrides: { grant: { ...status().grant!, parentCid: "parent", installedAt: 1_000_000, effectiveExpiresAt: 1_010_000 } },
        runtimeMint: async () => {
          mints++;
          return { ucan: "renewed-token", parentCid: "parent", expiresAt: 1_020_000 };
        },
      });
      await env.controller.get(readRequest(env.network));
      env.setNow(1_008_000);
      await env.controller.sync();
      expect(mints).toBe(planPath === "session" ? 1 : 0);
      expect(env.events.some((event) => event.type === "replication.grant" && event.action === "renewed")).toBe(planPath === "session");
    }
  });
  test("offline renewal keeps the current grant serving until its effective expiry", async () => {
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      canRenew: true,
      planPath: "session",
      statusOverrides: { grant: { ...status().grant!, parentCid: "parent", installedAt: 1_000_000, effectiveExpiresAt: 1_010_000 } },
      runtimeMint: async () => { throw Object.assign(new Error("offline"), { code: "NETWORK_ERROR" }); },
    });
    await env.controller.get(readRequest(env.network));
    env.setNow(1_008_000);
    await env.controller.sync();
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("local");
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.grant", replicaId: "opaque-partition", action: "renewal_deferred" }));
  });
  test("an overlong installed grant reports its local cap using only the opaque replica id", async () => {
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      delivery: () => ({ status: "allow" }),
      statusOverrides: { grant: { ...status().grant!, expiresAt: 2_000_000, installedAt: 1_000_000, effectiveExpiresAt: 1_010_000, consentDeadline: 1_000_000 + CONSENT_WINDOW_MS } },
    });
    await env.controller.get(readRequest(env.network));
    expect(env.events).toContainEqual(expect.objectContaining({
      type: "replication.grant",
      replicaId: "opaque-partition",
      action: "capped",
      effectiveExpiresAt: new Date(1_010_000).toISOString(),
    }));
  });
  test("a locally expired grant falls through to network and reports the opaque grant transition", async () => {
    const env = setup({
      consentAnchor: { at: 1_000_000, source: "siwe" },
      delivery: () => ({ status: "allow" }),
      localGetStatus: "throw",
      localGetErrorCode: "GRANT_EXPIRED",
    });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("network");
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.read", source: "network", reason: "grant_expired", code: "GRANT_EXPIRED" }));
    expect(env.events).toContainEqual(expect.objectContaining({ type: "replication.grant", replicaId: "opaque-partition", action: "expired", code: "GRANT_EXPIRED" }));
    expect(await env.controller.status()).toMatchObject([{ prefix: "notes/", state: "unavailable", reason: "grant_expired", errorCode: "GRANT_EXPIRED" }]);
  });
});

test("peer commits emit an onEvent sync without running a local sync, then stop after close", async () => {
  const env = setup();
  await env.controller.get(readRequest(env.network));
  env.peerCommit({ at: 999_990, syncedThroughEpoch: 8, changes: 2, coverage: "complete" });
  expect(env.events.filter((event) => event.type === "replication.sync")).toEqual([{
    type: "replication.sync", at: new Date(1_000_000).toISOString(),
    space: identity.space, replica: "notes/", trigger: "peer", origin: "peer",
    outcome: "ok", durationMs: 0, lagMs: null, changes: 2, coverage: "complete",
  }]);
  expect(env.counters().syncs).toBe(0);
  await env.controller.close();
  env.peerCommit({ at: 1_000_010, syncedThroughEpoch: 9, changes: 1, coverage: "complete" });
  expect(env.events.filter((event) => event.type === "replication.sync")).toHaveLength(1);
});

describe("whole-space replication", () => {
  test("reports unsupported nodes and serves covered reads when advertised", async () => {
    const unsupported = setup({ prefixes: ["/"], allowSecrets: true, nodeFeatures: [] });
    const noSecretsOptIn = setup({ prefixes: ["/"] });
    await noSecretsOptIn.controller.get(readRequest(noSecretsOptIn.network));
    expect(await noSecretsOptIn.controller.status()).toMatchObject([
      { prefix: "/", state: "unavailable", errorCode: "SECRETS_OPT_IN_REQUIRED" },
    ]);
    const fallback = await unsupported.controller.get(readRequest(unsupported.network));
    expect(fallback.ok).toBe(true);
    expect(unsupported.counters().opens).toBe(0);
    expect(await unsupported.controller.status()).toMatchObject([
      { prefix: "/", state: "unavailable", errorCode: "REPLICATION_ROOT_UNSUPPORTED" },
    ]);

    const offlineCache = setup({ prefixes: ["/"], allowSecrets: true });
    const offlineLocal = await offlineCache.controller.get(readRequest(offlineCache.network));
    expect(offlineLocal.ok && offlineLocal.data.data).toBe("local");
    expect(offlineCache.counters()).toMatchObject({ opens: 1, syncs: 0, networkCalls: 0 });
    const supported = setup({ prefixes: ["/"], allowSecrets: true, nodeFeatures: ["kv-sync-root"] });
    const local = await supported.controller.get(readRequest(supported.network));
    expect(local.ok && local.data.data).toBe("local");
    const nested = await supported.controller.list({ ...listRequest(undefined, async () => ok({ keys: [] })), listPath: "notes" });
    expect(nested).toMatchObject({ ok: true, data: { keys: ["notes/a"] } });
    const rootList = await supported.controller.list({ ...listRequest(undefined, async () => ok({ keys: [] })), listPath: "" });
    expect(rootList).toMatchObject({ ok: true, data: { keys: ["notes/a"] } });
    await supported.pending.update((state) =>
      begin(state, "root-pending", [{ key: "elsewhere/x", op: "put" }], new Date(1_000_000).toISOString()),
    );
    const protectedRootList = await supported.controller.list({
      ...listRequest(undefined, async () => ok({ keys: ["network"] })),
      listPath: "",
    });
    expect(protectedRootList).toMatchObject({ ok: true, data: { keys: ["network"] } });
  });
  test("persisted complete cache keeps coverage but root refusal remains unavailable", async () => {
    const cached = status();
    const env = setup({
      prefixes: ["/"],
      allowSecrets: true,
      nodeFeatures: [],
      inspectStatus: async () => cached,
    });

    expect(await env.controller.status()).toMatchObject([
      {
        prefix: "/",
        state: "unavailable",
        reason: "replica_unavailable",
        errorCode: "REPLICATION_ROOT_UNSUPPORTED",
        coverage: "complete",
        authority: { state: "valid" },
      },
    ]);
  });
});
describe("KVReplication fallback and pending behavior", () => {
  test("session-only refusal ignores an installed grant and serves the network", async () => {
    const env = setup({ sessionOnly: true, sessionRefused: true, delivery: () => ({ status: "allow" }) });
    const result = await env.controller.get(readRequest(env.network));
    expect(result.ok && result.data.data).toBe("network");
    expect(env.counters().localReads).toBe(0);
    expect(env.counters().networkCalls).toBe(1);
    expect(env.counters().opens).toBe(0);
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
      listPath: "notes/",
      options: { cursor: encodeTcr1(identity.space, "notes/", "notes/a") },
      signal: new AbortController().signal,
      network: async () => { throw new Error("cursor restart must not use network"); },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.meta?.replication).toBe("cursor_restart");
    expect(env.counters().localReads).toBe(0);
  });
  test("a gated pending store does not block covered network writes or recreate local records", async () => {
    const pending = createMemoryPendingStore(identity);
    let touched = false;
    pending.update = async () => { touched = true; throw Object.assign(new Error("gated"), { code: "REPLICA_GATED", gate: "stamp_stale" }); };
    const env = setup({ pendingStore: pending, delivery: () => ({ status: "gated", gate: "stamp_stale" }) });
    let dispatched = 0;
    const result = await env.controller.write({
      op: "put",
      space: identity.space,
      entries: [{ path: "notes/a", body: "network-value" }],
      signal: new AbortController().signal,
      network: async () => { dispatched++; return ok({ stored: true }); },
    });
    expect(result).toMatchObject({ ok: true, data: { stored: true } });
    expect(dispatched).toBe(1);
    expect(touched).toBe(false);
    expect((await pending.read()).records).toEqual([]);
  });
});
  test("bare nested LIST range falls back for in-flight and ambiguous writes", async () => {
    for (const pendingState of ["in_flight", "ambiguous"] as const) {
      const env = setup();
      await env.pending.update((state) => {
        begin(state, "nested", [{ key: "notes/folder/a", op: "delete" }], new Date(1_000_000).toISOString());
        if (pendingState === "ambiguous") settle(state, "nested", "ambiguous", new Date(1_000_000).toISOString(), "TIMEOUT");
      });
      let networkCalls = 0;
      const result = await env.controller.list({
        space: identity.space,
        listPath: "notes/folder",
        options: undefined,
        signal: new AbortController().signal,
        network: async () => { networkCalls++; return ok({ keys: ["notes/folder/a"], truncated: false }); },
      });
      expect(result.ok && result.data.keys).toEqual(["notes/folder/a"]);
      expect(networkCalls).toBe(1);
      expect(env.listReads()).toBe(0);
    }
  });

  test("bare nested LIST continuation restarts for in-flight and ambiguous writes", async () => {
    for (const pendingState of ["in_flight", "ambiguous"] as const) {
      const env = setup();
      await env.pending.update((state) => {
        begin(state, "nested", [{ key: "notes/folder/b", op: "delete" }], new Date(1_000_000).toISOString());
        if (pendingState === "ambiguous") settle(state, "nested", "ambiguous", new Date(1_000_000).toISOString(), "TIMEOUT");
      });
      const result = await env.controller.list({
        space: identity.space,
        listPath: "notes/folder",
        options: { cursor: encodeTcr1(identity.space, "notes/folder", "notes/folder/a") },
        signal: new AbortController().signal,
        network: async () => { throw new Error("cursor restart must not use network"); },
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.meta?.replication).toBe("cursor_restart");
      expect(env.listReads()).toBe(0);
    }
  });
describe("KVReplication list parity and cursor rules", () => {
  test("a LIST range wider than the selected slash prefix falls back to network", async () => {
    const env = setup({ prefixes: ["notes/"] });
    let networkCalls = 0;
    const result = await env.controller.list({
      space: identity.space,
      listPath: "notes",
      options: undefined,
      signal: new AbortController().signal,
      network: async () => { networkCalls++; return ok({ keys: ["notes", "notes/a"], truncated: false }); },
    });
    expect(result.ok && result.data.keys).toEqual(["notes", "notes/a"]);
    expect(networkCalls).toBe(1);
    const cursor = await env.controller.list({
      space: identity.space,
      listPath: "notes",
      options: { cursor: encodeTcr1(identity.space, "notes", "notes/a") },
      signal: new AbortController().signal,
      network: async () => { throw new Error("incomplete local cursor must restart"); },
    });
    expect(cursor.ok).toBe(false);
    expect(!cursor.ok && cursor.error.meta?.replication).toBe("cursor_restart");
  });
  const networkPage = async (): Promise<Result<KVListPage>> => ok({ keys: ["network/a"], truncated: false });

  test("serves covered local pages without consulting the network", async () => {
    const env = setup();
    const result = await env.controller.list(listRequest(undefined, networkPage));
    expect(result.ok && result.data.keys).toEqual(["notes/a"]);
    expect(env.listReads()).toBe(1);
    expect(env.counters().networkCalls).toBe(0);
  });

  test("pending creates and deletes in the LIST range use the network on the first page", async () => {
    for (const op of ["put", "delete"] as const) {
      for (const pendingState of ["in_flight", "ambiguous", "committed"] as const) {
        const env = setup({ initialEpoch: pendingState === "committed" ? 1 : 0 });
        await env.pending.update((state) => {
          begin(state, "write", [{ key: op === "put" ? "notes/b" : "notes/a", op }], new Date(1_000_000).toISOString());
          if (pendingState !== "in_flight") settle(state, "write", pendingState, new Date(1_000_000).toISOString());
        });
        let networkCalls = 0;
        const result = await env.controller.list(listRequest(undefined, async () => {
          networkCalls++;
          return ok({ keys: op === "put" ? ["notes/a", "notes/b"] : [], truncated: false });
        }));
        expect(result.ok && result.data.keys).toEqual(op === "put" ? ["notes/a", "notes/b"] : []);
        expect(networkCalls).toBe(1);
        expect(env.listReads()).toBe(0);
        expect(env.events.findLast((event) => event.type === "replication.read")).toMatchObject({
          source: "network", reason: "pending_write", pendingState,
        });
      }
    }
  });

  test("a paginated local LIST restarts if a pending mutation affects any key in the range", async () => {
    for (const op of ["put", "delete"] as const) {
      for (const pendingState of ["in_flight", "ambiguous", "committed"] as const) {
        for (const key of ["notes/a", "notes/b"]) {
          const env = setup({ localListKeys: ["notes/a", "notes/b"] });
          let networkCalls = 0;
          const network = async () => { networkCalls++; return ok({ keys: ["notes/server"], truncated: false }); };
          const first = await env.controller.list(listRequest({ limit: 1 }, network));
          expect(first.ok && first.data).toMatchObject({ keys: ["notes/a"], truncated: true });
          const cursor = first.ok ? first.data.nextCursor : undefined;
          expect(cursor?.startsWith("tcr1.")).toBe(true);
          await env.pending.update((state) => {
            begin(state, "write", [{ key, op }], new Date(1_000_000).toISOString());
            if (pendingState !== "in_flight") settle(state, "write", pendingState, new Date(1_000_000).toISOString());
          });
          if (pendingState === "committed") env.setStatus(status(1));
          const continuation = await env.controller.list(listRequest({ cursor, limit: 1 }, network));
          expect(continuation.ok).toBe(false);
          expect(!continuation.ok && continuation.error.meta?.replication).toBe("cursor_restart");
          expect(networkCalls).toBe(0);
          expect(env.listReads()).toBe(1);
        }
      }
    }
  });

  test("a pending create or delete arriving after LIST admission cannot return a stale local page", async () => {
    for (const op of ["put", "delete"] as const) {
      for (const cursorMode of ["first", "continuation"] as const) {
        let reads = 0;
        let armed = cursorMode === "first";
        let pending!: PendingWriteStore;
        const env = setup({
          localListKeys: ["notes/a", "notes/b"],
          afterPendingRead: async () => {
            if (!armed || ++reads !== (cursorMode === "first" ? 3 : 2)) return;
            await pending.update((state) => begin(state, "interleaved", [{ key: "notes/b", op }], new Date(1_000_000).toISOString()));
          },
        });
        pending = env.pending;
        let networkCalls = 0;
        const network = async () => { networkCalls++; return ok({ keys: ["notes/server"], truncated: false }); };
        let cursor: string | undefined;
        if (cursorMode === "continuation") {
          const first = await env.controller.list(listRequest({ limit: 1 }, network));
          expect(first.ok && first.data.keys).toEqual(["notes/a"]);
          cursor = first.ok ? first.data.nextCursor : undefined;
          expect(cursor?.startsWith("tcr1.")).toBe(true);
          armed = true;
        }
        const result = await env.controller.list(listRequest(cursor ? { cursor, limit: 1 } : undefined, network));
        if (cursorMode === "continuation") {
          expect(result.ok).toBe(false);
          expect(!result.ok && result.error.meta?.replication).toBe("cursor_restart");
          expect(networkCalls).toBe(0);
        } else {
          expect(result.ok && result.data.keys).toEqual(["notes/server"]);
          expect(networkCalls).toBe(1);
        }
        expect((await env.pending.read()).records).toMatchObject([{ key: "notes/b", state: "in_flight", op }]);
      }
    }
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
    expect(env.counters()).toMatchObject({ localReads: 0, syncs: 0, opens: 0, networkCalls: 0 });
    const event = env.events.find((item) => item.type === "replication.read" && item.reason === "NETWORK_REQUESTED");
    expect(event?.type === "replication.read" ? [event.outcome, event.latencyMs] : undefined).toEqual(["found", 0]);
  });

  test("a tcr1 cursor for another space restarts without local or network access", async () => {
    const env = setup();
    let networkCalls = 0;
    const result = await env.controller.list(listRequest({ cursor: encodeTcr1("another-space", "notes/", "notes/a") }, async () => { networkCalls++; return networkPage(); }));
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
  test("status reports revoked authority in-process after discovery and in a fresh controller", async () => {
    const revoked = {
      ...status(),
      authority: { state: "revoked" as const, expiresAt: null },
      counts: { keys: 0, contentMissing: 0, tombstones: 0 },
      bytes: 0,
      lastError: { at: new Date(1_200_001).toISOString(), code: "GRANT_REVOKED", message: "delegation-revoked" },
    };
    let inspections = 0;
    const env = setup({
      onSync: () => {
        throw Object.assign(new Error("The replica's grant was revoked"), { code: "GRANT_REVOKED" });
      },
      statusImpl: (call) => {
        if (call === 1) return status();
        throw Object.assign(new Error("The old handle was generation fenced"), { code: "RESET_REQUIRED" });
      },
      inspectStatus: async () => {
        inspections++;
        return revoked;
      },
    });
    env.setNow(1_200_001);
    await env.controller.get(readRequest(env.network));
    expect((await env.controller.status())[0]).toMatchObject({
      state: "revoked",
      authority: { state: "revoked" },
    });
    expect(inspections).toBe(0);

    const restoredProcess = env.createController();
    expect((await restoredProcess.status())[0]).toMatchObject({
      state: "revoked",
      authority: { state: "revoked" },
      counts: { keys: 0, contentMissing: 0, tombstones: 0 },
    });
    expect(inspections).toBe(1);
});

  test("redacted inspection never reports ready or invents authority and grant", async () => {
    const env = setup({
      inspectStatus: async () => ({
        redacted: true,
        coverage: "complete",
        syncedThroughEpoch: 3,
        counts: { keys: 2, contentMissing: 0, tombstones: 0 },
        bytes: 48,
      }),
    });
    const [entry] = await env.controller.status();
    expect(entry).toMatchObject({ state: "idle", redacted: true, counts: { keys: 2 }, bytes: 48 });
    expect(entry).not.toHaveProperty("authority");
    expect(entry).not.toHaveProperty("grant");
    expect(entry).not.toHaveProperty("lastError");
    expect(env.counters().opens).toBe(0);
  });

  test("persisted status inspection is cancelled and settled by close", async () => {
    const { promise: started, resolve: startedResolve } = Promise.withResolvers<void>();
    let settled = false;
    const env = setup({
      inspectStatus: (signal) => {
        startedResolve();
        const { promise, resolve } = Promise.withResolvers<LocalReplicaStatus | undefined>();
        signal.addEventListener("abort", () => {
          settled = true;
          resolve(undefined);
        }, { once: true });
        if (signal.aborted) {
          settled = true;
          resolve(undefined);
        }
        return promise;
      },
    });
    const statusJob = env.controller.status();
    await started;
    await env.controller.close();
    await statusJob;
    expect(settled).toBe(true);
    expect(env.counters().opens).toBe(0);
  });

  test("persisted status inspection times out without a handle", async () => {
    // This uses the real scheduler because the contract under test is an actual wall-clock deadline.
    const env = setup({
      inspectStatus: (signal) => {
        const { promise, resolve } = Promise.withResolvers<LocalReplicaStatus | undefined>();
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
        if (signal.aborted) resolve(undefined);
        return promise;
      },
      setTimeoutImpl: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    });
    const started = Date.now();
    await env.controller.status();
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(env.counters().opens).toBe(0);
    await env.controller.close();
  });
  test("status omits an absent replica without opening or recreating it", async () => {
    const env = setup({ inspectStatus: async () => undefined });
    expect(await env.controller.status()).toEqual([]);
    expect(env.counters().opens).toBe(0);
    await env.controller.purge();
    expect(await env.controller.status()).toEqual([]);
    expect(env.counters().opens).toBe(0);
  });

  test("locked persisted inspections report unavailable for every replica", async () => {
    const env = setup({
      prefixes: ["notes/", "docs/"],
      inspectStatus: async () => { throw Object.assign(new Error("database is locked"), { code: "REPLICA_BUSY" }); },
    });
    expect(await env.controller.status()).toMatchObject([
      { prefix: "notes/", state: "unavailable", reason: "replica_unavailable", errorCode: "REPLICA_BUSY" },
      { prefix: "docs/", state: "unavailable", reason: "replica_unavailable", errorCode: "REPLICA_BUSY" },
    ]);
    await env.controller.close();
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

describe("KVReplication write failure classification", () => {
  for (const [name, error, code] of [
    ["timeout", new RequestTimeoutError(25), "TIMEOUT"],
    ["caller abort", Object.assign(new Error("cancelled"), { name: "AbortError" }), "ABORTED"],
  ] as const) {
    test(`covered write preserves ${name} classification and marks dispatch ambiguous`, async () => {
      const env = setup();
      const result = await env.controller.write({
        op: "put",
        space: identity.space,
        entries: [{ path: "notes/a", body: "value" }],
        signal: new AbortController().signal,
        network: async () => { throw error; },
      });
      expect(result).toMatchObject({ ok: false, error: { code, meta: { requestMayHaveDispatched: true } } });
      const state = await env.pending.read();
      expect(state.committedEpoch).toBe(0);
      expect(state.records).toMatchObject([{ state: "ambiguous", code }]);
    });
  }

  test("covered and uncovered writes expose the same cancellation code and message", async () => {
    for (const error of [
      new RequestTimeoutError(25),
      Object.assign(new Error("cancelled"), { name: "AbortError" }),
    ]) {
      const expected = await setup({ prefixes: [] }).controller.write({
        op: "put",
        space: identity.space,
        entries: [{ path: "notes/a", body: "value" }],
        signal: new AbortController().signal,
        network: async () => ({ ok: false, error: wrapError("kv", error) }),
      });
      const actual = await setup().controller.write({
        op: "put",
        space: identity.space,
        entries: [{ path: "notes/a", body: "value" }],
        signal: new AbortController().signal,
        network: async () => { throw error; },
      });
      expect(actual.ok).toBe(false);
      expect(expected.ok).toBe(false);
      if (!actual.ok && !expected.ok) {
        expect(actual.error.code).toBe(expected.error.code);
        expect(actual.error.message).toBe(expected.error.message);
      }
    }
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
    expect(await purging).toEqual({ purged: ["notes/"], failed: [] });
    await syncing;
  });

  test("purge never rejects when storage throws or exceeds its injected timeout", async () => {
    const immediateTimeout = (fn: () => void) => { fn(); return () => undefined; };
    const throwing = setup({ purgeImpl: () => { throw new Error("storage failure"); }, setTimeoutImpl: immediateTimeout });
    expect(await throwing.controller.purge({ timeoutMs: 20 })).toEqual({ purged: [], failed: [{ prefix: "notes/", code: "REPLICA_UNAVAILABLE" }] });
    const hanging = setup({ purgeImpl: () => new Promise<void>(() => {}), setTimeoutImpl: immediateTimeout });
    expect(await hanging.controller.purge({ timeoutMs: 5 })).toEqual({ purged: [], failed: [{ prefix: "notes/", code: "TIMEOUT" }] });
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
        spec: { identity, space: identity.space, prefix: "notes/", allowSecrets: false },
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
    expect(env.counters()).toMatchObject({ localReads: 1, syncs: 1, opens: 1, networkCalls: 0 });
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
    expect(env.counters()).toMatchObject({ localReads: 0, syncs: 0, opens: 0, networkCalls: 1 });
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
      listPath: "notes/",
      options: { cursor: encodeTcr1(identity.space, "notes/", "notes/a") },
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
    expect(await env.controller.purge()).toEqual({ purged: ["notes/"], failed: [] });
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
  test("read-time coverage metadata refuses GET, LIST, and tcr1 continuation after a pending-store interleaving", async () => {
    for (const coverage of ["empty", "bootstrapping"] as const) {
      for (const op of ["get", "list", "cursor"] as const) {
        let changed = false;
        let pendingReads = 0;
        let networkCalls = 0;
        const env = setup({
          afterPendingRead: () => {
            pendingReads++;
            if (pendingReads !== 2) return;
            changed = true;
            env.setStatus({ ...status(), coverage });
          },
        });
        const result = op === "get"
          ? await env.controller.get(readRequest(env.network))
          : await env.controller.list({
            space: identity.space,
            listPath: "notes/",
            options: op === "cursor" ? { cursor: encodeTcr1(identity.space, "notes/", "notes/a") } : undefined,
            signal: new AbortController().signal,
            network: async () => { networkCalls++; return ok({ keys: ["notes/server"], truncated: false }); },
          });
        expect(changed).toBe(true);
        if (op === "cursor") {
          expect(result.ok).toBe(false);
          expect(!result.ok && result.error.meta?.replication).toBe("cursor_restart");
          expect(networkCalls).toBe(0);
        } else {
          expect(result.ok && (op === "get" && "data" in result.data ? result.data.data : "keys" in result.data ? result.data.keys[0] : undefined)).toBe(op === "get" ? "network" : "notes/server");
          expect(op === "get" ? env.counters().localReads : env.listReads()).toBe(1);
          if (op === "get") expect(env.counters().networkCalls).toBe(1);
          else expect(networkCalls).toBe(1);
        }
      }
    }
  });
  test("read-time authority metadata refuses local GET and LIST", async () => {
    for (const op of ["get", "list"] as const) {
      let pendingReads = 0;
      let networkCalls = 0;
      const env = setup({
        afterPendingRead: () => {
          pendingReads++;
          if (pendingReads !== 2) return;
          env.setStatus({ ...status(), authority: { state: "expired", expiresAt: null } });
        },
      });
      const result = op === "get"
        ? await env.controller.get(readRequest(env.network))
        : await env.controller.list({ ...listRequest(undefined, async () => { networkCalls++; return ok({ keys: ["notes/server"], truncated: false }); }) });
      expect(result.ok).toBe(true);
      expect(op === "get" ? env.counters().localReads : env.listReads()).toBe(1);
      expect(op === "get" ? env.counters().networkCalls : networkCalls).toBe(1);
    }
  });
  test("post-drain status failures are bounded admission failures and preserve caller deadlines", async () => {
    for (const op of ["get", "list"] as const) {
      for (const failure of ["throw", "hang"] as const) {
        for (const callerTimeout of [false, true]) {
          const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
          let syncStarted!: () => void;
          const started = new Promise<void>((resolve) => { syncStarted = resolve; });
          let statusRefreshStarted!: () => void;
          const statusStarted = new Promise<void>((resolve) => { statusRefreshStarted = resolve; });
          let rejectStatusRefresh: (() => void) | undefined;
          let networkCalls = 0;
          const env = setup({
            onSync: (_epoch, signal) => {
              syncStarted();
              return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
            },
            statusImpl: (call) => {
              if (call === 1) return status();
              statusRefreshStarted();
              if (failure === "throw") return new Promise<LocalReplicaStatus>((_resolve, reject) => {
                rejectStatusRefresh = () => reject(Object.assign(new Error("status unavailable"), { code: "STATUS_FAILURE" }));
              });
              return new Promise<LocalReplicaStatus>(() => {});
            },
            setTimeoutImpl: (fn, ms) => {
              const timer = { fn, ms, cancelled: false };
              timers.push(timer);
              return () => { timer.cancelled = true; };
            },
          });
          env.setNow(1_200_001);
          const requestAbort = new AbortController();
          const request = op === "get"
            ? env.controller.get({ ...readRequest(env.network), signal: requestAbort.signal })
            : env.controller.list({
              space: identity.space,
              listPath: "notes/",
              options: { cursor: encodeTcr1(identity.space, "notes/", "notes/a") },
              signal: requestAbort.signal,
              network: async () => { networkCalls++; return ok({ keys: ["network/a"], truncated: false }); },
            });
          await started;
          const staleTimer = timers.find((timer) => timer.ms === options.staleSyncTimeoutMs && !timer.cancelled);
          expect(timers.map((timer) => timer.ms)).toContain(options.staleSyncTimeoutMs);
          staleTimer!.fn();
          await statusStarted;
          if (callerTimeout) {
            requestAbort.abort(new RequestTimeoutError(20));
            rejectStatusRefresh?.();
          } else if (failure === "hang") timers.find((timer) => timer.ms === 3_000 && !timer.cancelled)!.fn();
          else rejectStatusRefresh?.();
          const result = await request;
          if (callerTimeout) {
            expect(result.ok).toBe(false);
            expect(!result.ok && result.error.code).toBe("TIMEOUT");
            expect(networkCalls).toBe(0);
            expect(env.counters().localReads).toBe(0);
          } else if (op === "list") {
            expect(result.ok).toBe(false);
            expect(!result.ok && result.error.meta?.replication).toBe("cursor_restart");
            expect(networkCalls).toBe(0);
          } else {
            expect(result.ok && "data" in result.data && result.data.data).toBe("network");
            expect(env.counters().networkCalls).toBe(1);
            expect(env.counters().localReads).toBe(0);
            expect(lastEvent(env.events, (event) => event.type === "replication.read" && event.source === "network")).toMatchObject({ code: failure === "throw" ? "STATUS_FAILURE" : "STATUS_TIMEOUT" });
          }
          expect(timers.every((timer) => timer.cancelled)).toBe(true);
        }
      }
    }
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
      expect(op === "get" ? env.counters().localReads : env.listReads()).toBe(1);
      expect(env.counters().networkCalls).toBe(0);
      expect(env.events.some((event) => event.type === "replication.read" && event.source === "replica" && event.syncError === "TIMEOUT")).toBe(true);
    }
  });
  test("offline timeout rechecks authority and coverage after sync rejection", async () => {
    const gates = [
      { coverage: "empty" as const, authority: { state: "valid" as const, expiresAt: null }, reason: "coverage_incomplete" },
      { coverage: "complete" as const, authority: { state: "expired" as const, expiresAt: null }, reason: "grant_expired" },
      { coverage: "complete" as const, authority: { state: "revoked" as const, expiresAt: null }, reason: "grant_revoked" },
    ];
    for (const gate of gates) {
      for (const op of ["get", "list"] as const) {
        const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
        let setCurrentStatus!: (value: LocalReplicaStatus) => void;
        let networkCalls = 0;
        let syncStarted!: () => void;
        const started = new Promise<void>((resolve) => { syncStarted = resolve; });
        const env = setup({
          onSync: (_epoch, signal) => {
            syncStarted();
            return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
              setCurrentStatus({ ...status(), coverage: gate.coverage, authority: gate.authority });
              reject(Object.assign(new Error("sync aborted"), { code: "ABORTED" }));
            }, { once: true }));
          },
          setTimeoutImpl: (fn, ms) => {
            const timer = { fn, ms, cancelled: false };
            timers.push(timer);
            return () => { timer.cancelled = true; };
          },
        });
        setCurrentStatus = env.setStatus;
        env.setNow(1_200_001);
        const request = op === "get"
          ? env.controller.get(readRequest(env.network))
          : env.controller.list(listRequest(undefined, async () => {
            networkCalls++;
            return ok({ keys: [], truncated: false });
          }));
        await started;
        timers.find((timer) => timer.ms === options.staleSyncTimeoutMs && !timer.cancelled)!.fn();
        const result = await request;
        const event = lastEvent(env.events, (item) => item.type === "replication.read");
        expect(result.ok).toBe(true);
        expect(op === "get" ? env.counters().localReads : env.listReads()).toBe(0);
        expect(op === "get" ? env.counters().networkCalls : networkCalls).toBe(1);
        expect(event).toMatchObject({ type: "replication.read", source: "network" });
      }
    }
  });
  test("late stale-sync outcomes retain their §5.2 route for get and list", async () => {
    const scenarios = [
      { name: "SOURCE_CHANGED", code: "SOURCE_CHANGED", local: 0, network: 1, eventCode: "SOURCE_CHANGED" },
      { name: "SCOPE_VIOLATION", code: "SCOPE_VIOLATION", local: 0, network: 1, eventCode: "SCOPE_VIOLATION" },
      { name: "CONTENT_MISMATCH", code: "CONTENT_MISMATCH", local: 0, network: 1, eventCode: "CONTENT_MISMATCH" },
      { name: "busy", busy: true, local: 0, network: 1, eventCode: "REPLICA_BUSY" },
      { name: "success", local: 1, network: 0, syncError: undefined },
      { name: "NETWORK_ERROR", code: "NETWORK_ERROR", local: 1, network: 0, syncError: "NETWORK_ERROR" },
      { name: "ABORTED from stale timeout", aborted: true, local: 1, network: 0, syncError: "TIMEOUT" },
    ] as const;
    for (const op of ["get", "list"] as const) {
      for (const scenario of scenarios) {
        let listNetworkCalls = 0;
        const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
        let syncStarted!: () => void;
        let finishSync!: (error?: unknown) => void;
        const started = new Promise<void>((resolve) => { syncStarted = resolve; });
        const env = setup({
          syncOutcome: "busy" in scenario ? "busy" : "synced",
          onSync: (_epoch, signal) => {
            syncStarted();
            return new Promise<void>((resolve, reject) => {
              finishSync = (error) => error === undefined ? resolve() : reject(error);
              signal.addEventListener("abort", () => {
                if ("aborted" in scenario) finishSync(Object.assign(new Error("aborted"), { code: "ABORTED" }));
              }, { once: true });
            });
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
          : env.controller.list(listRequest(undefined, async () => { listNetworkCalls++; return ok({ keys: ["network/a"], truncated: false }); }));
        await started;
        timers.find((timer) => timer.ms === options.staleSyncTimeoutMs && !timer.cancelled)!.fn();
        for (let tick = 0; tick < 10 && !timers.some((timer) => timer.ms === 3_000 && !timer.cancelled); tick++) await Promise.resolve();
        if ("code" in scenario) finishSync(Object.assign(new Error(scenario.code), { code: scenario.code }));
        else if (!("aborted" in scenario)) finishSync();
        const result = await request;
        const localReads = op === "get" ? env.counters().localReads : env.listReads();
        const event = lastEvent(env.events, (item) => item.type === "replication.read");
        expect(result.ok).toBe(true);
        expect(localReads).toBe(scenario.local);
        expect(op === "get" ? env.counters().networkCalls : listNetworkCalls).toBe(scenario.network);
        expect(event?.type === "replication.read" ? event.source : undefined).toBe(scenario.network ? "network" : "replica");
        if ("eventCode" in scenario) expect(event?.type === "replication.read" ? event.code : undefined).toBe(scenario.eventCode);
        if ("syncError" in scenario) expect(event?.type === "replication.read" ? event.syncError : undefined).toBe(scenario.syncError);
      }
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
  test("first-page LIST fences a committed write cleared by a peer controller", async () => {
    for (const mode of ["foreground", "background"] as const) {
      const shared = createMemoryPendingStore(identity);
      const pendingStore = () => ({ ...shared, durable: true } as PendingWriteStore);
      const env = setup({ mode, syncOutcome: "network_error", pendingStore: pendingStore() });
      const peer = setup({ pendingStore: pendingStore() });
      const write = await peer.controller.write({
        op: "put",
        space: identity.space,
        entries: [{ path: "notes/a", body: "peer value" }],
        signal: new AbortController().signal,
        network: async () => ok({}),
      });
      expect(write.ok).toBe(true);
      await peer.controller.sync();
      expect((await env.pending.read()).records).toHaveLength(0);
      env.setNow(1_200_001);
      let networkCalls = 0;
      const result = await env.controller.list({
        ...listRequest(undefined, async () => {
          networkCalls++;
          return ok({ keys: ["notes/server"], truncated: false });
        }),
      });
      expect(result.ok && result.data.keys).toEqual(["notes/server"]);
      expect(env.listReads()).toBe(0);
      expect(networkCalls).toBe(1);
      expect(lastEvent(env.events, (event) => event.type === "replication.read")).toMatchObject({
        type: "replication.read", source: "network", reason: "REPLICA_BEHIND_OWN_WRITES",
      });
    }
  });

  test("first-page LIST rechecks committed epoch after pending-store read", async () => {
    for (const mode of ["foreground", "background"] as const) {
      let pendingReads = 0;
      let pending!: PendingWriteStore;
      const env = setup({
        mode,
        afterPendingRead: async () => {
          pendingReads++;
          if (pendingReads === 2) await pending.update((state) => { state.committedEpoch = 1; });
        },
      });
      pending = env.pending;
      let networkCalls = 0;
      const result = await env.controller.list({
        ...listRequest(undefined, async () => {
          networkCalls++;
          return ok({ keys: ["notes/server"], truncated: false });
        }),
      });
      expect(result.ok && result.data.keys).toEqual(["notes/server"]);
      expect(env.listReads()).toBe(0);
      expect(networkCalls).toBe(1);
      expect(lastEvent(env.events, (event) => event.type === "replication.read")).toMatchObject({
        type: "replication.read", source: "network", reason: "REPLICA_BEHIND_OWN_WRITES",
      });
    }
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
  test("a waiting read does not treat another caller's shared-sync abort as its timeout", async () => {
    for (const op of ["get", "list"] as const) {
      for (const cause of ["caller", "close", "purge"] as const) {
        const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
        let started!: () => void;
        const syncStarted = new Promise<void>((resolve) => { started = resolve; });
        const env = setup({
          onSync: (_epoch, signal) => {
            started();
            return new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
              reject(Object.assign(new Error("shared sync aborted"), { code: "ABORTED" }));
            }, { once: true }));
          },
          setTimeoutImpl: (fn, ms) => {
            const timer = { fn, ms, cancelled: false };
            timers.push(timer);
            return () => { timer.cancelled = true; };
          },
        });
        env.setNow(1_200_001);
        const ownerAbort = new AbortController();
        const owner = env.controller.get({ ...readRequest(env.network), signal: ownerAbort.signal });
        await syncStarted;
        let networkCalls = 0;
        const waiter = op === "get"
          ? env.controller.get(readRequest(async () => {
            networkCalls++;
            return ok({ data: "network", headers: { get: () => null } });
          }))
          : env.controller.list(listRequest(undefined, async () => {
            networkCalls++;
            return ok({ keys: ["network/a"], truncated: false });
          }));
        for (let tick = 0; tick < 10 && timers.filter((timer) => timer.ms === options.staleSyncTimeoutMs && !timer.cancelled).length < 2; tick++) await Promise.resolve();
        timers.filter((timer) => timer.ms === options.staleSyncTimeoutMs && !timer.cancelled).at(-1)!.fn();
        if (cause === "caller") ownerAbort.abort();
        else if (cause === "close") await env.controller.close();
        else await env.controller.purge();
        const result = await waiter;
        await owner;
        const event = lastEvent(env.events, (item) => item.type === "replication.read");
        expect(result.ok).toBe(true);
        expect(op === "get" ? env.counters().localReads : env.listReads()).toBe(0);
        expect(networkCalls).toBe(1);
        expect(event).toMatchObject({ type: "replication.read", source: "network", code: "ABORTED" });
      }
    }
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
    const env = setup({ consentAnchor: { at: 1_000_000, source: "siwe" }, runtimeMint: (signal) => {
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
    const env = setup({ consentAnchor: { at: 1_000_000, source: "siwe" }, runtimeMint: (signal) => {
      mintSignal = signal;
      markMintStarted();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const opening = env.controller.get(readRequest(env.network));
    await mintStarted;
    expect(await env.controller.purge()).toEqual({ purged: ["notes/"], failed: [] });
    await opening;
    expect(mintSignal?.aborted).toBe(true);
  });
});
