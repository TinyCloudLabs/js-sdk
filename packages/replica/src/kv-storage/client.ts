/**
 * `indexedDbReplicaStorage()`: the browser `KVReplicaStorage` (TC-858 Phase 2
 * plan §3, CONTRACT.md §1). Main-thread half: a thin RPC client over one
 * dedicated worker per storage instance, which owns the engine, the network
 * and the device key. Pending writes, `inspectStatus` and `purge` run here
 * directly against the origin database: none needs WASM or the network, so
 * none spawns the worker.
 *
 * Gate (CONTRACT.md §2): with no lifecycle gate there is no ungated mode —
 * `open`, pending writes, `purge` and `inspectStatus` refuse REPLICA_GATED
 * `gate_unavailable`. Every replica-served value is delivered only when the
 * worker's reply carries exactly the handle's stamp and `deliverable(stamp)`.
 */
import type {
  KVReplicaHandle,
  KVReplicaSpec,
  KVReplicaStorage,
  LocalGetResult,
  LocalListResult,
  LocalReplicaStatus,
  LocalSyncResult,
  PendingWriteStore,
  PurgeTarget,
  ReplicaDevice,
  ReplicaGateSnapshot,
  ReplicaGateTx,
  ReplicaGrantInfo,
  ReplicaLifecycleGate,
  ReplicaQuotaLedger,
  ReplicaSessionStamp,
  ReplicationIdentity,
} from "@tinycloud/sdk-services/kv/replication";
import { canonicalReplicationIdentity } from "@tinycloud/sdk-services/kv/replication";

import { principalOf } from "../did.js";
import { ReplicaError, ReplicaErrorCode, gatedError as gated } from "../errors.js";
import { assertFolderPrefix } from "../scope.js";
import { idbError, requestAsPromise, transactionDone } from "../browser/idb.js";
import { IndexedDbReplicaStore } from "../browser/store.js";
import { createIndexedDbGateTx } from "./gateTx.js";
import { grantInfoOf } from "./grantInfo.js";
import { createIndexedDbLifecycle } from "./lifecycle.js";
import { IndexedDbPendingWriteStore } from "./pending.js";
import type { KvEvent, KvOpenSpec, KvReply, KvRequest, KvResults, KvWireError } from "./protocol.js";
import { ERASE_STORES, KV_STORE, identityKeyHashOf, kvLayout, kvPartitionEraser, openKvDatabase, partitionIdOf } from "./schema.js";

export type IndexedDbReplicaStorageOptions = {
  /**
   * Spawn this worker instead of the bundled `kv-storage.worker.js`
   * (custom bundler layouts). A factory runs on first `open`.
   */
  worker?: Worker | URL | string | (() => Worker);
  /** The lifecycle gate (`storage.lifecycle`): consulted before every open, sync and delivery. */
  lifecycle?: ReplicaLifecycleGate;
  /**
   * The main-thread transaction guard (`createIndexedDbGateTx`): the pending
   * store runs every read and update through it, and `purge`/`inspectStatus`
   * derive salted ids from its `snapshot()`.
   */
  gateTx?: ReplicaGateTx<IDBTransaction>;
  /** Releases quota for partitions `purge()` erases, in the erase transaction. */
  ledger?: Pick<ReplicaQuotaLedger<IDBTransaction>, "accountErase">;
};

/** Test seam: `@tinycloud/replica/kv-storage/testing` terminates the storage's worker through it. */
export const KILL_WORKER = Symbol.for("tinycloud.replica.kv-storage.killWorker");

function replyError(err: KvWireError): ReplicaError {
  const error = new ReplicaError(err.code as ReplicaErrorCode, err.message, err.detail);
  // Contract shape for gate refusals: `Error & { code: "REPLICA_GATED"; gate }`.
  if (err.code === ReplicaErrorCode.GATED && typeof err.detail?.gate === "string") Object.assign(error, { gate: err.detail.gate });
  return error;
}

function sameStamp(a: ReplicaSessionStamp | undefined, b: ReplicaSessionStamp): boolean {
  return a !== undefined && a.incarnation === b.incarnation && a.lifecycleEpoch === b.lifecycleEpoch;
}

function spawn(source: IndexedDbReplicaStorageOptions["worker"]): Worker {
  if (source !== undefined) {
    if (typeof Worker !== "undefined" && source instanceof Worker) return source;
    if (source instanceof URL || typeof source === "string") return new Worker(source, { type: "module" });
    if (typeof source === "function") return source();
  }
  return new Worker(new URL("./kv-storage.worker.js", import.meta.url), { type: "module" });
}

type Reply<T> = { result: T; stamp: ReplicaSessionStamp | undefined };
type Pending = { resolve(reply: Reply<unknown>): void; reject(error: Error): void };

/** One live worker. A dead one (crashed or killed) fails its calls and is replaced on the next use. */
class WorkerConnection {
  readonly ready: Promise<void>;
  dead = false;
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  readonly #onEvent: (event: KvEvent) => void;
  #nextId = 1;
  #readyResolve: () => void;
  #readyReject: (error: Error) => void;

  constructor(worker: Worker, onEvent: (event: KvEvent) => void) {
    this.#worker = worker;
    this.#onEvent = onEvent;
    const ready = Promise.withResolvers<void>();
    this.ready = ready.promise;
    ready.promise.catch(() => undefined);
    this.#readyResolve = ready.resolve;
    this.#readyReject = ready.reject;
    worker.onmessage = (message: MessageEvent<KvReply | { event: KvEvent }>) => this.#receive(message.data);
    worker.onerror = (event) => this.kill(new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, event.message || "The replica worker failed."));
  }

  #receive(data: KvReply | { event: KvEvent }): void {
    if ("event" in data) {
      if (data.event.event === "ready") this.#readyResolve();
      else this.#onEvent(data.event);
      return;
    }
    const pending = this.#pending.get(data.id);
    if (pending === undefined) return;
    this.#pending.delete(data.id);
    if (data.ok) pending.resolve({ result: data.result, stamp: data.stamp });
    else pending.reject(replyError(data.err));
  }

  /** Post `request`; `onId` learns the request id before the reply (cancel needs it). */
  async call<Op extends KvRequest["op"]>(request: Extract<KvRequest, { op: Op }>, onId?: (id: number) => void): Promise<Reply<KvResults[Op]>> {
    await this.ready;
    if (this.dead) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica worker stopped.");
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<Reply<unknown>>();
    this.#pending.set(id, { resolve, reject });
    onId?.(id);
    this.#worker.postMessage({ id, ...request });
    return promise as Promise<Reply<KvResults[Op]>>;
  }

  /** Fire-and-forget (cancel): no reply is awaited. */
  notify(request: KvRequest): void {
    if (this.dead) return;
    this.#worker.postMessage({ id: this.#nextId++, ...request });
  }

  kill(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.#worker.terminate();
    this.#readyReject(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

class IndexedDbReplicaHandle implements KVReplicaHandle {
  readonly spec: KVReplicaSpec;
  readonly deviceDid: string;
  readonly partitionId: string;
  readonly #storage: IndexedDbReplicaStorage;
  readonly #lifecycle: ReplicaLifecycleGate;
  readonly #stamp: ReplicaSessionStamp;
  readonly #wire: KvOpenSpec;
  #connection: WorkerConnection;
  #remote: number;
  #closed = false;
  readonly #syncs = new Set<Promise<unknown>>();

  constructor(
    storage: IndexedDbReplicaStorage,
    gate: { lifecycle: ReplicaLifecycleGate; stamp: ReplicaSessionStamp },
    spec: KVReplicaSpec,
    wire: KvOpenSpec,
    connection: WorkerConnection,
    opened: KvResults["open"],
  ) {
    this.#storage = storage;
    this.#lifecycle = gate.lifecycle;
    this.#stamp = gate.stamp;
    this.spec = spec;
    this.#wire = wire;
    this.#connection = connection;
    this.#remote = opened.handle;
    this.deviceDid = opened.deviceDid;
    this.partitionId = opened.partitionId;
  }

  get remote(): { connection: WorkerConnection; handle: number } {
    return { connection: this.#connection, handle: this.#remote };
  }

  /** Before every request that reaches the worker (and every delivery): the gate must still honour the stamp. */
  #assertDeliverable(): void {
    if (!this.#lifecycle.deliverable(this.#stamp)) throw gated("stamp_stale", "The replica session ended.");
  }

  /** The live worker-side handle; after a worker restart the spec is reopened on the new worker. */
  async #live(): Promise<{ connection: WorkerConnection; handle: number }> {
    if (this.#closed) throw new ReplicaError(ReplicaErrorCode.CLOSED, "The replica handle is closed.");
    this.#assertDeliverable();
    if (this.#connection.dead) {
      const connection = this.#storage.connection();
      const opened = this.#deliver(await connection.call({ op: "open", spec: this.#wire }));
      this.#connection = connection;
      this.#remote = opened.handle;
    }
    return { connection: this.#connection, handle: this.#remote };
  }

  /** Delivery check (CONTRACT §2): drop a reply that ran under another (or no) stamp, or that the gate no longer honours. */
  #deliver<T>(reply: Reply<T>): T {
    if (!sameStamp(reply.stamp, this.#stamp)) throw gated("stamp_stale", "The replica reply ran under another session; it was not delivered.");
    this.#assertDeliverable();
    return reply.result;
  }

  async get(key: string): Promise<LocalGetResult> {
    const { connection, handle } = await this.#live();
    const result = this.#deliver(await connection.call({ op: "get", handle, key }));
    return result.status === "present" ? { ...result, value: new Uint8Array(result.value) } : result;
  }

  async list(options: { prefix: string; after?: string; limit?: number }): Promise<LocalListResult> {
    const { connection, handle } = await this.#live();
    return this.#deliver(await connection.call({ op: "list", handle, ...options }));
  }

  async grant(): Promise<ReplicaGrantInfo | null> {
    const { connection, handle } = await this.#live();
    return this.#deliver(await connection.call({ op: "grant", handle }));
  }

  async installGrant(ucan: string): Promise<ReplicaGrantInfo> {
    const { connection, handle } = await this.#live();
    return this.#deliver(await connection.call({ op: "installGrant", handle, ucan }));
  }

  async sync(options: { signal: AbortSignal; syncStartEpoch: number }): Promise<LocalSyncResult> {
    options.signal.throwIfAborted();
    const { connection, handle } = await this.#live();
    let requestId: number | undefined;
    const cancel = (): void => {
      if (requestId !== undefined) connection.notify({ op: "cancel", target: requestId });
    };
    options.signal.addEventListener("abort", cancel, { once: true });
    const running = connection.call({ op: "sync", handle, syncStartEpoch: options.syncStartEpoch }, (id) => {
      requestId = id;
      if (options.signal.aborted) cancel();
    });
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    this.#syncs.add(settled);
    try {
      return this.#deliver(await running);
    } finally {
      this.#syncs.delete(settled);
      options.signal.removeEventListener("abort", cancel);
    }
  }

  async status(): Promise<LocalReplicaStatus> {
    const { connection, handle } = await this.#live();
    const status = this.#deliver(await connection.call({ op: "status", handle }));
    return { ...status, persisted: await this.#storage.persisted(), purgePending: await purgePendingFor(this.#lifecycle, this.partitionId, null) };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#storage.forget(this);
    // The worker aborts this handle's syncs and replies once they settle.
    if (!this.#connection.dead) await this.#connection.call({ op: "close", handle: this.#remote }).catch(() => undefined);
    await Promise.allSettled([...this.#syncs]);
  }
}

/** True while a purge intent covers the partition, or the identity's pending record. */
async function purgePendingFor(lifecycle: ReplicaLifecycleGate, partitionId: string | null, identityKeyHash: string | null): Promise<boolean> {
  return (await lifecycle.pendingPurge()).some((intent) =>
    intent.kind === "partition" ? intent.partitionId === partitionId : intent.identityKeyHash === identityKeyHash,
  );
}

/** The origin's stored owner device; purge and inspection are exempt from gating and only read it. */
async function storedDevice(db: IDBDatabase): Promise<ReplicaDevice | undefined> {
  return requestAsPromise<ReplicaDevice | undefined>(db.transaction(KV_STORE.device).objectStore(KV_STORE.device).get("device"));
}

class IndexedDbReplicaStorage implements KVReplicaStorage {
  readonly kind = "indexeddb" as const;
  readonly lifecycle: ReplicaLifecycleGate | undefined;
  readonly #options: IndexedDbReplicaStorageOptions;
  readonly #handles = new Set<IndexedDbReplicaHandle>();
  #connection: WorkerConnection | undefined;
  #persisted: Promise<boolean | null> | undefined;

  constructor(options: IndexedDbReplicaStorageOptions) {
    this.#options = options;
    this.lifecycle = options.lifecycle;
  }

  /** The live worker, spawned on first use and again after it died. */
  connection(): WorkerConnection {
    if (this.#connection === undefined || this.#connection.dead) {
      this.#connection = new WorkerConnection(spawn(this.#options.worker), (event) => this.#event(event));
    }
    return this.#connection;
  }

  #event(event: KvEvent): void {
    if (event.event !== "peerCommit") return;
    for (const handle of this.#handles) {
      const remote = handle.remote;
      if (remote.connection !== this.#connection || remote.handle !== event.handle) continue;
      try {
        handle.spec.onPeerCommit?.(event.info);
      } catch {
        // onPeerCommit must not throw; if it does, the bridge stays up.
      }
    }
  }

  forget(handle: IndexedDbReplicaHandle): void {
    this.#handles.delete(handle);
  }

  /** `navigator.storage.persist()`, asked once per storage instance. */
  persisted(): Promise<boolean | null> {
    this.#persisted ??=
      typeof navigator !== "undefined" && typeof navigator.storage?.persist === "function"
        ? navigator.storage.persist().catch(() => null)
        : Promise.resolve(null);
    return this.#persisted;
  }

  #gateTx(): ReplicaGateTx<IDBTransaction> {
    const gateTx = this.#options.gateTx;
    if (gateTx === undefined) throw gated("gate_unavailable", "No lifecycle gate is wired into the replica storage.");
    return gateTx;
  }

  async open(spec: KVReplicaSpec): Promise<KVReplicaHandle> {
    assertFolderPrefix(spec.prefix);
    const identity = canonicalReplicationIdentity(spec.identity);
    const lifecycle = this.lifecycle;
    if (lifecycle === undefined) throw gated("gate_unavailable", "No lifecycle gate is wired into the replica storage.");
    const stamp = spec.stamp;
    if (stamp === undefined) throw gated("not_established", "The session has no replica stamp.");
    if (!lifecycle.deliverable(stamp)) throw gated("stamp_stale", "The replica session ended.");
    void this.persisted();
    const wire: KvOpenSpec = {
      identity,
      space: spec.space,
      prefix: spec.prefix,
      allowSecrets: spec.allowSecrets,
      stamp: { incarnation: stamp.incarnation, lifecycleEpoch: stamp.lifecycleEpoch },
      ...(spec.device === undefined ? {} : { device: { did: spec.device.did, jwk: spec.device.jwk } }),
      ...(spec.grantPolicy === undefined ? {} : { grantPolicy: structuredClone(spec.grantPolicy) }),
      ...(spec.quota === undefined ? {} : { quota: { ...spec.quota } }),
    };
    const connection = this.connection();
    const reply = await connection.call({ op: "open", spec: wire });
    if (!sameStamp(reply.stamp, stamp) || !lifecycle.deliverable(stamp)) {
      await connection.call({ op: "close", handle: reply.result.handle }).catch(() => undefined);
      throw gated("stamp_stale", "The replica session ended while the replica opened.");
    }
    const handle = new IndexedDbReplicaHandle(this, { lifecycle, stamp }, spec, wire, connection, reply.result);
    this.#handles.add(handle);
    return handle;
  }

  /**
   * The salted partition ids of `identity`/`prefix` for every known device
   * (the stored one, plus `extra`), from the current gate snapshot. Empty
   * when no gate exists yet: no partition can predate the gate.
   */
  async #partitions(
    db: IDBDatabase,
    snapshot: ReplicaGateSnapshot,
    identity: ReplicationIdentity,
    prefix: string,
    extra: readonly string[],
  ): Promise<string[]> {
    const stored = await storedDevice(db);
    const dids = [stored?.did, ...extra].filter((did): did is string => did !== undefined);
    const devices = [...new Map(dids.map((did) => [principalOf(did), did])).values()];
    return Promise.all(devices.map((deviceDid) => partitionIdOf({ identity, prefix, deviceDid }, snapshot.salt)));
  }

  async inspectStatus(spec: KVReplicaSpec, { signal }: { signal: AbortSignal }): Promise<LocalReplicaStatus | undefined> {
    signal.throwIfAborted();
    const identity = canonicalReplicationIdentity(spec.identity);
    const snapshot = await this.#gateTx().snapshot();
    if (snapshot === null) return undefined;
    const db = await openKvDatabase({ create: false });
    if (db === null) return undefined;
    try {
      signal.throwIfAborted();
      // Ungated by contract (no stamp): an injected device names its partition; otherwise the stored one.
      const device = spec.device ?? (await storedDevice(db));
      if (device === undefined) return undefined;
      const partitionId = await partitionIdOf({ identity, prefix: spec.prefix, deviceDid: device.did }, snapshot.salt);
      const store = await IndexedDbReplicaStore.openIn(db, { holder: "inspect", layout: kvLayout(partitionId), inspect: true });
      signal.throwIfAborted();
      const state = await store.open();
      if (state === null) return undefined;
      signal.throwIfAborted();
      const status = await store.status();
      const fence = await store.syncFence();
      signal.throwIfAborted();
      return {
        coverage: status.coverage,
        lastSyncAt: status.lastSyncAt,
        syncedThroughEpoch: fence.syncedThroughEpoch,
        authority: { state: status.authority.state, expiresAt: status.authority.expiresAt },
        grant: grantInfoOf(state, { space: spec.space, prefix: spec.prefix }),
        counts: status.counts,
        bytes: status.bytes,
        lastError: status.lastError,
        persisted: await this.persisted(),
        purgePending: this.lifecycle === undefined ? false : await purgePendingFor(this.lifecycle, partitionId, await identityKeyHashOf(identity, snapshot.salt)),
      };
    } finally {
      db.close();
    }
  }

  /**
   * Erase the identity's replica of `target.prefix` under the stored device
   * and the session device (deduplicated by principal), each in its own
   * exempt erase transaction that also unindexes the partition and releases
   * its quota. Never opens, mints or syncs, and never creates the database.
   * Handles opened earlier fail RESET_REQUIRED on their next call.
   */
  async purge(target: PurgeTarget): Promise<void> {
    const gateTx = this.#gateTx();
    const identity = canonicalReplicationIdentity(target.identity);
    const snapshot = await gateTx.snapshot();
    if (snapshot === null) return;
    let db: IDBDatabase | null;
    try {
      db = await openKvDatabase({ create: false });
    } catch (error) {
      throw idbError(error, "Opening the replica database");
    }
    if (db === null) return;
    try {
      const partitions = await this.#partitions(db, snapshot, identity, target.prefix, target.sessionDeviceDid === undefined ? [] : [target.sessionDeviceDid]);
      let firstError: unknown;
      for (const partitionId of partitions) {
        try {
          const tx = db.transaction([...ERASE_STORES, KV_STORE.partitions, KV_STORE.quota], "readwrite", { durability: "strict" });
          const done = transactionDone(tx);
          try {
            const { bytes } = await kvPartitionEraser.erasePartition(tx, partitionId);
            await gateTx.unindexPartition(tx, partitionId);
            await this.#options.ledger?.accountErase(tx, { partitionId, bytes });
            await done;
          } catch (error) {
            try {
              tx.abort();
            } catch {
              // already finished
            }
            await done.catch(() => undefined);
            throw error;
          }
        } catch (error) {
          // Every device is attempted; the first failure throws after the rest ran.
          firstError ??= idbError(error, "Purging the replica");
        }
      }
      if (firstError !== undefined) throw firstError;
    } finally {
      db.close();
    }
  }

  pendingWrites(identity: ReplicationIdentity, options: { stamp?: ReplicaSessionStamp } = {}): PendingWriteStore {
    return new IndexedDbPendingWriteStore(identity, {
      ...(this.#options.gateTx === undefined ? {} : { gateTx: this.#options.gateTx }),
      ...(options.stamp === undefined ? {} : { stamp: options.stamp }),
    });
  }

  [KILL_WORKER](): void {
    this.#connection?.kill(new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica worker was terminated."));
  }
}

/**
 * The IndexedDB `KVReplicaStorage`: one origin database
 * (`tinycloud-replica-kv`) and one dedicated worker per storage instance.
 * Pass it as `replication.storage`; the worker is spawned lazily on the
 * first `open`, so an app with replication off never starts it.
 */
export function indexedDbReplicaStorage(options: IndexedDbReplicaStorageOptions = {}): KVReplicaStorage {
  const gateTx = options.gateTx ?? createIndexedDbGateTx((create) => openKvDatabase({ create }));
  const lifecycle = options.lifecycle ?? createIndexedDbLifecycle({ ledger: options.ledger });
  return new IndexedDbReplicaStorage({ ...options, gateTx, lifecycle });
}
