/**
 * `indexedDbReplicaStorage()`: the browser `ReplicaGatedStorage` (TC-858 Phase 2
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
  KVReplicaSpec,
  LocalGetResult,
  LocalListResult,
  LocalReplicaStatus,
  LocalSyncResult,
  PendingWriteStore,
  PurgeTarget,
  ReplicaDenyOutcome,
  ReplicaBrowserGateSnapshot,
  ReplicaGatedHandle,
  ReplicaGatedSpec,
  ReplicaGatedStorage,
  ReplicaGrantInfo,
  ReplicaLifecycleGate,
  ReplicaQuotaLedger,
  ReplicaInspectedStatus,
  ReplicaPartitionIndexEntry,
  ReplicaSessionStamp,
  ReplicationIdentity,
} from "@tinycloud/sdk-services/kv/replication";
import { canonicalReplicationIdentity, replicationIdentityKey } from "@tinycloud/sdk-services/kv/replication";

import { ReplicaError, ReplicaErrorCode, gatedError as gated } from "../errors.js";
import { assertFolderPrefix } from "../scope.js";
import { idbError, requestAsPromise, transactionDone } from "../browser/idb.js";
import { gateHash, GATE_HMAC_KEY, type BrowserGate, type GateHmacRecord, validGateHmac } from "./gateKeys.js";
import { ledgerFor } from "./ledger.js";
import { createIndexedDbGateTx, type BrowserReplicaGateTx } from "./gateTx.js";
import { createIndexedDbLifecycle } from "./lifecycle.js";
import { IndexedDbPendingWriteStore } from "./pending.js";
import type { KvConsentExpiryAck, KvEvent, KvOpenSpec, KvReply, KvRequest, KvResults, KvWireError } from "./protocol.js";
import type { SealedMeta } from "./secureStore.js";
import { ERASE_STORES, KV_STORE, kvPartitionEraser, openKvDatabase, partitionIdOf } from "./schema.js";

export type IndexedDbReplicaStorageOptions = {
  /**
   * Spawn this worker instead of the content-hashed default
   * (custom bundler layouts). A factory runs on first `open`.
   */
  worker?: Worker | URL | string | (() => Worker);
  /** The lifecycle gate (`storage.lifecycle`): consulted before every open, sync and delivery. */
  lifecycle?: ReplicaLifecycleGate;
  /**
   * The main-thread transaction guard (`createIndexedDbGateTx`): the pending
   * store runs every read and update through it, and `purge`/`inspectStatus`
   * derive private gate-HMAC ids from its `snapshot()`.
   */
  gateTx?: BrowserReplicaGateTx;
  /** Releases quota for partitions `purge()` erases, in the erase transaction. */
  ledger?: Pick<ReplicaQuotaLedger<IDBTransaction>, "accountErase">;
};

function replyError(err: KvWireError): ReplicaError {
  const error = new ReplicaError(err.code as ReplicaErrorCode, err.message, err.detail);
  // Contract shape for gate refusals: `Error & { code: "REPLICA_GATED"; gate }`.
  if (err.code === ReplicaErrorCode.GATED && typeof err.detail?.gate === "string")
    (error as ReplicaError & { gate: string }).gate = err.detail.gate;
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
  // The package build replaces this literal with the worker's SHA-256 filename;
  // leave the new URL shape intact for bundlers' static asset resolution.
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

  /** Fire-and-forget control message: cancel or the durable expiry result. */
  notify(request: KvRequest | KvConsentExpiryAck): void {
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

class IndexedDbReplicaHandle implements ReplicaGatedHandle {
  readonly spec: ReplicaGatedSpec;
  readonly deviceDid: string;
  readonly replicaId: string;
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
    spec: ReplicaGatedSpec,
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
    this.replicaId = opened.partitionId;
  }

  acceptsPeerCommit(connection: WorkerConnection | undefined, handle: number): boolean {
    return !this.#closed && this.#connection === connection && this.#remote === handle && this.#lifecycle.deliverable(this.#stamp);
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
      const reply = await connection.call({ op: "open", spec: this.#wire });
      if (this.#closed) {
        await connection.call({ op: "close", handle: reply.result.handle }).catch(() => undefined);
        throw new ReplicaError(ReplicaErrorCode.CLOSED, "The replica handle is closed.");
      }
      const opened = this.#deliver(reply);
      this.#connection = connection;
      this.#remote = opened.handle;
    }
    return { connection: this.#connection, handle: this.#remote };
  }

  /** Delivery check (CONTRACT §2): drop a reply that ran under another (or no) stamp, or that the gate no longer honours. */
  #deliver<T>(reply: Reply<T>): T {
    if (this.#closed) throw new ReplicaError(ReplicaErrorCode.CLOSED, "The replica handle is closed.");
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

  sync(options: { signal: AbortSignal; syncStartEpoch: number }): Promise<LocalSyncResult> {
    // Track the entire operation, including a worker restart before the RPC is sent.
    const running = this.#sync(options);
    const settled = running.then(() => undefined, () => undefined);
    this.#syncs.add(settled);
    void settled.then(() => this.#syncs.delete(settled));
    return running;
  }

  async #sync(options: { signal: AbortSignal; syncStartEpoch: number }): Promise<LocalSyncResult> {
    options.signal.throwIfAborted();
    const { connection, handle } = await this.#live();
    if (this.#closed) throw new ReplicaError(ReplicaErrorCode.CLOSED, "The replica handle is closed.");
    let requestId: number | undefined;
    const cancel = (): void => {
      if (requestId !== undefined) connection.notify({ op: "cancel", target: requestId });
    };
    options.signal.addEventListener("abort", cancel, { once: true });
    try {
      const running = connection.call({ op: "sync", handle, syncStartEpoch: options.syncStartEpoch }, (id) => {
        requestId = id;
        if (options.signal.aborted) cancel();
      });
      return this.#deliver(await running);
    } finally {
      options.signal.removeEventListener("abort", cancel);
    }
  }

  async status(): Promise<LocalReplicaStatus> {
    const { connection, handle } = await this.#live();
    const status = this.#deliver(await connection.call({ op: "status", handle }));
    return { ...status, persisted: await this.#storage.persisted(), purgePending: await purgePendingFor(this.#lifecycle, this.replicaId, null) };
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


class IndexedDbReplicaStorage implements ReplicaGatedStorage {
  readonly kind = "indexeddb" as const;
  readonly lifecycle: ReplicaLifecycleGate;
  readonly #options: IndexedDbReplicaStorageOptions;
  readonly #handles = new Set<IndexedDbReplicaHandle>();
  #connection: WorkerConnection | undefined;
  #persisted: Promise<boolean | null> | undefined;
  #recovery: Promise<void> | undefined;

  constructor(options: IndexedDbReplicaStorageOptions & { lifecycle: ReplicaLifecycleGate }) {
    this.#options = { ...options, ledger: options.ledger ?? ledgerFor() };
    this.lifecycle = options.lifecycle;
  }

  /** A nonspawning probe lets the published testing helper terminate only an existing worker. */
  connection(): WorkerConnection;
  connection(peek: true): WorkerConnection | undefined;
  connection(peek?: true): WorkerConnection | undefined {
    if (peek) return this.#connection;
    if (this.#connection === undefined || this.#connection.dead) {
      const connection = new WorkerConnection(spawn(this.#options.worker), (event) => this.#event(event, connection));
      this.#connection = connection;
    }
    return this.#connection;
  }

  #event(event: KvEvent, connection: WorkerConnection): void {
    if (event.event === "consentExpiry") {
      const lifecycle = this.lifecycle as (ReplicaLifecycleGate & { expireConsent?: () => Promise<ReplicaDenyOutcome> }) | undefined;
      void Promise.resolve().then(() => {
        if (typeof lifecycle?.expireConsent !== "function") throw gated("gate_unavailable", "The lifecycle cannot expire account consent.");
        return lifecycle.expireConsent();
      }).then(
        (outcome) => connection.notify({ op: "consentExpiryAck", requestId: event.requestId, ok: true, outcome }),
        () => connection.notify({ op: "consentExpiryAck", requestId: event.requestId, ok: false, message: "Consent expiry failed." }),
      );
      return;
    }
    if (event.event !== "peerCommit") return;
    for (const handle of this.#handles) {
      if (!handle.acceptsPeerCommit(connection, event.handle)) continue;
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

  #gateTx(): BrowserReplicaGateTx {
    const gateTx = this.#options.gateTx;
    if (gateTx === undefined) throw gated("gate_unavailable", "No lifecycle gate is wired into the replica storage.");
    return gateTx;
  }

  async #recoverBeforeOpen(lifecycle: ReplicaLifecycleGate): Promise<void> {
    this.#recovery ??= (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      const timedOut = new Promise<never>((_resolve, reject) =>
        controller.signal.addEventListener("abort", () =>
          reject(gated("gate_unavailable", "Replica startup recovery timed out; local reads remain unavailable.")), { once: true }));
      try {
        const report = await Promise.race([lifecycle.recover({ signal: controller.signal }), timedOut]);
        if (report.failed.length > 0 || report.remaining > 0) {
          throw gated("purge_pending", "Replica startup recovery did not finish; local reads remain unavailable.");
        }
      } finally {
        clearTimeout(timer);
      }
    })().catch((error: unknown) => {
      this.#recovery = undefined;
      throw error;
    });
    return this.#recovery;
  }

  async open(spec: ReplicaGatedSpec): Promise<ReplicaGatedHandle> {
    assertFolderPrefix(spec.prefix);
    const identity = canonicalReplicationIdentity(spec.identity);
    const lifecycle = this.lifecycle;
    const stamp = spec.stamp;
    if (stamp === undefined) throw gated("not_established", "The session has no replica stamp.");
    await this.#recoverBeforeOpen(lifecycle);
    if (!lifecycle.deliverable(stamp)) throw gated("stamp_stale", "The replica session ended.");
    void this.persisted();
    const wire: KvOpenSpec = {
      identity,
      space: spec.space,
      prefix: spec.prefix,
      allowSecrets: spec.allowSecrets,
      stamp: { incarnation: stamp.incarnation, lifecycleEpoch: stamp.lifecycleEpoch },
      ...(spec.device === undefined ? {} : { device: { did: spec.device.did, jwk: spec.device.jwk } }),
      grantPolicy: structuredClone(spec.grantPolicy),
      ...(spec.quota === undefined ? {} : { quota: { ...spec.quota } }),
      ...(spec.contentFetch === undefined ? {} : { contentFetch: spec.contentFetch }),
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

  /** The private lookup index names the stored owner partition without decrypting its device. */
  async #partitions(
    db: IDBDatabase,
    snapshot: ReplicaBrowserGateSnapshot,
    identity: ReplicationIdentity,
    prefix: string,
    sessionDeviceDid: string | undefined,
  ): Promise<string[]> {
    const lookupId = await gateHash(snapshot.gateHmac, "lookup", `${replicationIdentityKey(identity)}\n${prefix}`);
    const indexed = await requestAsPromise<ReplicaPartitionIndexEntry[]>(
      db.transaction(KV_STORE.partitions).objectStore(KV_STORE.partitions).index("byLookupId").getAll(lookupId));
    const owners = indexed.filter((item) => item.lookupId === lookupId && item.ownerDevice === true);
    if (owners.length > 1) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica has multiple owner partitions.");
    const sessionId = sessionDeviceDid === undefined ? undefined :
      await partitionIdOf({ identity, prefix, deviceDid: sessionDeviceDid }, snapshot.gateHmac);
    return [...new Set([owners[0]?.partitionId, sessionId].filter((id): id is string => id !== undefined))];
  }

  async inspectStatus(spec: KVReplicaSpec, { signal }: { signal: AbortSignal }): Promise<ReplicaInspectedStatus | undefined> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Replica status inspection timed out.", "TimeoutError")), 3_000);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    try {
      if (signal.aborted) onAbort();
      return await Promise.race([this.#inspectRedacted(spec, controller.signal), aborted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #inspectRedacted(spec: KVReplicaSpec, signal: AbortSignal): Promise<ReplicaInspectedStatus | undefined> {
    signal.throwIfAborted();
    const identity = canonicalReplicationIdentity(spec.identity);
    const snapshot = await this.#gateTx().snapshot();
    if (snapshot === null) return undefined;
    const identityKey = replicationIdentityKey(identity);
    const lookupId = await gateHash(snapshot.gateHmac, "lookup", `${identityKey}\n${spec.prefix}`);
    const principalHash = await gateHash(snapshot.gateHmac, "principal", identity.principal.toLowerCase());
    const identityKeyHash = await gateHash(snapshot.gateHmac, "identity", identityKey);
    const injectedId = spec.device === undefined ? undefined :
      await partitionIdOf({ identity, prefix: spec.prefix, deviceDid: spec.device.did }, snapshot.gateHmac);
    signal.throwIfAborted();
    const db = await openKvDatabase({ create: false });
    if (db === null) return undefined;
    try {
      const tx = db.transaction([KV_STORE.gate, KV_STORE.device, KV_STORE.partitions, KV_STORE.meta, KV_STORE.purgeIntents], "readonly");
      const gate = await requestAsPromise<BrowserGate | undefined>(tx.objectStore(KV_STORE.gate).get("account"));
      if (gate === undefined || gate.incarnation !== snapshot.incarnation || gate.lifecycleEpoch !== snapshot.lifecycleEpoch ||
          gate.keyId !== snapshot.keyId || gate.accountKeyId !== snapshot.accountKeyId || gate.principalHash !== principalHash) return undefined;
      const hmac = await requestAsPromise<GateHmacRecord | undefined>(tx.objectStore(KV_STORE.device).get(GATE_HMAC_KEY));
      if (!validGateHmac(hmac, gate)) return undefined;
      signal.throwIfAborted();
      let partitionId = injectedId;
      if (partitionId === undefined) {
        const matches = await requestAsPromise<ReplicaPartitionIndexEntry[]>(
          tx.objectStore(KV_STORE.partitions).index("byLookupId").getAll(lookupId, 64));
        const owners = matches.filter((item) => item.ownerDevice === true && item.lookupId === lookupId);
        if (owners.length > 1) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica has multiple owner partitions.");
        if (matches.length === 64) {
          throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The bounded replica owner lookup is inconclusive.");
        }
        partitionId = owners[0]?.partitionId;
      }
      if (partitionId === undefined) return undefined;
      const row = await requestAsPromise<SealedMeta | undefined>(tx.objectStore(KV_STORE.meta).get(partitionId));
      if (row === undefined || row.purged) return undefined;
      if (row.pid !== partitionId || ![0, 1, 2].includes(row.coverageCode) ||
          ![row.syncedThroughEpoch, row.keys, row.contentMissing, row.tombstones, row.contentBytes]
            .every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The redacted replica status controls are invalid.");
      }
      const intents = tx.objectStore(KV_STORE.purgeIntents);
      const [partitionIntent, identityIntent] = await Promise.all([
        requestAsPromise<number>(intents.count(partitionId)),
        requestAsPromise<number>(intents.count(`pending:${identityKeyHash}`)),
      ]);
      signal.throwIfAborted();
      const persisted = typeof navigator.storage?.persisted === "function"
        ? await navigator.storage.persisted().catch(() => null)
        : null;
      signal.throwIfAborted();
      return {
        redacted: true, coverage: row.coverageCode === 0 ? "empty" : row.coverageCode === 1 ? "bootstrapping" : "complete",
        syncedThroughEpoch: row.syncedThroughEpoch,
        counts: { keys: row.keys, contentMissing: row.contentMissing, tombstones: row.tombstones },
        bytes: row.contentBytes, persisted, purgePending: partitionIntent > 0 || identityIntent > 0,
      };
    } finally {
      db.close();
    }
  }

  #assertPurgeGate(gate: BrowserGate | undefined, snapshot: ReplicaBrowserGateSnapshot, principalHash: string): void {
    if (gate === undefined || gate.principalHash === null || gate.incarnation !== snapshot.incarnation ||
        gate.lifecycleEpoch !== snapshot.lifecycleEpoch || gate.keyId !== snapshot.keyId ||
        gate.accountKeyId !== snapshot.accountKeyId) {
      throw gated("stamp_stale", "The replica gate moved before purge.");
    }
    if (gate.principalHash !== principalHash) throw gated("principal_mismatch", "Purge belongs to another account.");
  }

  /**
   * Erase the identity's replica of `target.prefix` under the stored device
   * and the session device (deduplicated by principal), each in its own
   * exempt erase transaction that also unindexes the partition and releases
   * its quota. Never opens, mints or syncs, and never creates the database.
   * Handles opened earlier fail RESET_REQUIRED on their next call. With no
   * gate on the origin it rejects REPLICA_GATED `not_established` rather than
   * reporting an erase it could not address.
   */
  async purge(target: PurgeTarget): Promise<void> {
    const gateTx = this.#gateTx();
    const identity = canonicalReplicationIdentity(target.identity);
    const snapshot = await gateTx.snapshot();
    if (snapshot === null) throw gated("not_established", "No replica gate exists on this origin; there is nothing purge can address.");
    const principalHash = await gateHash(snapshot.gateHmac, "principal", identity.principal.toLowerCase());
    let db: IDBDatabase | null;
    try {
      db = await openKvDatabase({ create: false });
    } catch (error) {
      throw idbError(error, "Opening the replica database");
    }
    if (db === null) throw gated("gate_unavailable", "The replica database disappeared before purge.");
    try {
      this.#assertPurgeGate(await requestAsPromise<BrowserGate | undefined>(
        db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account")), snapshot, principalHash);
      const partitions = await this.#partitions(db, snapshot, identity, target.prefix, target.sessionDeviceDid);
      let firstError: unknown;
      for (const partitionId of partitions) {
        try {
          const tx = db.transaction([...ERASE_STORES, KV_STORE.gate, KV_STORE.partitions, KV_STORE.quota], "readwrite", { durability: "strict" });
          const done = transactionDone(tx);
          try {
            this.#assertPurgeGate(await requestAsPromise<BrowserGate | undefined>(
              tx.objectStore(KV_STORE.gate).get("account")), snapshot, principalHash);
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
}

/**
 * The IndexedDB `ReplicaGatedStorage`: one origin database
 * (`tinycloud-replica-kv`) and one dedicated worker per storage instance.
 * Pass it as `replication.storage`; the worker is spawned lazily on the
 * first `open`, so an app with replication off never starts it.
 */
export function indexedDbReplicaStorage(options: IndexedDbReplicaStorageOptions = {}): ReplicaGatedStorage {
  const ledger = options.ledger ?? ledgerFor();
  const lifecycle = options.lifecycle ?? createIndexedDbLifecycle({ ledger });
  const gateTx = options.gateTx ?? createIndexedDbGateTx((create) => openKvDatabase({ create }), {
    onConsentExpired: () => {
      if (!("expireConsent" in lifecycle) || typeof lifecycle.expireConsent !== "function") {
        throw gated("gate_unavailable", "The lifecycle cannot expire account consent.");
      }
      return lifecycle.expireConsent();
    },
  });
  return new IndexedDbReplicaStorage({ ...options, ledger, gateTx, lifecycle });
}
