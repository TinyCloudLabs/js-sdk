/**
 * The origin database of `@tinycloud/replica/kv-storage` (TC-858 Phase 2
 * plan §3): ONE IndexedDB database per origin, `tinycloud-replica-kv`, so
 * that a page commit, its quota accounting and its lifecycle-gate check, or
 * an erase and its purge-intent update, each run as a single transaction.
 *
 * Stores:
 *   meta          — one state row per partition, keyed by partition id
 *   entries       — keyPath [pid, key]; index byHash [pid, hash]
 *   blobs         — keyPath [pid, hash]; index bySize [pid, size]
 *   pendingWrites — one PendingWriteState per identity, keyed by its identity key
 *   device        — the owner-minted device key of this origin ("device")
 *   gate, partitions, purgeIntents — lifecycle control stores (slice C)
 *   quotaLedger   — the origin-wide byte ledger (slice E)
 *
 * The RC1 `openReplica` databases (`tinycloud-replica/<id>`) are separate
 * and untouched.
 */
import { sha256 } from "@noble/hashes/sha2";
import { replicationIdentityKey } from "@tinycloud/sdk-services/kv/replication";
import type { ReplicationIdentity } from "@tinycloud/sdk-services";

import { principalOf } from "../did.js";
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { eraseReplicaRows, type ReplicaStoreLayout } from "../browser/store.js";

export const KV_DATABASE = "tinycloud-replica-kv";
export const KV_DATABASE_VERSION = 1;

export const KV_STORE = {
  meta: "meta",
  entries: "entries",
  blobs: "blobs",
  pendingWrites: "pendingWrites",
  device: "device",
  gate: "gate",
  partitions: "partitions",
  purgeIntents: "purgeIntents",
  quotaLedger: "quotaLedger",
} as const;

/** The scope a partition erase (and the identity-scoped pending erase) needs. */
export const ERASE_STORES: readonly string[] = [KV_STORE.meta, KV_STORE.entries, KV_STORE.blobs, KV_STORE.pendingWrites];

const READ_SCOPE: readonly string[] = [KV_STORE.gate];
const WRITE_SCOPE: readonly string[] = [KV_STORE.gate, KV_STORE.partitions, KV_STORE.purgeIntents, KV_STORE.quotaLedger];

function createStores(db: IDBDatabase): void {
  db.createObjectStore(KV_STORE.meta);
  const entries = db.createObjectStore(KV_STORE.entries, { keyPath: ["pid", "key"] });
  entries.createIndex("byHash", ["pid", "hash"], { unique: false });
  const blobs = db.createObjectStore(KV_STORE.blobs, { keyPath: ["pid", "hash"] });
  blobs.createIndex("bySize", ["pid", "size"], { unique: false });
  db.createObjectStore(KV_STORE.pendingWrites);
  db.createObjectStore(KV_STORE.device);
  db.createObjectStore(KV_STORE.gate);
  db.createObjectStore(KV_STORE.partitions, { keyPath: "partitionId" });
  db.createObjectStore(KV_STORE.purgeIntents, { keyPath: "intentId" });
  db.createObjectStore(KV_STORE.quotaLedger);
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

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * The partition id: base32(sha256) over the canonical identity key
 * (`replicationIdentityKey`: host, space and lower-cased principal), the
 * prefix and the device principal (any `#fragment` dropped), first 26
 * characters — the same hashing the Node adapter uses for its directories.
 */
export function partitionIdOf(input: { identity: ReplicationIdentity; prefix: string; deviceDid: string }): string {
  const material = `${replicationIdentityKey(input.identity)}\n${input.prefix}\n${principalOf(input.deviceDid)}`;
  const digest = sha256(new TextEncoder().encode(material));
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, 26);
}

/** The partition-scoped key layout `IndexedDbReplicaStore` runs over. */
export function kvLayout(partitionId: string): ReplicaStoreLayout {
  return {
    partitionId,
    readScope: READ_SCOPE,
    writeScope: WRITE_SCOPE,
    metaKey: partitionId,
    entryKey: (key) => [partitionId, key],
    blobKey: (hash) => [partitionId, hash],
    blobHashOf: (key) => (Array.isArray(key) && key[0] === partitionId && typeof key[1] === "string" ? key[1] : undefined),
    // Arrays sort after every string, so [pid, []] bounds every [pid, <string|number>].
    range: IDBKeyRange.bound([partitionId], [partitionId, []]),
    tag: { pid: partitionId },
    blobSizeIndex: "bySize",
  };
}

/**
 * Erase one partition inside `tx` (scope {@link ERASE_STORES}): entries and
 * blobs are deleted and the state row — config, grant, authority, cursor —
 * becomes a contentless tombstone that fences every handle opened before
 * it. Returns the blob bytes removed, for the quota ledger.
 */
export function erasePartition(tx: IDBTransaction, partitionId: string): Promise<{ blobBytes: number }> {
  return eraseReplicaRows(tx, kvLayout(partitionId));
}
