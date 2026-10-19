/**
 * The origin database of `@tinycloud/replica/kv-storage` (TC-858 Phase 2
 * plan §3): ONE IndexedDB database per origin, `tinycloud-replica-kv`, so
 * that a page commit, its quota accounting and its lifecycle-gate check, or
 * an erase and its purge-intent update, each run as a single transaction.
 *
 * Stores (names and keys frozen in the shared contract; every store keys
 * out-of-line):
 *   meta    — one sealed state row per partition, key partitionId
 *   entries — key [pid, opaque key HMAC]; index byHash on [pid, opaque hash HMAC]
 *   blobs   — key [pid, opaque hash HMAC]; index bySize on [pid, ciphertext row size]
 *   pending — one sealed PendingWriteState per identity, key private identity HMAC
 *   device  — sealed owner device and grant install timestamps; gate crypto keys
 *   gate, partitions, purgeIntents — lifecycle control stores; partition lookup index byLookupId
 *   quota   — origin-wide measured ciphertext byte ledger
 *
 * The RC1 `openReplica` databases (`tinycloud-replica/<id>`) are separate
 * and untouched.
 */
import { replicationIdentityKey, type ReplicaPartitionEraser, type ReplicationIdentity } from "@tinycloud/sdk-services/kv/replication";
import { REPLICA_KV_DATABASE, REPLICA_KV_STORES } from "@tinycloud/sdk-services/kv/replication/contractConstants";

import { principalOf } from "../did.js";
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { requestAsPromise } from "../browser/idb.js";
import type { ReplicaStoreLayout } from "../browser/store.js";
import { gateHash } from "./gateKeys.js";
import { measureSealedRow } from "./sealed.js";

export const KV_DATABASE = REPLICA_KV_DATABASE;
export const KV_DATABASE_VERSION = 2;
export const KV_STORE = REPLICA_KV_STORES;

/**
 * `device` store keys `firstInstall:<identityKeyHash>` → `{ at }` (ms): the
 * `first_install` consent anchor of an identity whose session has neither
 * SIWE nor delegation `iat`/`nbf`. Written set-if-absent by the install
 * transaction; survives partition reset, purge and reinstall; only the
 * lifecycle gate's `deny` deletes the range.
 */
export const FIRST_INSTALL_KEY_PREFIX = "firstInstall:";
/** CID install timestamps live outside partitions, so purge/reinstall cannot refresh a CID. */
export const GRANT_INSTALL_KEY_PREFIX = "grantInstall:";


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
  const partitions = db.createObjectStore(KV_STORE.partitions);
  partitions.createIndex("byLookupId", "lookupId", { unique: false });
  for (const name of [KV_STORE.pending, KV_STORE.device, KV_STORE.gate, KV_STORE.purgeIntents, KV_STORE.quota]) {
    db.createObjectStore(name);
  }
}

/**
 * Private gate-HMAC identity id (`pending` key, `firstInstall:` suffix and
 * pending Web Lock suffix). Never derive account identifiers from the public
 * gate salt; precompute them before opening a transaction.
 */
export function identityKeyHashOf(identity: ReplicationIdentity, gateHmac: CryptoKey): Promise<string> {
  return gateHash(gateHmac, "identity", replicationIdentityKey(identity));
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
  const request = options.create ? indexedDB.open(KV_DATABASE, KV_DATABASE_VERSION) : indexedDB.open(KV_DATABASE);
  let refused = false;
  request.onupgradeneeded = (event) => {
    if (!options.create && event.oldVersion === 0) {
      refused = true;
      request.transaction?.abort();
      return;
    }
    if (event.oldVersion > 0) {
      // v1 stored plaintext values and recognizable IndexedDB keys. No data or
      // account gate from that format can be retained in the ciphertext layout.
      for (const name of Array.from(request.result.objectStoreNames)) request.result.deleteObjectStore(name);
    }
    createStores(request.result);
  };
  request.onsuccess = () => {
    const db = request.result;
    if (db.version !== KV_DATABASE_VERSION) {
      db.close();
      resolve(null);
      return;
    }
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
 * Partition id (and opaque `replicaId`): gate-HMAC over the canonical
 * identity, folder prefix and device principal. Dropping the DID fragment
 * makes two names of one key share a partition. Derive before any transaction.
 */
export function partitionIdOf(input: { identity: ReplicationIdentity; prefix: string; deviceDid: string }, gateHmac: CryptoKey): Promise<string> {
  return gateHash(gateHmac, "partition", `${replicationIdentityKey(input.identity)}\n${input.prefix}\n${principalOf(input.deviceDid)}`);
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

/** Delete ciphertext rows by opaque partition range without needing the account's shredded key. */
function eraseSealedRows(tx: IDBTransaction, name: string, partitionId: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const range = IDBKeyRange.bound([partitionId], [partitionId, []]);
  const request = tx.objectStore(name).openCursor(range);
  let removed = 0;
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor === null) return resolve(removed);
    try {
      const row: unknown = cursor.value;
      if (row === null || typeof row !== "object" || !("pid" in row) || row.pid !== partitionId ||
          !("size" in row) || typeof row.size !== "number") {
        throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The encrypted replica row has an invalid partition or byte measure.");
      }
      const measured = measureSealedRow(cursor.primaryKey, row as Parameters<typeof measureSealedRow>[1]);
      if (row.size !== measured || !Number.isSafeInteger(removed + measured)) {
        throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The encrypted replica row has an invalid byte measure.");
      }
      removed += measured;
      cursor.delete();
      cursor.continue();
    } catch (error) {
      reject(error);
    }
  };
  request.onerror = () => reject(request.error);
  return promise;
}

/**
 * The lifecycle erase seam. Entries/blobs are deleted and encrypted metadata
 * becomes a contentless generation tombstone: stale handles reject RESET_REQUIRED
 * without requiring an account key after deny. `bytes` is the exact net measured
 * row release, including metadata replacement, for idempotent quota accounting.
 */
export const kvPartitionEraser: ReplicaPartitionEraser<IDBTransaction> = {
  async erasePartition(tx, partitionId) {
    const meta = tx.objectStore(KV_STORE.meta);
    const old: unknown = await requestAsPromise(meta.get(partitionId));
    if (old !== undefined && (old === null || typeof old !== "object" ||
        !("pid" in old) || old.pid !== partitionId ||
        !("revision" in old) || typeof old.revision !== "number" || !Number.isSafeInteger(old.revision) || old.revision < 0 ||
        !("generation" in old) || typeof old.generation !== "number" || !Number.isSafeInteger(old.generation) || old.generation < 0 ||
        !("size" in old) || typeof old.size !== "number" || old.size !== measureSealedRow(partitionId, old as Parameters<typeof measureSealedRow>[1]))) {
      throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The encrypted replica metadata is invalid.");
    }
    const [entries, blobs] = await Promise.all([
      eraseSealedRows(tx, KV_STORE.entries, partitionId),
      eraseSealedRows(tx, KV_STORE.blobs, partitionId),
    ]);
    if (old === undefined) return { bytes: entries + blobs };
    const current = old as { pid: string; revision: number; generation: number; size: number; purged?: boolean };
    if (current.purged === true) {
      if (entries !== 0 || blobs !== 0) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "An erased replica still owns ciphertext rows.");
      return { bytes: 0 };
    }
    const tombstone = {
      pid: partitionId, revision: current.revision + 1, generation: current.generation + 1,
      coverageCode: 0 as const, syncedThroughEpoch: 0, keys: 0,
      contentMissing: 0, tombstones: 0, contentBytes: 0, purged: true as const, size: 0,
    };
    tombstone.size = measureSealedRow(partitionId, tombstone);
    const bytes = current.size + entries + blobs - tombstone.size;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The erased replica has an invalid byte delta.");
    meta.put(tombstone, partitionId);
    return { bytes };
  },
  async eraseIdentityPending(tx, identityKeyHash) {
    tx.objectStore(KV_STORE.pending).delete(identityKeyHash);
  },
};
