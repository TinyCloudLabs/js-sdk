/**
 * The origin database of `@tinycloud/replica/kv-storage` (TC-858 Phase 2
 * plan §3): ONE IndexedDB database per origin, `tinycloud-replica-kv`, so
 * that a page commit, its quota accounting and its lifecycle-gate check, or
 * an erase and its purge-intent update, each run as a single transaction.
 *
 * Stores (names and keys frozen in the shared contract; every store keys
 * out-of-line):
 *   meta    — one state row per partition, key partitionId
 *   entries — key [pid, key]; index byHash on [pid, hash]
 *   blobs   — key [pid, hash]; index bySize on [pid, size]
 *   pending — one PendingWriteState per identity, key identityKeyHash
 *   device  — the owner-minted device key of this origin, key "device"
 *   gate, partitions, purgeIntents — lifecycle control stores (the gate owns their records)
 *   quota   — the origin-wide byte ledger (the ledger owns its records)
 *
 * The RC1 `openReplica` databases (`tinycloud-replica/<id>`) are separate
 * and untouched.
 */
import { replicationIdentityKey, type ReplicaPartitionEraser, type ReplicationIdentity } from "@tinycloud/sdk-services/kv/replication";
import { REPLICA_KV_DATABASE, REPLICA_KV_STORES } from "@tinycloud/sdk-services/kv/replication/contractConstants";

import { principalOf } from "../did.js";
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { eraseReplicaRows, type ReplicaStoreLayout } from "../browser/store.js";
import { saltedHash } from "../profile-gate/saltedHash.js";

export const KV_DATABASE = REPLICA_KV_DATABASE;
export const KV_DATABASE_VERSION = 1;
export const KV_STORE = REPLICA_KV_STORES;

/**
 * `device` store keys `firstInstall:<identityKeyHash>` → `{ at }` (ms): the
 * `first_install` consent anchor of an identity whose session has neither
 * SIWE nor delegation `iat`/`nbf`. Written set-if-absent by the install
 * transaction; survives partition reset, purge and reinstall; only the
 * lifecycle gate's `deny` deletes the range.
 */
export const FIRST_INSTALL_KEY_PREFIX = "firstInstall:";

/** The scope a partition erase (and the identity-scoped pending erase) needs. */
export const ERASE_STORES: readonly string[] = [KV_STORE.meta, KV_STORE.entries, KV_STORE.blobs, KV_STORE.pending];

const READ_SCOPE: readonly string[] = [KV_STORE.gate, KV_STORE.purgeIntents];
const WRITE_SCOPE: readonly string[] = [KV_STORE.gate, KV_STORE.partitions, KV_STORE.purgeIntents, KV_STORE.quota, KV_STORE.device];

function createStores(db: IDBDatabase): void {
  db.createObjectStore(KV_STORE.meta);
  const entries = db.createObjectStore(KV_STORE.entries);
  entries.createIndex("byHash", ["pid", "hash"], { unique: false });
  const blobs = db.createObjectStore(KV_STORE.blobs);
  blobs.createIndex("bySize", ["pid", "size"], { unique: false });
  for (const name of [KV_STORE.pending, KV_STORE.device, KV_STORE.gate, KV_STORE.partitions, KV_STORE.purgeIntents, KV_STORE.quota]) {
    db.createObjectStore(name);
  }
}

/**
 * The salted identity-key hash (`pending` key, `firstInstall:` suffix,
 * pending Web Lock suffix): `saltedHash(salt, replicationIdentityKey(identity))`.
 * Derive it from a gate `snapshot()` before opening any transaction.
 */
export function identityKeyHashOf(identity: ReplicationIdentity, salt: string): Promise<string> {
  return saltedHash(salt, replicationIdentityKey(identity));
}

/**
 * Open the origin database. With `create: false` a missing database stays
 * missing — the upgrade that would create it is aborted — and the result
 * is null; inspection and purge use this so they never create storage.
 * Every connection closes itself on `versionchange`, so a
 * `deleteDatabase` from any tab is never blocked by an idle connection.
 */
export function openKvDatabase(options: { create: boolean }): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new ReplicaError(
        ReplicaErrorCode.RUNTIME_UNSUPPORTED,
        "IndexedDB is unavailable (private browsing or a non-browser runtime); the replica cannot persist.",
      ),
    );
  }
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase | null>();
  const request = indexedDB.open(KV_DATABASE, KV_DATABASE_VERSION);
  let refused = false;
  request.onupgradeneeded = (event) => {
    if (!options.create && event.oldVersion === 0) {
      refused = true;
      request.transaction?.abort();
      return;
    }
    createStores(request.result);
  };
  request.onsuccess = () => {
    const db = request.result;
    db.onversionchange = () => db.close();
    resolve(db);
  };
  request.onerror = (event) => {
    if (refused) {
      // The aborted upgrade rolls the creation back; this is "missing", not a failure.
      event.preventDefault();
      resolve(null);
      return;
    }
    reject(request.error ?? new DOMException(`Opening ${KV_DATABASE} failed`, "UnknownError"));
  };
  request.onblocked = () =>
    reject(new ReplicaError(ReplicaErrorCode.BUSY, `Opening ${KV_DATABASE} is blocked by an older connection in another tab.`));
  return promise;
}

/**
 * The partition id (CONTRACT.md §1): `saltedHash(salt,
 * replicationIdentityKey(identity) + "\n" + prefix + "\n" + device)`, where
 * the device is taken as its principal (any `#fragment` dropped) so both
 * spellings of one device key name one partition. It is also the opaque
 * `replicaId` events carry. Derive it from a gate `snapshot()` before
 * opening any transaction; an unsalted id is never stored.
 */
export function partitionIdOf(input: { identity: ReplicationIdentity; prefix: string; deviceDid: string }, salt: string): Promise<string> {
  return saltedHash(salt, `${replicationIdentityKey(input.identity)}\n${input.prefix}\n${principalOf(input.deviceDid)}`);
}

/** The partition-scoped key layout `IndexedDbReplicaStore` runs over. */
export function kvLayout(partitionId: string): ReplicaStoreLayout {
  return {
    partitionId,
    readScope: READ_SCOPE,
    writeScope: WRITE_SCOPE,
    metaKey: partitionId,
    outOfLineKeys: true,
    entryKey: (key) => [partitionId, key],
    blobKey: (hash) => [partitionId, hash],
    blobHashOf: (key) => (Array.isArray(key) && key[0] === partitionId && typeof key[1] === "string" ? key[1] : undefined),
    // Arrays sort after every string and number, so [pid, []] bounds every [pid, <string|number>].
    range: IDBKeyRange.bound([partitionId], [partitionId, []]),
    tag: { pid: partitionId },
    blobSizeIndex: "bySize",
  };
}

/**
 * The erase seam the lifecycle gate drives (`ReplicaPartitionEraser`). Both
 * run inside the caller's transaction (scope {@link ERASE_STORES} plus the
 * gate's and ledger's stores), which also clears the intent and releases quota.
 *
 * `erasePartition`: entries and blobs are deleted and the state row —
 * config, grant, authority, cursor — becomes a contentless tombstone that
 * fences every handle opened before it. Returns the blob bytes released.
 */
export const kvPartitionEraser: ReplicaPartitionEraser<IDBTransaction> = {
  async erasePartition(tx, partitionId) {
    return { bytes: (await eraseReplicaRows(tx, kvLayout(partitionId))).blobBytes };
  },
  async eraseIdentityPending(tx, identityKeyHash) {
    tx.objectStore(KV_STORE.pending).delete(identityKeyHash);
  },
};
