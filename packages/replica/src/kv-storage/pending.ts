/**
 * The durable pending-write store of the browser read-through adapter (plan
 * §3 "Pending writes", CONTRACT.md §1): one `PendingWriteState` per identity
 * in the origin database's `pending` store, keyed by the salted identity-key
 * hash, bound to one session stamp for its whole life.
 *
 * Every `read`, `readExisting` and `update` runs through the lifecycle
 * gate's `run`, on the main thread (the `update` closure cannot cross into
 * the worker). Order, per the contract: `snapshot()`; derive the salted
 * identity-key hash outside any transaction; for `update`, take the Web Lock
 * `REPLICA_PENDING_LOCK_PREFIX + identityKeyHash`; then `run` with the
 * snapshot's incarnation — a gate that moved since the snapshot fails closed.
 * The read-modify-write is one `strict` readwrite transaction, durable
 * before `update` resolves. There is no memory fallback and no ungated mode.
 */
import {
  canonicalReplicationIdentity,
  replicationIdentityKey,
  type PendingWriteState,
  type PendingWriteStore,
  type ReplicaGateAccess,
  type ReplicaGateTx,
  type ReplicaSessionStamp,
  type ReplicationIdentity,
} from "@tinycloud/sdk-services/kv/replication";
import { REPLICA_PENDING_LOCK_PREFIX } from "@tinycloud/sdk-services/kv/replication/contractConstants";

import { ReplicaError, ReplicaErrorCode, gatedError } from "../errors.js";
import { requestAsPromise } from "../browser/idb.js";
import { KV_STORE, identityKeyHashOf } from "./schema.js";

type Locks = Pick<LockManager, "request">;

function corrupt(message: string): ReplicaError {
  return new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, message);
}

export class IndexedDbPendingWriteStore implements PendingWriteStore {
  readonly durable = true;
  readonly identity: ReplicationIdentity;
  readonly #identityKey: string;
  readonly #gateTx: ReplicaGateTx<IDBTransaction> | undefined;
  readonly #stamp: ReplicaSessionStamp | undefined;
  readonly #locks: Locks | undefined;

  constructor(identity: ReplicationIdentity, options: { gateTx?: ReplicaGateTx<IDBTransaction>; stamp?: ReplicaSessionStamp; locks?: Locks } = {}) {
    this.identity = canonicalReplicationIdentity(identity);
    this.#identityKey = replicationIdentityKey(this.identity);
    this.#gateTx = options.gateTx;
    this.#stamp = options.stamp;
    this.#locks = options.locks ?? (typeof navigator === "undefined" ? undefined : navigator.locks);
  }

  #empty(): PendingWriteState {
    return { v: 2, identity: this.identity, committedEpoch: 0, seq: 0, records: [] };
  }

  /** Validate a stored record: the v2 shape, and this store's identity (never another's). */
  #parse(value: unknown): PendingWriteState {
    if (
      value === null ||
      typeof value !== "object" ||
      !("v" in value) ||
      value.v !== 2 ||
      !("identity" in value) ||
      !("committedEpoch" in value) ||
      typeof value.committedEpoch !== "number" ||
      !("seq" in value) ||
      typeof value.seq !== "number" ||
      !("records" in value) ||
      !Array.isArray(value.records)
    ) {
      throw corrupt("The pending-write state is corrupt.");
    }
    let storedKey: string | undefined;
    try {
      storedKey = replicationIdentityKey(value.identity as ReplicationIdentity);
    } catch {
      storedKey = undefined;
    }
    if (storedKey !== this.#identityKey) throw corrupt("The pending-write state belongs to a different identity.");
    return value as PendingWriteState;
  }

  /**
   * Snapshot and derive the salted key outside any transaction; `undefined`
   * when no gate exists yet (no pending record can predate the gate).
   */
  async #access(): Promise<{ gateTx: ReplicaGateTx<IDBTransaction>; access: ReplicaGateAccess & { identityKeyHash: string } } | undefined> {
    const gateTx = this.#gateTx;
    if (gateTx === undefined) throw gatedError("gate_unavailable", "No lifecycle gate is wired into the pending-write store.");
    const stamp = this.#stamp;
    if (stamp === undefined) throw gatedError("not_established", "The pending-write store has no session stamp.");
    const snapshot = await gateTx.snapshot();
    if (snapshot === null) return undefined;
    const identityKeyHash = await identityKeyHashOf(this.identity, snapshot.salt);
    return { gateTx, access: { stamp, principal: this.identity.principal, incarnation: snapshot.incarnation, identityKeyHash } };
  }

  async #stored(): Promise<PendingWriteState | undefined> {
    const gated = await this.#access();
    if (gated === undefined) return undefined;
    const { gateTx, access } = gated;
    return gateTx.run({ stores: [KV_STORE.pending], mode: "readonly" }, access, async (tx) => {
      const value = await requestAsPromise<unknown>(tx.objectStore(KV_STORE.pending).get(access.identityKeyHash));
      return value === undefined ? undefined : this.#parse(value);
    });
  }

  async read(): Promise<PendingWriteState> {
    return (await this.#stored()) ?? this.#empty();
  }

  async readExisting(): Promise<PendingWriteState | undefined> {
    return this.#stored();
  }

  async update<T>(mutate: (state: PendingWriteState) => T): Promise<T> {
    const gated = await this.#access();
    if (gated === undefined) throw gatedError("not_established", "No replica gate exists on this origin yet.");
    const { gateTx, access } = gated;
    const section = () =>
      gateTx.run({ stores: [KV_STORE.pending], mode: "readwrite" }, access, async (tx) => {
        const value = await requestAsPromise<unknown>(tx.objectStore(KV_STORE.pending).get(access.identityKeyHash));
        const state = value === undefined ? this.#empty() : this.#parse(value);
        // `mutate` is synchronous by contract: the transaction stays open across it.
        const result = mutate(state);
        tx.objectStore(KV_STORE.pending).put(state, access.identityKeyHash);
        return result;
      });
    // `run` makes the read-modify-write atomic; the Web Lock serialises it across tabs first.
    if (this.#locks === undefined) return section();
    return this.#locks.request(`${REPLICA_PENDING_LOCK_PREFIX}${access.identityKeyHash}`, section) as Promise<T>;
  }
}
