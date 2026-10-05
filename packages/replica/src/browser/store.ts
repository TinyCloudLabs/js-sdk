/**
 * `IndexedDbReplicaStore`: the browser `ReplicaStore` (TC-19).
 *
 * One IndexedDB database per replica, `tinycloud-replica/<replicaId>`, with
 * three object stores:
 *   meta     — `state` (ReplicaState + lease/writer fence + commit serial)
 *   entries  — keyPath `key`, index `byHash`, value includes `size`
 *   blobs    — keyPath `hash`, value `{bytes: Uint8Array, size}`
 *
 * Commit discipline (the design's one-transaction rule): `applyPage` runs a
 * single `readwrite` transaction over all three stores — fence check, blobs,
 * entries, tombstones, cursor and authority — and resolves on `tx.oncomplete`.
 * The engine fetches and blake3-verifies every byte before that transaction
 * opens, so nothing inside it awaits the network or WebCrypto.
 *
 * Fencing: the worker takes the Web Lock `tinycloud-replica:<replicaId>`
 * before syncing, calls `claimWriterLock` once, then the engine's lease
 * acquire bumps `writerEpoch` and stamps this worker as the writer. Every
 * commit re-checks lease token and writer holder under the same transaction,
 * so a paused or crashed former holder can never commit over the new
 * holder's state.
 */
import { ReplicaError, ReplicaErrorCode, isReplicaError } from "../errors.js";
import { effectiveAuthority } from "../scope.js";
import type {
  GrantRecord,
  LeaseToken,
  ListOpts,
  LocalEntry,
  ReplicaConfig,
  ReplicaLastError,
  ReplicaState,
  ReplicaStatus,
  ReplicaStore,
  VerifiedPage,
} from "../types.js";
import { compareKeyBytes, idbError, openDatabase, requestAsPromise, transactionDone } from "./idb.js";

export const DURABILITY = "indexeddb-strict";

const STORE_META = "meta";
const STORE_ENTRIES = "entries";
const STORE_BLOBS = "blobs";
const ALL_STORES: readonly string[] = [STORE_META, STORE_ENTRIES, STORE_BLOBS];

export const DEVICE_DATABASE = "tinycloud-replica-device";

/** The browser device identity: one Ed25519 session key per origin profile. */
export type DeviceIdentity = { jwk: object; did: string };

/** The `meta` record: `ReplicaState` plus writer/lease fencing fields. */
type MetaState = ReplicaState & {
  leaseToken: number;
  leaseHolder: string | null;
  leaseExpiresAt: number | null;
  writerEpoch: number;
  writerHolder: string | null;
  /** Monotonic commit counter; broadcast as `committed{serial}`. */
  serial: number;
  /** True while a revocation purge is recorded but unfinished. */
  purgePending: boolean;
};

type EntryRecord =
  | { key: string; deleted: true }
  | {
      key: string;
      deleted: false;
      etag: string;
      hash: string;
      metadata: Record<string, string>;
      content: boolean;
      size: number | null;
    };

type BlobRecord = { hash: string; bytes: Uint8Array; size: number };

export function replicaDatabaseName(replicaId: string): string {
  return `tinycloud-replica/${replicaId}`;
}

function createStores(db: IDBDatabase): void {
  db.createObjectStore(STORE_META);
  const entries = db.createObjectStore(STORE_ENTRIES, { keyPath: "key" });
  entries.createIndex("byHash", "hash", { unique: false });
  db.createObjectStore(STORE_BLOBS, { keyPath: "hash" });
}


/**
 * The per-origin device identity lives in its own database because the
 * replicaId (hence the database name) already contains the device DID.
 */
export async function deviceIdentity(getKey: () => Promise<DeviceIdentity> | DeviceIdentity): Promise<DeviceIdentity> {
  let db: IDBDatabase;
  try {
    db = await openDatabase(DEVICE_DATABASE, (creating) => creating.createObjectStore(STORE_META));
  } catch (error) {
    throw idbError(error, "Opening the device store");
  }
  try {
    const existing = await requestAsPromise<DeviceIdentity | undefined>(
      db.transaction(STORE_META).objectStore(STORE_META).get("device"),
    );
    if (existing !== undefined) return existing;
    const identity = await getKey();
    const tx = db.transaction(STORE_META, "readwrite", { durability: "strict" });
    tx.objectStore(STORE_META).put(identity, "device");
    await transactionDone(tx);
    return identity;
  } catch (error) {
    throw idbError(error, "Storing the device key");
  } finally {
    db.close();
  }
}

/** Delete the replica's database (purge). */
export function deleteReplicaDatabase(replicaId: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const request = indexedDB.deleteDatabase(replicaDatabaseName(replicaId));
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error);
  request.onblocked = () =>
    reject(new ReplicaError(ReplicaErrorCode.BUSY, "Purging the replica is blocked by an open connection in another tab."));
  return promise;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function entryOf(record: EntryRecord): LocalEntry {
  if (record.deleted) return { key: record.key, deleted: true };
  return {
    key: record.key,
    deleted: false,
    etag: record.etag,
    hash: record.hash,
    metadata: { ...record.metadata },
    content: record.content,
  };
}

export class IndexedDbReplicaStore implements ReplicaStore {
  readonly #db: IDBDatabase;
  readonly #holder: string;
  readonly #now: () => number;
  #closed = false;

  private constructor(db: IDBDatabase, holder: string, now: () => number) {
    this.#db = db;
    this.#holder = holder;
    this.#now = now;
  }

  static async open(replicaId: string, options: { holder: string; now?: () => number }): Promise<IndexedDbReplicaStore> {
    let db: IDBDatabase;
    try {
      db = await openDatabase(replicaDatabaseName(replicaId), createStores);
    } catch (error) {
      if (isReplicaError(error)) throw error;
      throw idbError(error, "Opening the replica");
    }
    return new IndexedDbReplicaStore(db, options.holder, options.now ?? Date.now);
  }

  /** A read transaction over `meta` (and optionally `entries`/`blobs`). */
  #readTx(stores: readonly string[]): IDBTransaction {
    if (this.#closed) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica store is closed.");
    return this.#db.transaction([...stores], "readonly");
  }

  /**
   * A write transaction with `strict` durability. `body` may only await IDB
   * requests issued on `tx`; the returned promise settles after the writes,
   * and `transactionDone` settles after the commit.
   */
  async #writeTx<T>(stores: readonly string[], action: string, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    if (this.#closed) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica store is closed.");
    let tx: IDBTransaction;
    try {
      tx = this.#db.transaction([...stores], "readwrite", { durability: "strict" });
    } catch (error) {
      throw idbError(error, action);
    }
    const done = transactionDone(tx);
    try {
      const result = await body(tx);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      await done.catch(() => undefined);
      throw idbError(error, action);
    }
  }

  async #meta(tx: IDBTransaction): Promise<MetaState | undefined> {
    return requestAsPromise<MetaState | undefined>(tx.objectStore(STORE_META).get("state"));
  }

  #requireMeta(state: MetaState | undefined): MetaState {
    if (state === undefined) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "The replica has not been created.");
    return state;
  }

  #putMeta(tx: IDBTransaction, state: MetaState): IDBRequest<IDBValidKey> {
    return tx.objectStore(STORE_META).put(state, "state");
  }

  async open(): Promise<ReplicaState | null> {
    let state: MetaState | undefined;
    try {
      state = await this.#meta(this.#readTx([STORE_META]));
    } catch (error) {
      throw idbError(error, "Reading the replica");
    }
    if (state === undefined) return null;
    return {
      config: state.config,
      grant: state.grant,
      pendingGrant: state.pendingGrant,
      nodeDid: state.nodeDid,
      authority: state.authority,
      revoked: state.revoked,
      cursor: state.cursor,
      coverage: state.coverage,
      generation: state.generation,
      createdAt: state.createdAt,
      lastSyncAt: state.lastSyncAt,
      lastCompleteAt: state.lastCompleteAt,
      lastError: state.lastError,
      lastReset: state.lastReset,
    };
  }

  async init(c: ReplicaConfig): Promise<void> {
    await this.#writeTx([STORE_META], "Creating the replica", async (tx) => {
      const existing = await this.#meta(tx);
      if (existing !== undefined) {
        throw new ReplicaError(ReplicaErrorCode.CONFIG_MISMATCH, `Replica ${c.name} already exists.`);
      }
      this.#putMeta(tx, {
        config: c,
        grant: null,
        pendingGrant: null,
        nodeDid: null,
        authority: null,
        revoked: null,
        cursor: null,
        coverage: "empty",
        generation: 0,
        createdAt: new Date(this.#now()).toISOString(),
        lastSyncAt: null,
        lastCompleteAt: null,
        lastError: null,
        lastReset: null,
        leaseToken: 0,
        leaseHolder: null,
        leaseExpiresAt: null,
        writerEpoch: 0,
        writerHolder: null,
        serial: 0,
        purgePending: false,
      });
    });
  }

  /** Worker-facing (not part of `ReplicaStore`): the retention opt-in. */
  async setRetentionGrant(cid: string | null): Promise<void> {
    await this.#writeTx([STORE_META], "Updating the retention grant", async (tx) => {
      const state = this.#requireMeta(await this.#meta(tx));
      state.config = {
        ...state.config,
        retentionGrantCid: cid,
        localReadPolicy: cid === null ? "whileGrantValid" : "retainAfterExpiry",
      };
      this.#putMeta(tx, state);
    });
  }

  async installGrant(g: GrantRecord): Promise<void> {
    await this.#writeTx([STORE_META], "Installing the grant", async (tx) => {
      const state = this.#requireMeta(await this.#meta(tx));
      if (state.grant?.cid === g.cid || state.pendingGrant?.cid === g.cid) return;
      state.pendingGrant = g;
      this.#putMeta(tx, state);
    });
  }

  /**
   * Worker-facing, not part of `ReplicaStore`: called once under the Web Lock
   * before the engine syncs or resets. Bumps `writerEpoch` (fencing a paused
   * or crashed former holder's in-flight commits) and clears a foreign lease
   * row — under the lock its holder can only be dead or lockless.
   */
  async claimWriterLock(): Promise<void> {
    await this.#writeTx([STORE_META], "Claiming the writer lock", async (tx) => {
      const state = this.#requireMeta(await this.#meta(tx));
      state.writerEpoch += 1;
      state.writerHolder = this.#holder;
      if (state.leaseHolder !== null && state.leaseHolder !== this.#holder) {
        state.leaseHolder = null;
        state.leaseExpiresAt = null;
      }
      this.#putMeta(tx, state);
    });
  }

  /**
   * Take the sync lease. A live lease — foreign or our own — returns null, so
   * a crashed holder's lease is first cleared by {@link claimWriterLock} under
   * the Web Lock. Every acquire bumps `writerEpoch` and stamps the holder:
   * that is the storage fence every later commit re-checks.
   */
  async acquireSyncLease(ttlMs: number): Promise<LeaseToken | null> {
    return this.#writeTx([STORE_META], "Taking the sync lease", async (tx) => {
      const state = this.#requireMeta(await this.#meta(tx));
      const now = this.#now();
      if (state.leaseHolder !== null && state.leaseExpiresAt !== null && state.leaseExpiresAt > now) return null;
      state.writerEpoch += 1;
      state.writerHolder = this.#holder;
      state.leaseToken += 1;
      state.leaseHolder = this.#holder;
      state.leaseExpiresAt = now + ttlMs;
      this.#putMeta(tx, state);
      return { token: state.leaseToken, holder: this.#holder };
    });
  }

  /** Inside a write transaction: the lease and the writer epoch must both hold. */
  #checkFence(state: MetaState, t: LeaseToken): void {
    if (state.leaseToken !== t.token || state.leaseHolder !== t.holder) {
      throw new ReplicaError(ReplicaErrorCode.BUSY, "Another process took over this replica's sync lease.");
    }
    if (state.writerHolder !== this.#holder) {
      throw new ReplicaError(ReplicaErrorCode.BUSY, "Another tab took over this replica's writer lock.");
    }
  }

  async renewLease(t: LeaseToken, ttlMs = 120_000): Promise<void> {
    await this.#writeTx([STORE_META], "Renewing the sync lease", async (tx) => {
      const state = this.#requireMeta(await this.#meta(tx));
      this.#checkFence(state, t);
      state.leaseExpiresAt = this.#now() + ttlMs;
      this.#putMeta(tx, state);
    });
  }

  async releaseLease(t: LeaseToken): Promise<void> {
    await this.#writeTx([STORE_META], "Releasing the sync lease", async (tx) => {
      const state = await this.#meta(tx);
      if (state === undefined || state.leaseToken !== t.token || state.leaseHolder !== t.holder) return;
      state.leaseHolder = null;
      state.leaseExpiresAt = null;
      this.#putMeta(tx, state);
    });
  }

  /** Scan `byHash` once and keep hashes referenced by a live, content-backed entry. */
  async #hashesWithEntries(tx: IDBTransaction, wanted: Set<string> | null): Promise<Set<string>> {
    const found = new Set<string>();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const request = tx.objectStore(STORE_ENTRIES).index("byHash").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve();
        return;
      }
      const record = cursor.value as EntryRecord;
      if (!record.deleted && record.content && (wanted === null || wanted.has(record.hash))) found.add(record.hash);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    await promise;
    return found;
  }

  async hasContent(hashes: string[]): Promise<Set<string>> {
    const wanted = new Set(hashes);
    if (wanted.size === 0) return wanted;
    try {
      return await this.#hashesWithEntries(this.#readTx([STORE_ENTRIES]), wanted);
    } catch (error) {
      throw idbError(error, "Reading the replica");
    }
  }

  async applyPage(t: LeaseToken, p: VerifiedPage): Promise<void> {
    await this.#writeTx(ALL_STORES, "Committing a sync page", async (tx) => {
      const state = this.#requireMeta(await this.#meta(tx));
      this.#checkFence(state, t);
      if (state.revoked !== null) {
        throw new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, `The replica's grant was revoked: ${state.revoked}`);
      }
      // Re-check the window the node attested on this page inside the commit
      // transaction: an expired or not-yet-valid window never reaches disk.
      if (p.authority !== null) {
        const authority = effectiveAuthority({
          window: p.authority,
          grant: state.grant,
          revoked: null,
          policy: "whileGrantValid",
          now: this.#now(),
        });
        if (authority.state === "expired") {
          throw new ReplicaError(ReplicaErrorCode.GRANT_EXPIRED, `The grant expired at ${authority.expiresAt}.`);
        }
        if (authority.state === "not-yet-valid") {
          throw new ReplicaError(ReplicaErrorCode.GRANT_NOT_YET_VALID, `The grant is not valid before ${authority.notBefore}.`);
        }
      }
      const entries = tx.objectStore(STORE_ENTRIES);
      const blobs = tx.objectStore(STORE_BLOBS);

      // Resolve every held-blob reference before mutating anything: content
      // reused within one page (same hash, several keys) must find its size
      // without relying on an earlier row's put having landed.
      const sizes = new Map<string, number>();
      for (const change of p.changes) {
        if (change.deleted || !change.content) continue;
        const bytes = p.blobs.get(change.hash);
        if (bytes !== undefined) {
          sizes.set(change.hash, bytes.length);
          continue;
        }
        const previous = await requestAsPromise<EntryRecord | undefined>(entries.get(change.key));
        if (previous !== undefined && !previous.deleted && previous.content && previous.hash === change.hash && previous.size !== null) {
          sizes.set(change.hash, previous.size);
          continue;
        }
        const held = await requestAsPromise<BlobRecord | undefined>(blobs.get(change.hash));
        if (held !== undefined) sizes.set(change.hash, held.size);
      }
      for (const change of p.changes) {
        if (change.deleted || !change.content) continue;
        if (sizes.get(change.hash) === undefined) {
          throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, `No stored content backs ${JSON.stringify(change.key)}.`);
        }
      }

      for (const [hash, bytes] of p.blobs) {
        blobs.put({ hash, bytes, size: bytes.length } satisfies BlobRecord);
      }
      for (const change of p.changes) {
        if (change.deleted) {
          entries.put({ key: change.key, deleted: true } satisfies EntryRecord);
          continue;
        }
        entries.put({
          key: change.key,
          deleted: false,
          etag: change.etag,
          hash: change.hash,
          metadata: change.metadata,
          content: change.content,
          size: change.content ? (sizes.get(change.hash) ?? null) : null,
        } satisfies EntryRecord);
      }
      state.cursor = p.cursor;
      state.coverage = p.coverage;
      state.serial += 1;
      if (p.authority !== null) {
        state.nodeDid = p.source.nodeDid;
        state.authority = p.authority;
        state.lastSyncAt = p.at;
      }
      if (p.complete) {
        state.lastCompleteAt = p.at;
        state.lastError = null;
      }
      // Promotion is bound to the CID the node just validated; a newer pending
      // grant stays pending until a page commits under it. (Post-review TC-18
      // types carry the CID directly; a legacy boolean promotes the pending
      // record unconditionally.)
      const promotedCid = p.promoteGrant === true ? (state.pendingGrant?.cid ?? null) : p.promoteGrant;
      if (state.pendingGrant !== null && state.pendingGrant.cid === promotedCid) {
        state.grant = state.pendingGrant;
        state.pendingGrant = null;
      }
      this.#putMeta(tx, state);
    });
  }

  /** The serial of the last committed page (the worker broadcasts it). */
  async commitSerial(): Promise<number> {
    const state = await this.#meta(this.#readTx([STORE_META]));
    return state?.serial ?? 0;
  }

  async collectGarbage(t: LeaseToken): Promise<number> {
    return this.#writeTx(ALL_STORES, "Collecting unused content", async (tx) => {
      const state = this.#requireMeta(await this.#meta(tx));
      this.#checkFence(state, t);
      const keep = await this.#hashesWithEntries(tx, null);
      const hashes = await requestAsPromise<IDBValidKey[]>(tx.objectStore(STORE_BLOBS).getAllKeys());
      let removed = 0;
      for (const hash of hashes) {
        if (typeof hash === "string" && !keep.has(hash)) {
          tx.objectStore(STORE_BLOBS).delete(hash);
          removed += 1;
        }
      }
      return removed;
    });
  }

  async reset(t: LeaseToken, reason: string, options?: { keepNodeDid?: boolean }): Promise<void> {
    await this.#writeTx(ALL_STORES, "Resetting the replica", async (tx) => {
      const state = this.#requireMeta(await this.#meta(tx));
      this.#checkFence(state, t);
      tx.objectStore(STORE_ENTRIES).clear();
      tx.objectStore(STORE_BLOBS).clear();
      state.cursor = null;
      // An automatic 410 reset keeps the source pin; a manual or purge reset drops it.
      if (options?.keepNodeDid !== true) state.nodeDid = null;
      state.coverage = "empty";
      state.lastSyncAt = null;
      state.lastCompleteAt = null;
      state.lastError = null;
      state.lastReset = { at: new Date(this.#now()).toISOString(), reason };
      state.generation += 1;
      this.#putMeta(tx, state);
    });
  }



  async markRevoked(detail: string): Promise<void> {
    await this.#writeTx(ALL_STORES, "Recording the revocation", async (tx) => {
      const state = await this.#meta(tx);
      tx.objectStore(STORE_ENTRIES).clear();
      tx.objectStore(STORE_BLOBS).clear();
      if (state !== undefined) {
        state.revoked = detail;
        state.cursor = null;
        state.coverage = "empty";
        state.lastError = { at: new Date(this.#now()).toISOString(), code: ReplicaErrorCode.GRANT_REVOKED, message: detail };
        // Fence any outstanding writer: its next commit sees a foreign
        // writerHolder and a dead lease, and aborts.
        state.writerEpoch += 1;
        state.writerHolder = null;
        state.leaseHolder = null;
        state.leaseExpiresAt = null;
        // The clears above commit atomically here; `purgePending` makes the
        // intent durable so a torn-open repair can re-purge on next open.
        state.purgePending = true;
        this.#putMeta(tx, state);
      }
    });
  }

  /**
   * Finish a revocation purge whose marker survived a torn open (the
   * transaction is atomic in IndexedDB, so this only ever runs when an older
   * or externally-written database says so).
   */
  async finishPurgeIfPending(): Promise<void> {
    await this.#writeTx(ALL_STORES, "Finishing a revocation purge", async (tx) => {
      const state = await this.#meta(tx);
      if (state === undefined || state.purgePending !== true) return;
      tx.objectStore(STORE_ENTRIES).clear();
      tx.objectStore(STORE_BLOBS).clear();
      state.purgePending = false;
      this.#putMeta(tx, state);
    });
  }

  async recordError(e: ReplicaLastError): Promise<void> {
    await this.#writeTx([STORE_META], "Recording the sync error", async (tx) => {
      const state = await this.#meta(tx);
      if (state === undefined) return;
      state.lastError = e;
      this.#putMeta(tx, state);
    });
  }

  async get(key: string): Promise<LocalEntry | undefined> {
    try {
      const record = await requestAsPromise<EntryRecord | undefined>(
        this.#readTx([STORE_ENTRIES]).objectStore(STORE_ENTRIES).get(key),
      );
      return record === undefined ? undefined : entryOf(record);
    } catch (error) {
      throw idbError(error, "Reading the replica");
    }
  }

  async list(o: ListOpts): Promise<LocalEntry[]> {
    try {
      const records = await requestAsPromise<EntryRecord[]>(
        this.#readTx([STORE_ENTRIES]).objectStore(STORE_ENTRIES).getAll(),
      );
      let rows = records.filter((record) => !record.deleted);
      if (o.prefix !== undefined && o.prefix !== "") rows = rows.filter((record) => record.key.startsWith(o.prefix!));
      if (o.after !== undefined) rows = rows.filter((record) => compareKeyBytes(record.key, o.after!) > 0);
      rows.sort((a, b) => compareKeyBytes(a.key, b.key));
      if (o.limit !== undefined) rows = rows.slice(0, o.limit);
      return rows.map(entryOf);
    } catch (error) {
      throw idbError(error, "Listing the replica");
    }
  }

  async pendingRepairs(limit: number): Promise<Array<Extract<LocalEntry, { deleted: false }>>> {
    try {
      const records = await requestAsPromise<EntryRecord[]>(
        this.#readTx([STORE_ENTRIES]).objectStore(STORE_ENTRIES).getAll(),
      );
      return records
        .filter((record) => !record.deleted && !record.content)
        .sort((a, b) => compareKeyBytes(a.key, b.key))
        .slice(0, limit)
        .map(entryOf) as Array<Extract<LocalEntry, { deleted: false }>>;
    } catch (error) {
      throw idbError(error, "Reading the replica");
    }
  }

  async readContent(hash: string): Promise<Uint8Array | undefined> {
    if (!isHash(hash)) return undefined;
    try {
      const record = await requestAsPromise<BlobRecord | undefined>(
        this.#readTx([STORE_BLOBS]).objectStore(STORE_BLOBS).get(hash),
      );
      return record?.bytes;
    } catch (error) {
      throw idbError(error, "Reading replica content");
    }
  }

  async status(now = this.#now()): Promise<ReplicaStatus> {
    const tx = this.#readTx([STORE_META, STORE_ENTRIES]);
    let state: MetaState;
    let records: EntryRecord[];
    try {
      state = this.#requireMeta(await this.#meta(tx));
      records = await requestAsPromise<EntryRecord[]>(tx.objectStore(STORE_ENTRIES).getAll());
    } catch (error) {
      throw idbError(error, "Reading the replica");
    }
    let keys = 0;
    let missing = 0;
    let tombstones = 0;
    let bytes = 0;
    for (const record of records) {
      if (record.deleted) {
        tombstones += 1;
      } else {
        keys += 1;
        if (record.content) bytes += record.size ?? 0;
        else missing += 1;
      }
    }
    const authority = effectiveAuthority({
      window: state.authority,
      grant: state.grant,
      revoked: state.revoked,
      policy: state.config.localReadPolicy,
      now,
    });
    return {
      name: state.config.name,
      replicaId: state.config.replicaId,
      source: { host: state.config.host, nodeDid: state.nodeDid, space: state.config.space, prefix: state.config.prefix },
      device: {
        did: state.config.deviceDid,
        delegationCid: state.grant?.cid ?? null,
        pendingDelegationCid: state.pendingGrant?.cid ?? null,
      },
      authority: {
        ...authority,
        localReadPolicy: state.config.localReadPolicy,
        retentionGrantCid: state.config.retentionGrantCid,
        revokedDetail: state.revoked,
      },
      consistency: "observed",
      coverage: state.coverage,
      lastSyncAt: state.lastSyncAt,
      lastCompleteAt: state.lastCompleteAt,
      counts: { keys, contentMissing: missing, tombstones },
      bytes,
      durability: DURABILITY,
      syncing: state.leaseHolder !== null && state.leaseExpiresAt !== null && state.leaseExpiresAt > now,
      lastError: state.lastError,
      lastReset: state.lastReset,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#db.close();
  }
}
