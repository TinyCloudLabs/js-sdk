/**
 * Origin-wide replica worker host. One sealed partition store per handle;
 * RC1 feed verification, fencing and repair remain in the shared Replica engine.
 */
import type {
  LocalGetResult,
  LocalListResult,
  LocalReadMeta,
  LocalSyncResult,
  ReplicaDevice,
  ReplicaBrowserGateAccess,
  ReplicaGrantInfo,
  ReplicaPartitionIndexEntry,
  ReplicaPeerCommit,
  ReplicaQuotaSpec,
} from "@tinycloud/sdk-services/kv/replication";
import { MAX_GRANT_TTL_MS, REPLICA_KV_CHANNEL } from "@tinycloud/sdk-services/kv/replication/contractConstants";
import { canonicalReplicationIdentity, replicationIdentityKey } from "@tinycloud/sdk-services/kv/replication";

import { principalOf } from "../did.js";
import { Replica, type ReadMeta } from "../engine.js";
import { ReplicaError, ReplicaErrorCode, gatedError, isReplicaError } from "../errors.js";
import { assertGrantInstallable, grantUnconstrained, parseUcanGrant } from "../grant.js";
import { assertBrowserReadThroughScope, assertFolderPrefix } from "../scope.js";
import type { GrantRecord, ReplicaTransport } from "../types.js";
import { requestAsPromise } from "../browser/idb.js";
import { decodeJson, encodeJson } from "./codec.js";
import { gateHash } from "./gateKeys.js";
import type { BrowserReplicaGateTx } from "./gateTx.js";
import { DEVICE_QUOTA_PARTITION_ID, type ReplicaBrowserQuotaLedger } from "./ledger.js";
import { grantInfoOf } from "./grantInfo.js";
import type { KvChannelMessage, KvEvent, KvGetResult, KvOpenSpec, KvReply, KvRequest, KvResults, KvWireError } from "./protocol.js";
import { KV_STORE, partitionIdOf } from "./schema.js";
import { SealedReplicaStore } from "./secureStore.js";
import { measureSealedRow, openSealed, seal, type SealedRecord } from "./sealed.js";

/** Writer Web Lock of one partition: one tab syncs it at a time. */
export function partitionLockName(partitionId: string): string {
  return `${REPLICA_KV_CHANNEL}:${partitionId}`;
}

type Locks = Pick<LockManager, "request">;

/**
 * Test-only fault injection. Never set by the production worker entry.
 * @internal
 */
export type KvWorkerFaults = {
  /** Runs inside every sync's `finish` step, before the epoch commits; throw to fail the sync after its last page. */
  beforeFinish?(partitionId: string): Promise<void> | void;
};

export type KvWorkerDeps = {
  post(message: KvReply | { event: KvEvent }, transfer?: Transferable[]): void;
  /** Mint the origin's owner device key (called at most once per origin, on first need). */
  createDevice(): Promise<ReplicaDevice> | ReplicaDevice;
  /** A transport that invokes with exactly `grant` and `device` against the spec's host. */
  transportFor(grant: GrantRecord, spec: KvOpenSpec, device: ReplicaDevice): ReplicaTransport;
  /**
   * The lifecycle gate's transaction seam (`createIndexedDbGateTx`). Required:
   * every id is salted from its `snapshot()` and every data transaction runs
   * through its `run`, so without it `open` refuses REPLICA_GATED
   * `gate_unavailable` — there is no ungated mode.
   */
  gateTx?: BrowserReplicaGateTx;
  /** Quota admission is required for every signed ciphertext-row mutation. */
  ledgerFor?(quota: ReplicaQuotaSpec | undefined): ReplicaBrowserQuotaLedger | undefined;
  locks?: Locks;
  channel?: BroadcastChannel | null;
  holder?: string;
  now?: () => number;
  faults?: KvWorkerFaults;
};

type Handle = {
  id: number;
  spec: KvOpenSpec;
  device: ReplicaDevice;
  partitionId: string;
  store: SealedReplicaStore;
  syncs: Map<number, { abort: AbortController; settled: Promise<unknown> }>;
};

function wireError(error: unknown): KvWireError {
  if (isReplicaError(error)) {
    return { code: error.code, message: error.message, ...(error.detail === undefined ? {} : { detail: error.detail }) };
  }
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    // Contract errors from the gate/ledger seams (`Error & { code, gate? }`).
    const gate = "gate" in error && typeof error.gate === "string" ? { gate: error.gate } : undefined;
    return { code: error.code, message: error instanceof Error ? error.message : String(error), ...(gate === undefined ? {} : { detail: gate }) };
  }
  if (error instanceof DOMException && error.name === "AbortError") return { code: "ABORTED", message: error.message };
  return { code: "ERROR", message: error instanceof Error ? error.message : String(error) };
}

export function createKvWorkerHost(deps: KvWorkerDeps): { receive(request: { id: number } & KvRequest): void } {
  const now = deps.now ?? Date.now;
  const holder = deps.holder ?? `w${Math.random().toString(36).slice(2, 10)}`;
  const handles = new Map<number, Handle>();
  const requests = new Map<number, AbortController>();
  let nextHandle = 1;

  const channel = deps.channel === undefined ? (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(REPLICA_KV_CHANNEL)) : deps.channel;
  if (channel !== null) {
    channel.onmessage = (message: MessageEvent) => {
      const data: unknown = message.data;
      if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "committed") return;
      const { partitionId, info } = data as KvChannelMessage;
      for (const handle of handles.values()) {
        if (handle.partitionId === partitionId) deps.post({ event: { event: "peerCommit", handle: handle.id, info } });
      }
    };
  }


  /** The owner device is minted only on demand, sealed before its guarded write. */
  async function storedDevice(gate: BrowserReplicaGateTx, access: ReplicaBrowserGateAccess, ledger: ReplicaBrowserQuotaLedger): Promise<ReplicaDevice> {
    const key = await gate.readAccountKey(access);
    const read = (tx: IDBTransaction) =>
      requestAsPromise<SealedRecord | undefined>(tx.objectStore(KV_STORE.device).get("device"));
    const stored = await gate.run({ stores: [KV_STORE.device], mode: "readonly" }, access, read);
    if (stored !== undefined) {
      const device = decodeJson<ReplicaDevice>(await openSealed(key.aesGcm, stored, "device\0owner"));
      if (device === null || typeof device !== "object" || typeof device.did !== "string" ||
          device.jwk === null || typeof device.jwk !== "object") {
        throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The encrypted owner device is invalid.");
      }
      return device;
    }
    const candidate = await deps.createDevice();
    const sealed = await seal(key.aesGcm, encodeJson(candidate), "device\0owner");
    const row = { ...sealed, size: 0 };
    row.size = measureSealedRow("device", row);
    const freeBytes = await ledger.freeBytes();
    const written = await gate.run({ stores: [KV_STORE.device], mode: "readwrite" }, access, async (tx) => {
      const existing = await read(tx);
      if (existing === undefined) {
        const admission = { partitionId: DEVICE_QUOTA_PARTITION_ID, partitionDeltaBytes: 0, deviceDeltaBytes: row.size, freeBytes };
        await ledger.admitRows(tx, admission);
        tx.objectStore(KV_STORE.device).put(row, "device");
        await ledger.accountRows(tx, admission);
      }
      return existing;
    });
    if (written === undefined) return candidate;
    const device = decodeJson<ReplicaDevice>(await openSealed(key.aesGcm, written, "device\0owner"));
    if (device === null || typeof device !== "object" || typeof device.did !== "string" ||
        device.jwk === null || typeof device.jwk !== "object") {
      throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The encrypted owner device is invalid.");
    }
    return device;
  }

  function need(id: number): Handle {
    const handle = handles.get(id);
    if (handle === undefined) throw new ReplicaError(ReplicaErrorCode.CLOSED, "The replica handle is closed.");
    return handle;
  }

  async function open(spec: KvOpenSpec): Promise<KvResults["open"]> {
    assertFolderPrefix(spec.prefix);
    assertBrowserReadThroughScope(spec.space, spec.prefix, spec.allowSecrets);
    if (spec.grantPolicy === undefined || !Number.isFinite(spec.grantPolicy.grantTtlMs)
      || spec.grantPolicy.grantTtlMs <= 0 || spec.grantPolicy.grantTtlMs > MAX_GRANT_TTL_MS) {
      throw new ReplicaError(ReplicaErrorCode.INVALID_ARGUMENT, "A finite, positive grantPolicy.grantTtlMs within the grant TTL limit is required.");
    }
    if (deps.locks === undefined) throw gatedError("gate_unavailable", "Web Locks are required to open a browser replica.");
    const identity = canonicalReplicationIdentity(spec.identity);
    const gate = deps.gateTx;
    if (gate === undefined) throw gatedError("gate_unavailable", "No lifecycle gate is wired into the replica worker.");
    const stamp = spec.stamp;
    if (stamp === undefined) throw gatedError("not_established", "The session has no replica stamp.");
    // Snapshot and derive private HMAC ids before the first guarded transaction.
    const snapshot = await gate.snapshot();
    if (snapshot === null) throw gatedError("not_established", "No replica gate exists on this origin yet.");
    const principalHash = await gateHash(snapshot.gateHmac, "principal", identity.principal.toLowerCase());
    const identityKey = replicationIdentityKey(identity);
    const identityKeyHash = await gateHash(snapshot.gateHmac, "identity", identityKey);
    const base: ReplicaBrowserGateAccess = {
      stamp, incarnation: snapshot.incarnation, keyId: snapshot.keyId,
      accountKeyId: snapshot.accountKeyId, principalHash, identityKeyHash,
    };
    const ledger = deps.ledgerFor?.(spec.quota);
    if (ledger === undefined) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The browser replica quota ledger is unavailable.");
    // An injected session device is never replaced by, or persisted as, the owner device.
    const device = spec.device ?? (await storedDevice(gate, base, ledger));
    const partitionId = await partitionIdOf({ identity, prefix: spec.prefix, deviceDid: device.did }, snapshot.gateHmac);
    const lookupId = await gateHash(snapshot.gateHmac, "lookup", `${identityKey}\n${spec.prefix}`);
    const index: ReplicaPartitionIndexEntry = {
      partitionId, principalHash, identityKeyHash, lookupId,
      ownerDevice: spec.device === undefined, createdAt: now(),
    };
    const access: ReplicaBrowserGateAccess = { ...base, partitionId };
    const store = await SealedReplicaStore.openIn({
      partitionId, holder, now, gate, access, ledger, identityKeyHash,
      policy: spec.grantPolicy, index,
    });
    try {
      const config = {
        name: spec.prefix.replace(/\/+$/, "") || "replica",
        replicaId: partitionId,
        host: identity.host,
        space: spec.space,
        prefix: spec.prefix,
        deviceDid: principalOf(device.did),
        allowSecrets: spec.allowSecrets,
        localReadPolicy: "whileGrantValid" as const,
        retentionGrantCid: null,
      };
      const existing = await store.open();
      if (existing === null) {
        await store.init(config);
      } else if (
        // The partition id hashes identity, prefix and device; a stored config naming
        // anything else is corruption, never a replica to share.
        existing.config.host !== config.host ||
        existing.config.space !== config.space ||
        existing.config.prefix !== config.prefix ||
        principalOf(existing.config.deviceDid) !== config.deviceDid
      ) {
        throw new ReplicaError(ReplicaErrorCode.CONFIG_MISMATCH, "The stored replica does not match its partition; purge it to start over.");
      }
    } catch (error) {
      await store.close();
      throw error;
    }
    const id = nextHandle++;
    handles.set(id, { id, spec, device, partitionId, store, syncs: new Map() });
    return { handle: id, deviceDid: spec.device?.did ?? principalOf(device.did), partitionId };
  }

  /** `LocalReadMeta` from the engine's read metadata and the persisted epoch fence. */
  async function readMeta(handle: Handle, meta: ReadMeta): Promise<LocalReadMeta> {
    const { syncedThroughEpoch } = await handle.store.syncFence();
    return { asOf: meta.asOf, coverage: meta.coverage, authority: meta.authority, syncedThroughEpoch };
  }

  async function get(handle: Handle, key: string): Promise<{ result: KvGetResult; transfer: Transferable[] }> {
    const result = await new Replica({ store: handle.store, now }).get(key);
    const meta = await readMeta(handle, result.meta);
    switch (result.status) {
      case "present": {
        const value = result.value.slice().buffer;
        return { result: { status: "present", key, value, etag: result.etag, metadata: result.metadata, meta }, transfer: [value] };
      }
      case "content_missing":
        return { result: { status: "content_missing", key, etag: result.etag, metadata: result.metadata, meta }, transfer: [] };
      default:
        return { result: { status: result.status, key, meta }, transfer: [] };
    }
  }

  async function list(handle: Handle, request: Extract<KvRequest, { op: "list" }>): Promise<LocalListResult> {
    const result = await new Replica({ store: handle.store, now }).list({
      prefix: request.prefix,
      ...(request.after === undefined ? {} : { after: request.after }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    });
    return { keys: result.entries.map((entry) => entry.key), meta: await readMeta(handle, result.meta) };
  }

  async function grant(handle: Handle): Promise<ReplicaGrantInfo | null> {
    const state = await handle.store.open();
    return state === null ? null : grantInfoOf(state, handle.spec);
  }

  async function installGrant(handle: Handle, ucan: string): Promise<ReplicaGrantInfo> {
    const parsed = parseUcanGrant(ucan);
    assertGrantInstallable(parsed, { deviceDid: principalOf(handle.device.did), space: handle.spec.space, prefix: handle.spec.prefix, now: now() });
    // A caveated get or sync can never serve a replica: it cannot apply the caveat locally.
    if (!grantUnconstrained(parsed, handle.spec.space, handle.spec.prefix)) {
      throw new ReplicaError(ReplicaErrorCode.GRANT_NOT_COVERING, "The grant's get or sync coverage carries caveats; re-mint instead of installing it.");
    }
    await handle.store.installGrant(parsed);
    const info = await grant(handle);
    if (info === null) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "The replica has not been created.");
    return info;
  }

  async function sync(handle: Handle, abort: AbortController, syncStartEpoch: number): Promise<LocalSyncResult> {
    const locks = deps.locks;
    if (locks === undefined) throw gatedError("gate_unavailable", "Web Locks are required to sync a browser replica.");
    abort.signal.throwIfAborted();
    let pages = 0;
    const engine = new Replica({
      store: handle.store,
      now,
      transportFor: (record) => deps.transportFor(record, handle.spec, handle.device),
      ...(handle.spec.contentFetch === undefined ? {} : { contentFetch: handle.spec.contentFetch }),
      onCommit: () => (pages += 1),
    });
    let outcome: LocalSyncResult | undefined;
    try {
      const result: LocalSyncResult = await locks.request(partitionLockName(handle.partitionId), { ifAvailable: true }, async (lock): Promise<LocalSyncResult> => {
        if (lock === null) return { status: "busy" };
        await handle.store.claimWriterLock();
        const report = await engine.sync({
          signal: abort.signal,
          finish: async (lease) => {
            await deps.faults?.beforeFinish?.(handle.partitionId);
            // The epoch and the completion marker commit together, after pages, repairs and GC.
            await handle.store.completeSync(lease, syncStartEpoch);
          },
        });
        return {
          status: "synced",
          pages: report.pages,
          changes: report.changes,
          deleted: report.deleted,
          fetched: report.fetched,
          contentMissing: report.contentMissing,
          coverage: report.coverage,
          syncedThroughEpoch: syncStartEpoch,
        };
      });
      outcome = result;
      return result;
    } finally {
      // Siblings learn of any sync that committed pages, finished or not.
      if (pages > 0 && channel !== null) {
        const fence = await handle.store.syncFence().catch(() => undefined);
        if (fence !== undefined) {
          const info: ReplicaPeerCommit = {
            at: now(),
            syncedThroughEpoch: fence.syncedThroughEpoch,
            ...(outcome?.status === "synced" ? { changes: outcome.changes, coverage: outcome.coverage } : {}),
          };
          try {
            channel.postMessage({ type: "committed", partitionId: handle.partitionId, info } satisfies KvChannelMessage);
          } catch {
            // A closing channel never changes the sync's result.
          }
        }
      }
    }
  }

  async function status(handle: Handle): Promise<KvResults["status"]> {
    const engine = new Replica({ store: handle.store, now });
    const report = await engine.status();
    const fence = await handle.store.syncFence();
    const state = await handle.store.open();
    return {
      coverage: report.coverage,
      lastSyncAt: report.lastSyncAt,
      syncedThroughEpoch: fence.syncedThroughEpoch,
      authority: { state: report.authority.state, expiresAt: report.authority.expiresAt },
      grant: state === null ? null : grantInfoOf(state, handle.spec),
      counts: report.counts,
      bytes: report.bytes,
      lastError: report.lastError,
    };
  }

  async function close(id: number): Promise<KvResults["close"]> {
    const handle = handles.get(id);
    if (handle === undefined) return { closed: true };
    handles.delete(id);
    for (const running of handle.syncs.values()) running.abort.abort();
    await Promise.allSettled([...handle.syncs.values()].map((running) => running.settled));
    await handle.store.close();
    return { closed: true };
  }

  async function dispatch(id: number, request: KvRequest): Promise<{ result: unknown; transfer?: Transferable[] }> {
    switch (request.op) {
      case "open":
        return { result: await open(request.spec) };
      case "get":
        return get(need(request.handle), request.key);
      case "list":
        return { result: await list(need(request.handle), request) };
      case "grant":
        return { result: await grant(need(request.handle)) };
      case "installGrant":
        return { result: await installGrant(need(request.handle), request.ucan) };
      case "sync": {
        const handle = need(request.handle);
        const abort = new AbortController();
        requests.set(id, abort);
        const running = sync(handle, abort, request.syncStartEpoch);
        const settled = running.then(
          () => undefined,
          () => undefined,
        );
        handle.syncs.set(id, { abort, settled });
        try {
          return { result: await running };
        } finally {
          requests.delete(id);
          handle.syncs.delete(id);
        }
      }
      case "cancel": {
        const target = requests.get(request.target);
        target?.abort(new DOMException("The sync was cancelled.", "AbortError"));
        return { result: { cancelled: target !== undefined } };
      }
      case "status":
        return { result: await status(need(request.handle)) };
      case "close":
        return { result: await close(request.handle) };
    }
  }

  return {
    /**
     * One request from the main-thread client (`{ id, op, … }`). Replies to
     * handle operations carry the stamp they ran under (`ReplicaStampedReply`);
     * the client delivers only on an exact match plus `deliverable`.
     */
    receive(request: { id: number } & KvRequest): void {
      const id = request.id;
      const stamp = request.op === "open" ? request.spec.stamp : "handle" in request ? handles.get(request.handle)?.spec.stamp : undefined;
      dispatch(id, request).then(
        ({ result, transfer }) => deps.post({ id, ok: true, result, ...(stamp === undefined ? {} : { stamp }) }, transfer ?? []),
        (error: unknown) => deps.post({ id, ok: false, err: wireError(error) }),
      );
    },
  };
}
