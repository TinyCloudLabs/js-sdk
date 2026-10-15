/**
 * The durable pending-write store of the browser read-through adapter (plan
 * §3 "Pending writes"): one `PendingWriteState` per canonical identity in the
 * origin database's `pending` store, keyed by the identity-key hash.
 *
 * `update` is a read-modify-write in ONE readwrite transaction, run while
 * holding the identity's Web Lock (`tinycloud-replica-kv:pending:<hash>`), so
 * two tabs updating one identity serialise and neither loses a record. The
 * state is durable before `update` resolves (`strict` durability). Without
 * it, a reload while offline could never serve local reads
 * (`REPLICA_UNPROVEN_SINCE_START`). There is no memory fallback: an open
 * failure surfaces as `STORAGE_ERROR`.
 */
import {
  canonicalReplicationIdentity,
  replicationIdentityKey,
  type PendingWriteState,
  type PendingWriteStore,
  type ReplicationIdentity,
} from "@tinycloud/sdk-services/kv/replication";
import { REPLICA_PENDING_LOCK_PREFIX } from "@tinycloud/sdk-services/kv/replication/contractConstants";

import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { idbError, requestAsPromise, transactionDone } from "../browser/idb.js";
import { KV_STORE, identityKeyHash, openKvDatabase } from "./schema.js";

type Locks = Pick<LockManager, "request">;

function corrupt(message: string): ReplicaError {
  return new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, message);
}

export class IndexedDbPendingWriteStore implements PendingWriteStore {
  readonly durable = true;
  readonly identity: ReplicationIdentity;
  readonly #identityKey: string;
  readonly #key: string;
  readonly #locks: Locks | undefined;

  constructor(identity: ReplicationIdentity, options: { locks?: Locks } = {}) {
    this.identity = canonicalReplicationIdentity(identity);
    this.#identityKey = replicationIdentityKey(this.identity);
    this.#key = identityKeyHash(this.#identityKey);
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

  /** The stored state, read in its own transaction; undefined when absent (or `create: false` and no database). */
  async #stored(create: boolean): Promise<PendingWriteState | undefined> {
    let db: IDBDatabase | null;
    try {
      db = await openKvDatabase({ create });
    } catch (error) {
      throw idbError(error, "Opening the pending-write store");
    }
    if (db === null) return undefined;
    try {
      const value = await requestAsPromise<unknown>(db.transaction(KV_STORE.pending).objectStore(KV_STORE.pending).get(this.#key));
      return value === undefined ? undefined : this.#parse(value);
    } catch (error) {
      throw idbError(error, "Reading the pending-write state");
    } finally {
      db.close();
    }
  }

  async read(): Promise<PendingWriteState> {
    return (await this.#stored(true)) ?? this.#empty();
  }

  async readExisting(): Promise<PendingWriteState | undefined> {
    return this.#stored(false);
  }

  async update<T>(mutate: (state: PendingWriteState) => T): Promise<T> {
    const section = async (): Promise<T> => {
      let db: IDBDatabase | null;
      try {
        db = await openKvDatabase({ create: true });
      } catch (error) {
        throw idbError(error, "Opening the pending-write store");
      }
      if (db === null) throw corrupt("The pending-write store could not be created.");
      let tx: IDBTransaction;
      try {
        tx = db.transaction(KV_STORE.pending, "readwrite", { durability: "strict" });
      } catch (error) {
        db.close();
        throw idbError(error, "Updating the pending-write state");
      }
      const done = transactionDone(tx);
      try {
        const value = await requestAsPromise<unknown>(tx.objectStore(KV_STORE.pending).get(this.#key));
        const state = value === undefined ? this.#empty() : this.#parse(value);
        // `mutate` is synchronous by contract: the transaction stays open across it.
        const result = mutate(state);
        tx.objectStore(KV_STORE.pending).put(state, this.#key);
        await done;
        return result;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // already finished
        }
        await done.catch(() => undefined);
        // A mutation's own error reaches the caller unchanged; storage failures map to replica codes.
        throw error instanceof DOMException ? idbError(error, "Updating the pending-write state") : error;
      } finally {
        db.close();
      }
    };
    // The transaction alone is atomic; the Web Lock serialises the read-modify-write
    // across tabs before it starts, as the plan requires.
    if (this.#locks === undefined) return section();
    return this.#locks.request(`${REPLICA_PENDING_LOCK_PREFIX}${this.#key}`, section) as Promise<T>;
  }
}
