import type {
  ReplicaBrowserGateAccess,
  ReplicaGrantPolicy,
  ReplicaGuardedStore,
  ReplicaPartitionIndexEntry,
} from "@tinycloud/sdk-services/kv/replication";
import { clampConsentAnchor, consentDeadlineMs, effectiveGrantExpiry } from "@tinycloud/sdk-services/kv/replication/grantPolicy";

import { compareKeyBytes, idbError, requestAsPromise } from "../browser/idb.js";
import { type GrantPolicyView, DURABILITY } from "../browser/store.js";
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { parseUcanGrant } from "../grant.js";
import { assertReadable, effectiveAuthority, isInstant } from "../scope.js";
import type {
  GrantRecord, LeaseToken, ListOpts, LocalEntry, ReplicaConfig, ReplicaLastError,
  ReplicaState, ReplicaStatus, ReplicaStore, VerifiedPage,
} from "../types.js";
import { decodeBlob, decodeJson, encodeBlob, encodeJson } from "./codec.js";
import type { BrowserReplicaGateTx } from "./gateTx.js";
import type { ReplicaBrowserQuotaLedger } from "./ledger.js";
import { FIRST_INSTALL_KEY_PREFIX, GRANT_INSTALL_KEY_PREFIX, KV_STORE } from "./schema.js";
import { measureSealedRow, opaqueId, openSealed, seal, type SealedRecord } from "./sealed.js";

const CONFLICT = Symbol("sealed replica revision changed");
const MAX_CAS_ATTEMPTS = 8;
const RANGE_END: IDBValidKey = [];

/** Only numeric/opaque controls are outside the authenticated ciphertext. */
export type SealedMeta = {
  pid: string;
  revision: number;
  generation: number;
  coverageCode: 0 | 1 | 2;
  syncedThroughEpoch: number;
  keys: number;
  contentMissing: number;
  tombstones: number;
  contentBytes: number;
  size: number;
} & ((SealedRecord & { purged: false }) | { purged: true });
export type SealedEntry = SealedRecord & { pid: string; hashId?: string; size: number };
export type SealedBlob = SealedRecord & { pid: string; size: number };

type Live = ReplicaState & {
  leaseToken: number;
  leaseHolder: string | null;
  leaseExpiresAt: number | null;
  writerEpoch: number;
  writerHolder: string | null;
  serial: number;
  purgePending: boolean;
  syncedThroughEpoch: number;
  syncCompletedAt: string | null;
};

type Entry = LocalEntry & { size?: number | null };
type MetaSnapshot = { row: SealedMeta | undefined; state: Live | undefined };
type Row = { key: IDBValidKey; value: SealedEntry | SealedBlob };

function coverageCode(coverage: ReplicaState["coverage"]): 0 | 1 | 2 {
  return coverage === "empty" ? 0 : coverage === "bootstrapping" ? 1 : 2;
}

function rowSize(key: IDBValidKey, row: SealedEntry | SealedBlob | SealedMeta): number {
  const size = measureSealedRow(key, row);
  if (!Number.isSafeInteger(row.size) || row.size !== size) {
    throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica's ciphertext row-byte measure is corrupt.");
  }
  return size;
}

/** A cursor keeps each opaque primary key adjacent to its ciphertext, without loading another index. */
function scanRows(tx: IDBTransaction, name: string, pid: string): Promise<Row[]> {
  const range = IDBKeyRange.bound([pid], [pid, RANGE_END]);
  const rows: Row[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<Row[]>();
  const request = tx.objectStore(name).openCursor(range);
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor === null) return resolve(rows);
    rows.push({ key: cursor.primaryKey, value: cursor.value as SealedEntry | SealedBlob });
    cursor.continue();
  };
  request.onerror = () => reject(request.error);
  return promise;
}

/**
 * Browser v2 store. Every data read uses the S3 gate. A mutation reads a guarded snapshot,
 * pre-seals it without an IDB transaction, then rechecks revision/key IDs in one guarded
 * transaction and accounts the exact signed final-row delta before any write. RC1 remains
 * on its independent per-partition IndexedDbReplicaStore and is never downgraded to v2.
 */
export class SealedReplicaStore implements ReplicaStore {
  readonly #pid: string;
  readonly #holder: string;
  readonly #now: () => number;
  readonly #gate: BrowserReplicaGateTx;
  readonly #access: ReplicaBrowserGateAccess;
  readonly #aes: CryptoKey;
  readonly #hmac: CryptoKey;
  readonly #ledger: ReplicaBrowserQuotaLedger;
  readonly #identityKeyHash: string;
  readonly #policy: ReplicaGrantPolicy;
  readonly #index: ReplicaPartitionIndexEntry;
  #generation = 0;
  #closed = false;

  private constructor(options: {
    partitionId: string; holder: string; now: () => number; gate: BrowserReplicaGateTx;
    access: ReplicaBrowserGateAccess; aes: CryptoKey; hmac: CryptoKey;
    ledger: ReplicaBrowserQuotaLedger; identityKeyHash: string; policy: ReplicaGrantPolicy;
    index: ReplicaPartitionIndexEntry;
  }) {
    this.#pid = options.partitionId;
    this.#holder = options.holder;
    this.#now = options.now;
    this.#gate = options.gate;
    this.#access = options.access;
    this.#aes = options.aes;
    this.#hmac = options.hmac;
    this.#ledger = options.ledger;
    this.#identityKeyHash = options.identityKeyHash;
    this.#policy = options.policy;
    this.#index = options.index;
  }

  static async openIn(options: {
    partitionId: string; holder: string; now?: () => number; gate: BrowserReplicaGateTx;
    access: ReplicaBrowserGateAccess; ledger: ReplicaBrowserQuotaLedger;
    identityKeyHash: string; policy: ReplicaGrantPolicy; index: ReplicaPartitionIndexEntry;
  }): Promise<SealedReplicaStore> {
    const key = await options.gate.readAccountKey(options.access);
    const store = new SealedReplicaStore({ ...options, now: options.now ?? Date.now, aes: key.aesGcm, hmac: key.hmac });
    store.#generation = (await store.#snapshot()).row?.generation ?? 0;
    return store;
  }

  #checkOpen(): void {
    if (this.#closed) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica store is closed.");
  }

  #run<T>(stores: readonly ReplicaGuardedStore[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    this.#checkOpen();
    return this.#gate.run({ stores, mode: mode === "readwrite" ? "readwrite" : "readonly" }, this.#access, fn)
      .catch((error: unknown) => {
        if (error !== null && typeof error === "object" && "name" in error && error.name === "QuotaExceededError") {
          throw idbError(error, "Writing the encrypted replica");
        }
        throw error;
      });
  }

  #context(name: string, id: string, hashId = ""): string {
    return `${name}\0${this.#pid}\0${id}\0${hashId}`;
  }

  #metaContext(row: Pick<SealedMeta, "revision" | "generation" | "coverageCode" | "syncedThroughEpoch" |
    "keys" | "contentMissing" | "tombstones" | "contentBytes" | "purged">): string {
    return `meta\0${this.#pid}\0${row.revision}\0${row.generation}\0${row.coverageCode}\0${row.syncedThroughEpoch}\0${row.keys}\0${row.contentMissing}\0${row.tombstones}\0${row.contentBytes}\0${Number(row.purged)}`;
  }

  async #snapshot(): Promise<MetaSnapshot> {
    const row = await this.#run([KV_STORE.meta], "readonly", (tx) =>
      requestAsPromise<SealedMeta | undefined>(tx.objectStore(KV_STORE.meta).get(this.#pid)));
    if (row === undefined) return { row, state: undefined };
    rowSize(this.#pid, row);
    if (row.pid !== this.#pid) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica metadata belongs to another partition.");
    // Erase writes a keyless tombstone; no account key is needed to observe its fence.
    if (row.purged) return { row, state: undefined };
    const state = decodeJson<Live>(await openSealed(this.#aes, row, this.#metaContext(row)));
    if (state.generation !== row.generation || coverageCode(state.coverage) !== row.coverageCode ||
        state.syncedThroughEpoch !== row.syncedThroughEpoch) {
      throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica metadata controls do not authenticate to their sealed state.");
    }
    return { row, state };
  }

  #live(snapshot: MetaSnapshot): Live {
    const state = snapshot.state;
    if (snapshot.row?.purged === true || (state !== undefined && state.generation !== this.#generation)) {
      throw new ReplicaError(ReplicaErrorCode.RESET_REQUIRED, "The replica was purged or reopened; open it again to continue.");
    }
    if (state === undefined) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "The replica has not been created.");
    return state;
  }

  async #sealedMeta(state: Live, old: SealedMeta | undefined, counters?: Pick<SealedMeta, "keys" | "contentMissing" | "tombstones" | "contentBytes">): Promise<SealedMeta> {
    const controls = {
      pid: this.#pid, revision: (old?.revision ?? 0) + 1, generation: state.generation,
      coverageCode: coverageCode(state.coverage), syncedThroughEpoch: state.syncedThroughEpoch,
      keys: counters?.keys ?? old?.keys ?? 0,
      contentMissing: counters?.contentMissing ?? old?.contentMissing ?? 0,
      tombstones: counters?.tombstones ?? old?.tombstones ?? 0,
      contentBytes: counters?.contentBytes ?? old?.contentBytes ?? 0,
      purged: false as const,
    };
    const envelope = await seal(this.#aes, encodeJson(state), this.#metaContext(controls));
    const row = { ...controls, ...envelope };
    return { ...row, size: measureSealedRow(this.#pid, row) };
  }

  async #commitMeta<T>(change: (state: Live | undefined, row: SealedMeta | undefined) => T | Promise<T>, options: {
    initial?: boolean;
    apply?: (state: Live | undefined, result: T, row: SealedMeta | undefined) => Live | null | undefined;
    index?: (tx: IDBTransaction, result: T) => Promise<{ deviceDeltaBytes: number; commit: () => Promise<void> | void } | void>;
    check?: (state: Live, result: T) => void;
    stores?: readonly ReplicaGuardedStore[];
  } = {}): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = await this.#snapshot();
      const state = options.initial ? snapshot.state : this.#live(snapshot);
      const result = await change(state, snapshot.row);
      const next = options.apply === undefined ? state : options.apply(state, result, snapshot.row);
      if (next === null || next === undefined) return result;
      const row = await this.#sealedMeta(next, snapshot.row);
      const freeBytes = await this.#ledger.freeBytes();
      try {
        await this.#run([KV_STORE.meta, ...(options.stores ?? [])], "readwrite", async (tx) => {
          const meta = tx.objectStore(KV_STORE.meta);
          const old = await requestAsPromise<SealedMeta | undefined>(meta.get(this.#pid));
          if (old?.revision !== snapshot.row?.revision) throw CONFLICT;
          options.check?.(next, result);
          const planned = await options.index?.(tx, result);
          const partitionDeltaBytes = row.size - (old === undefined ? 0 : rowSize(this.#pid, old));
          const deviceDeltaBytes = planned?.deviceDeltaBytes ?? 0;
          await this.#ledger.admitRows(tx, { partitionId: this.#pid, partitionDeltaBytes, deviceDeltaBytes, freeBytes });
          await planned?.commit();
          meta.put(row, this.#pid);
          await this.#ledger.accountRows(tx, { partitionId: this.#pid, partitionDeltaBytes, deviceDeltaBytes });
        });
        return result;
      } catch (error) {
        if (error !== CONFLICT) throw error;
      }
    }
    throw new ReplicaError(ReplicaErrorCode.BUSY, "The replica changed while preparing encrypted state.");
  }

  #fence(state: Live, token: LeaseToken, allowRevoked = false): void {
    if (state.revoked !== null && !allowRevoked) throw new ReplicaError(ReplicaErrorCode.GRANT_REVOKED, "The replica's grant was revoked.");
    if (state.leaseToken !== token.token || state.leaseHolder !== token.holder || state.writerHolder !== this.#holder ||
        state.leaseExpiresAt === null || state.leaseExpiresAt <= this.#now()) {
      throw new ReplicaError(ReplicaErrorCode.BUSY, "Another writer took over the replica's sync lease.");
    }
  }

  async #stamp(row: SealedRecord | undefined, key: string): Promise<number | undefined> {
    if (row === undefined) return undefined;
    const stamp: unknown = decodeJson(await openSealed(this.#aes, row, `device\0${key}`));
    if (stamp === null || typeof stamp !== "object" || !("at" in stamp) ||
        typeof stamp.at !== "number" || !Number.isSafeInteger(stamp.at) || stamp.at < 0) {
      throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The encrypted grant install time is corrupt.");
    }
    return stamp.at;
  }

  async #policyView(state: Live): Promise<GrantPolicyView> {
    const ids = await Promise.all([state.grant, state.pendingGrant].map((grant) =>
      grant === null ? null : opaqueId(this.#hmac, "grantInstall", this.#identityKeyHash, grant.cid)));
    const stamps = await this.#run([KV_STORE.device], "readonly", async (tx) => {
      const device = tx.objectStore(KV_STORE.device);
      const gate = await requestAsPromise<{ consentDeadline: number } | undefined>(tx.objectStore(KV_STORE.gate).get("account"));
      const anchor = await requestAsPromise<SealedRecord | undefined>(device.get(FIRST_INSTALL_KEY_PREFIX + this.#identityKeyHash));
      const grants = await Promise.all(ids.map((id) => id === null ? undefined :
        requestAsPromise<SealedRecord | undefined>(device.get(`${GRANT_INSTALL_KEY_PREFIX}${this.#identityKeyHash}:${id}`))));
      return { gate, anchor, grants };
    });
    const anchorKey = FIRST_INSTALL_KEY_PREFIX + this.#identityKeyHash;
    const firstInstalledAt = await this.#stamp(stamps.anchor, anchorKey);
    const installed = await Promise.all(ids.map((id, index) => id === null ? undefined :
      this.#stamp(stamps.grants[index], `${GRANT_INSTALL_KEY_PREFIX}${this.#identityKeyHash}:${id}`)));
    const now = this.#now();
    const anchor = clampConsentAnchor(this.#policy.consentAnchor, now) ??
      (firstInstalledAt === undefined ? null : clampConsentAnchor({ at: firstInstalledAt, source: "first_install" }, now));
    const gateDeadline = stamps.gate?.consentDeadline;
    if (typeof gateDeadline !== "number" || !Number.isSafeInteger(gateDeadline) || gateDeadline < 0) {
      throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica account consent deadline is invalid.");
    }
    const consentDeadline = Math.min(anchor === null ? Number.NEGATIVE_INFINITY : consentDeadlineMs(anchor), gateDeadline);
    const grants: GrantPolicyView["grants"] = {};
    for (const [index, record] of [state.grant, state.pendingGrant].entries()) {
      if (record === null || grants[record.cid] !== undefined) continue;
      const installedAt = installed[index];
      grants[record.cid] = {
        installedAt,
        effectiveExpiresAt: effectiveGrantExpiry({ signedExpiresAt: record.expiresAt === null ? null : record.expiresAt * 1000,
          installedAt: installedAt ?? Number.NEGATIVE_INFINITY, grantTtlMs: this.#policy.grantTtlMs, consentDeadline }),
      };
    }
    return { anchor, consentDeadline, grants };
  }

  #cappedGrant(grant: GrantRecord | null, view: GrantPolicyView): GrantRecord | null {
    if (grant === null) return null;
    const expiry = view.grants[grant.cid]?.effectiveExpiresAt;
    return { ...grant, expiresAt: expiry !== undefined && Number.isFinite(expiry) ? expiry / 1000 : 0 };
  }

  async #serving(): Promise<Live> {
    const state = this.#live(await this.#snapshot());
    const view = await this.#policyView(state);
    const now = this.#now();
    if (!Number.isFinite(now) || ((state.grant !== null || state.pendingGrant !== null) && now >= view.consentDeadline)) {
      throw new ReplicaError(ReplicaErrorCode.CONSENT_EXPIRED, "The replica consent window ended.");
    }
    const grant = this.#cappedGrant(state.grant, view);
    if (grant !== null && now >= (view.grants[grant.cid]?.effectiveExpiresAt ?? Number.NEGATIVE_INFINITY)) {
      throw new ReplicaError(ReplicaErrorCode.GRANT_EXPIRED, "The replica's effective grant expired.");
    }
    assertReadable(effectiveAuthority({ window: state.authority, grant, revoked: state.revoked,
      retentionRevoked: state.retentionRevoked, policy: state.config.localReadPolicy, now }), now);
    return state;
  }

  async open(): Promise<(ReplicaState & { grantPolicyView: GrantPolicyView }) | null> {
    const snapshot = await this.#snapshot();
    if (snapshot.state === undefined) {
      if (snapshot.row?.purged === true && snapshot.row.generation !== this.#generation) {
        throw new ReplicaError(ReplicaErrorCode.RESET_REQUIRED, "The replica was purged; open it again to continue.");
      }
      return null;
    }
    const state = this.#live(snapshot);
    const view = await this.#policyView(state);
    if ((state.grant !== null || state.pendingGrant !== null) && this.#now() >= view.consentDeadline) {
      throw new ReplicaError(ReplicaErrorCode.CONSENT_EXPIRED, "The replica consent window ended.");
    }
    return {
      ...state,
      grant: this.#cappedGrant(state.grant, view),
      pendingGrant: this.#cappedGrant(state.pendingGrant, view),
      grantPolicyView: view,
    };
  }

  async init(config: ReplicaConfig): Promise<void> {
    const created = await this.#commitMeta((state, row) => {
      if (state !== undefined) return null;
      const now = new Date(this.#now()).toISOString();
      const generation = row?.purged === true ? row.generation + 1 : 0;
      return {
        config, grant: null, pendingGrant: null, nodeDid: null, authority: null,
        revoked: null, retentionRevoked: null, pendingGrantError: null, cursor: null,
        coverage: "empty" as const, generation, createdAt: now, lastSyncAt: null,
        lastCompleteAt: null, lastError: null, lastReset: null, leaseToken: 0,
        leaseHolder: null, leaseExpiresAt: null, writerEpoch: 0, writerHolder: null,
        serial: 0, purgePending: false, syncedThroughEpoch: 0, syncCompletedAt: null,
      } satisfies Live;
    }, {
      initial: true,
      apply: (_state, result) => result,
      index: async (tx, result) => result === null ? undefined : {
        deviceDeltaBytes: 0,
        commit: () => this.#gate.indexPartition(tx, this.#index),
      },
    });
    if (created !== null) this.#generation = created.generation;
  }

  /** Changing a retention CID clears only its old attested window. */
  async setRetentionGrant(cid: string | null): Promise<void> {
    await this.#commitMeta((state) => {
      const current = state!;
      if (current.config.retentionGrantCid === cid) return false;
      current.config = { ...current.config, retentionGrantCid: cid, localReadPolicy: cid === null ? "whileGrantValid" : "retainAfterExpiry" };
      if (current.authority !== null) current.authority = { ...current.authority, retainUntil: null };
      return true;
    }, { apply: (state, changed) => changed ? state : null });
  }

  async installGrant(grant: GrantRecord): Promise<void> {
    const timestampKey = `${GRANT_INSTALL_KEY_PREFIX}${this.#identityKeyHash}:${await opaqueId(this.#hmac, "grantInstall", this.#identityKeyHash, grant.cid)}`;
    const priorState = this.#live(await this.#snapshot());
    if (priorState.grant?.cid === grant.cid || priorState.pendingGrant?.cid === grant.cid) {
      const installed = await this.#run([KV_STORE.device], "readonly", (tx) =>
        requestAsPromise<SealedRecord | undefined>(tx.objectStore(KV_STORE.device).get(timestampKey)));
      if (await this.#stamp(installed, timestampKey) === undefined) {
        throw new ReplicaError(ReplicaErrorCode.GRANT_EXPIRED, "The original install time for this grant is missing.");
      }
    }
    const anchorKey = FIRST_INSTALL_KEY_PREFIX + this.#identityKeyHash;
    const installedAt = this.#now();
    const stampEnvelope = await seal(this.#aes, encodeJson({ at: installedAt }), `device\0${timestampKey}`);
    const stampRow = { ...stampEnvelope, size: 0 };
    stampRow.size = measureSealedRow(timestampKey, stampRow);
    const anchorEnvelope = await seal(this.#aes, encodeJson({ at: installedAt }), `device\0${anchorKey}`);
    const anchorRow = { ...anchorEnvelope, size: 0 };
    anchorRow.size = measureSealedRow(anchorKey, anchorRow);
    await this.#commitMeta((state) => {
      const current = state!;
      if (current.grant?.cid === grant.cid || current.pendingGrant?.cid === grant.cid) return false;
      current.pendingGrant = grant;
      current.pendingGrantError = null;
      return true;
    }, {
      apply: (state, changed) => changed ? state : null,
      stores: [KV_STORE.device],
      index: async (tx) => {
        const device = tx.objectStore(KV_STORE.device);
        const prior = await requestAsPromise<SealedRecord | undefined>(device.get(timestampKey));
        const anchor = await requestAsPromise<SealedRecord | undefined>(device.get(anchorKey));
        return {
          deviceDeltaBytes: (prior === undefined ? stampRow.size : 0) + (anchor === undefined ? anchorRow.size : 0),
          commit: () => {
            if (prior === undefined) device.put(stampRow, timestampKey);
            if (anchor === undefined) device.put(anchorRow, anchorKey);
          },
        };
      },
    });
  }

  async claimWriterLock(): Promise<void> {
    await this.#commitMeta((state) => {
      const current = state!;
      current.writerEpoch += 1;
      current.writerHolder = this.#holder;
      if (current.leaseHolder !== null && current.leaseHolder !== this.#holder) {
        current.leaseHolder = null;
        current.leaseExpiresAt = null;
      }
    });
  }

  async acquireSyncLease(ttlMs: number): Promise<LeaseToken | null> {
    return this.#commitMeta((state) => {
      const current = state!;
      if (current.leaseHolder !== null && current.leaseExpiresAt !== null && current.leaseExpiresAt > this.#now()) return null;
      current.writerEpoch += 1;
      current.writerHolder = this.#holder;
      current.leaseToken += 1;
      current.leaseHolder = this.#holder;
      current.leaseExpiresAt = this.#now() + ttlMs;
      return { token: current.leaseToken, holder: this.#holder };
    }, { apply: (state, lease) => lease === null ? null : state });
  }

  async renewLease(token: LeaseToken, ttlMs = 120_000): Promise<void> {
    await this.#commitMeta((state) => {
      this.#fence(state!, token);
      state!.leaseExpiresAt = this.#now() + ttlMs;
    });
  }

  async releaseLease(token: LeaseToken): Promise<void> {
    await this.#commitMeta((state) => {
      const current = state!;
      if (current.leaseToken !== token.token || current.leaseHolder !== token.holder) return false;
      current.leaseHolder = null;
      current.leaseExpiresAt = null;
      return true;
    }, { apply: (state, released) => released ? state : null });
  }

  async completeSync(token: LeaseToken, syncStartEpoch: number): Promise<void> {
    await this.#commitMeta(async (state) => {
      this.#fence(state!, token);
      const view = await this.#policyView(state!);
      const cid = state!.grant?.cid;
      state!.syncedThroughEpoch = syncStartEpoch;
      state!.syncCompletedAt = new Date(this.#now()).toISOString();
      return {
        consentDeadline: view.consentDeadline,
        grantDeadline: cid === undefined ? Number.NEGATIVE_INFINITY :
          view.grants[cid]?.effectiveExpiresAt ?? Number.NEGATIVE_INFINITY,
      };
    }, {
      check: (_state, deadlines) => {
        const now = this.#now();
        if (now >= deadlines.consentDeadline) throw new ReplicaError(ReplicaErrorCode.CONSENT_EXPIRED, "Consent expired before sync completed.");
        if (now >= deadlines.grantDeadline) throw new ReplicaError(ReplicaErrorCode.GRANT_EXPIRED, "The grant expired before sync completed.");
      },
    });
  }

  async syncFence(): Promise<{ syncedThroughEpoch: number; syncCompletedAt: string | null }> {
    const state = this.#live(await this.#snapshot());
    return { syncedThroughEpoch: state.syncedThroughEpoch, syncCompletedAt: state.syncCompletedAt };
  }

  async commitSerial(): Promise<number> {
    const state = this.#live(await this.#snapshot());
    return state.serial;
  }

  async recordError(error: ReplicaLastError): Promise<void> {
    await this.#commitMeta((state) => { state!.lastError = error; });
  }

  async recordPendingGrantError(cid: string, error: ReplicaLastError): Promise<void> {
    await this.#commitMeta((state) => {
      if (state!.pendingGrant?.cid !== cid) return false;
      state!.pendingGrantError = error;
      return true;
    }, { apply: (state, changed) => changed ? state : null });
  }

  async discardPendingGrant(cid: string, detail: string): Promise<void> {
    await this.#commitMeta((state) => {
      if (state!.pendingGrant?.cid !== cid) return false;
      state!.pendingGrant = null;
      state!.pendingGrantError = null;
      state!.lastError = { at: new Date(this.#now()).toISOString(), code: ReplicaErrorCode.GRANT_REVOKED, message: detail };
      return true;
    }, { apply: (state, changed) => changed ? state : null });
  }

  async markRetentionRevoked(cid: string, detail: string): Promise<void> {
    await this.#commitMeta((state) => {
      const current = state!;
      if (current.config.retentionGrantCid === cid) {
        current.config = { ...current.config, retentionGrantCid: null, localReadPolicy: "whileGrantValid" };
        if (current.authority !== null) current.authority = { ...current.authority, retainUntil: null };
        current.retentionRevoked = detail;
      }
      current.lastError = { at: new Date(this.#now()).toISOString(), code: ReplicaErrorCode.RETENTION_GRANT_REFUSED, message: detail };
    });
  }

  async applyPage(token: LeaseToken, page: VerifiedPage): Promise<void> {
    const signedPromotion = page.promoteGrant === null ? null : parseUcanGrant(page.promoteGrant.bytes);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = await this.#snapshot();
      const state = this.#live(snapshot);
      this.#fence(state, token);
      const view = await this.#policyView(state);
      const servingCid = signedPromotion?.cid ?? state.grant?.cid;
      const grantDeadline = servingCid === undefined ? Number.NEGATIVE_INFINITY :
        view.grants[servingCid]?.effectiveExpiresAt ?? Number.NEGATIVE_INFINITY;
      const latest = new Map(page.changes.map((change) => [change.key, change]));
      const prepared = await Promise.all([...latest.values()].map(async (change) => ({
        change,
        id: await opaqueId(this.#hmac, "entries", this.#pid, change.key),
        hashId: change.deleted ? undefined : await opaqueId(this.#hmac, "blobs", this.#pid, change.hash),
      })));
      const heldIds = [...new Set(prepared.filter(({ change }) =>
        !change.deleted && change.content && !page.blobs.has(change.hash)).map(({ hashId }) => hashId)
        .filter((id): id is string => id !== undefined))];
      const [oldEntries, oldBlobs] = await this.#run([KV_STORE.entries, KV_STORE.blobs], "readonly", async (tx) => {
        const entries = tx.objectStore(KV_STORE.entries);
        const blobs = tx.objectStore(KV_STORE.blobs);
        return Promise.all([
          Promise.all(prepared.map(({ id }) => requestAsPromise<SealedEntry | undefined>(entries.get([this.#pid, id])))),
          Promise.all(heldIds.map((id) => requestAsPromise<SealedBlob | undefined>(blobs.get([this.#pid, id])))),
        ]);
      });
      const entriesById = new Map<string, Entry>();
      for (const [index, row] of oldEntries.entries()) {
        if (row !== undefined) {
          const id = prepared[index]!.id;
          entriesById.set(id, await this.#entry([this.#pid, id], row));
        }
      }
      const blobsById = new Map<string, SealedBlob>();
      for (const [index, row] of oldBlobs.entries()) {
        if (row === undefined) continue;
        const id = heldIds[index]!;
        if (row.pid !== this.#pid) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "Invalid replica blob partition.");
        rowSize([this.#pid, id], row);
        blobsById.set(id, row);
      }
      const newBlobs = await Promise.all([...page.blobs].map(async ([hash, bytes]) => {
        const id = await opaqueId(this.#hmac, "blobs", this.#pid, hash);
        const sealed = await seal(this.#aes, encodeBlob(hash, bytes), this.#context("blobs", id));
        const row = { pid: this.#pid, ...sealed };
        return { id, row: { ...row, size: measureSealedRow([this.#pid, id], row) }, contentLength: bytes.length };
      }));
      const available = new Map(newBlobs.map(({ id, contentLength }) => [id, contentLength]));
      const counters = {
        keys: snapshot.row!.keys, contentMissing: snapshot.row!.contentMissing,
        tombstones: snapshot.row!.tombstones, contentBytes: snapshot.row!.contentBytes,
      };
      const newEntries: Array<{ id: string; row: SealedEntry }> = [];
      for (const { change, id, hashId: changedHashId } of prepared) {
        const previous = entriesById.get(id);
        if (previous !== undefined) {
          if (previous.deleted) counters.tombstones -= 1;
          else {
            counters.keys -= 1;
            if (previous.content) counters.contentBytes -= previous.size ?? 0;
            else counters.contentMissing -= 1;
          }
        }
        let entry: Entry;
        let hashId: string | undefined;
        if (change.deleted) {
          entry = { key: change.key, deleted: true };
          counters.tombstones += 1;
        } else {
          hashId = changedHashId!;
          let length = available.get(hashId);
          if (change.content && length === undefined) {
            const old = blobsById.get(hashId);
            if (old !== undefined) {
              const content = decodeBlob(await openSealed(this.#aes, old, this.#context("blobs", hashId)));
              if (content.hash !== change.hash) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "Stored content hash differs from the feed.");
              length = content.bytes.length;
              available.set(hashId, length);
            }
          }
          if (change.content && length === undefined) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "No committed content backs a feed entry.");
          entry = { ...change, size: change.content ? length! : null };
          counters.keys += 1;
          if (change.content) counters.contentBytes += length!;
          else counters.contentMissing += 1;
        }
        const sealed = await seal(this.#aes, encodeJson(entry), this.#context("entries", id, hashId));
        const fields = { pid: this.#pid, ...(hashId === undefined ? {} : { hashId }), ...sealed };
        newEntries.push({ id, row: { ...fields, size: measureSealedRow([this.#pid, id], fields) } });
      }
      state.cursor = page.cursor;
      state.coverage = page.coverage;
      state.serial += 1;
      if (page.authority !== null) {
        state.nodeDid = page.source.nodeDid;
        const retainUntil = state.config.retentionGrantCid === page.retentionGrantCid
          ? page.authority.retainUntil : state.authority?.retainUntil ?? null;
        state.authority = { ...page.authority, retainUntil };
        state.lastSyncAt = page.at;
        if (retainUntil !== null) state.retentionRevoked = null;
      }
      if (page.complete) {
        state.lastCompleteAt = page.at;
        state.lastError = null;
      }
      if (signedPromotion !== null) {
        state.grant = state.pendingGrant?.cid === signedPromotion.cid ? state.pendingGrant
          : state.grant?.cid === signedPromotion.cid ? state.grant : signedPromotion;
        if (state.pendingGrant?.cid === signedPromotion.cid) {
          state.pendingGrant = null;
          state.pendingGrantError = null;
        }
      }
      const meta = await this.#sealedMeta(state, snapshot.row, counters);
      const freeBytes = await this.#ledger.freeBytes();
      try {
        await this.#run([KV_STORE.meta, KV_STORE.entries, KV_STORE.blobs], "readwrite", async (tx) => {
          const metaStore = tx.objectStore(KV_STORE.meta);
          const current = await requestAsPromise<SealedMeta | undefined>(metaStore.get(this.#pid));
          if (current?.revision !== snapshot.row?.revision) throw CONFLICT;
          this.#fence(state, token);
          if ((page.window.notBefore !== null && !isInstant(page.window.notBefore)) ||
              (page.window.expiresAt !== null && !isInstant(page.window.expiresAt))) {
            throw new ReplicaError(ReplicaErrorCode.PROTOCOL_ERROR, "Invalid node-attested authority window.");
          }
          const now = this.#now();
          if (now >= view.consentDeadline) {
            throw new ReplicaError(ReplicaErrorCode.CONSENT_EXPIRED, "The replica consent window ended before the feed page committed.");
          }
          if (now >= grantDeadline) {
            throw new ReplicaError(ReplicaErrorCode.GRANT_EXPIRED, "The replica's effective grant expired before the feed page committed.");
          }
          if (page.window.notBefore !== null && now < Date.parse(page.window.notBefore)) {
            throw new ReplicaError(ReplicaErrorCode.GRANT_NOT_YET_VALID, "The grant is not yet valid; no page was committed.");
          }
          if (page.window.expiresAt !== null && now >= Date.parse(page.window.expiresAt)) {
            throw new ReplicaError(ReplicaErrorCode.GRANT_EXPIRED, "The grant expired; no page was committed.");
          }
          const entries = tx.objectStore(KV_STORE.entries);
          const blobs = tx.objectStore(KV_STORE.blobs);
          let deltaBytes = meta.size - rowSize(this.#pid, current!);
          for (const { id, row } of newEntries) {
            const key: IDBValidKey = [this.#pid, id];
            const old = await requestAsPromise<SealedEntry | undefined>(entries.get(key));
            deltaBytes += row.size - (old === undefined ? 0 : rowSize(key, old));
          }
          for (const { id, row } of newBlobs) {
            const key: IDBValidKey = [this.#pid, id];
            const old = await requestAsPromise<SealedBlob | undefined>(blobs.get(key));
            deltaBytes += row.size - (old === undefined ? 0 : rowSize(key, old));
          }
          await this.#ledger.admitPage(tx, { partitionId: this.#pid, deltaBytes, freeBytes });
          for (const { id, row } of newBlobs) blobs.put(row, [this.#pid, id]);
          for (const { id, row } of newEntries) entries.put(row, [this.#pid, id]);
          metaStore.put(meta, this.#pid);
          await this.#ledger.accountCommit(tx, { partitionId: this.#pid, deltaBytes });
        });
        return;
      } catch (error) {
        if (error !== CONFLICT) throw error;
      }
    }
    throw new ReplicaError(ReplicaErrorCode.BUSY, "The replica changed while preparing an encrypted feed page.");
  }

  /** Reset and learned revocation both erase rows under the same revision and quota transaction. */
  async #eraseRows(change: (state: Live) => void, token?: LeaseToken, adoptGeneration = false): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = await this.#snapshot();
      if (snapshot.state === undefined && token === undefined) return;
      const state = this.#live(snapshot);
      if (token !== undefined) this.#fence(state, token);
      change(state);
      const row = await this.#sealedMeta(state, snapshot.row, { keys: 0, contentMissing: 0, tombstones: 0, contentBytes: 0 });
      const freeBytes = await this.#ledger.freeBytes();
      try {
        await this.#run([KV_STORE.meta, KV_STORE.entries, KV_STORE.blobs], "readwrite", async (tx) => {
          const meta = tx.objectStore(KV_STORE.meta);
          const old = await requestAsPromise<SealedMeta | undefined>(meta.get(this.#pid));
          if (old?.revision !== snapshot.row?.revision) throw CONFLICT;
          if (token !== undefined) this.#fence(state, token);
          const entries = await scanRows(tx, KV_STORE.entries, this.#pid);
          const blobs = await scanRows(tx, KV_STORE.blobs, this.#pid);
          let deltaBytes = row.size - rowSize(this.#pid, old!);
          for (const { key, value } of entries) deltaBytes -= rowSize(key, value);
          for (const { key, value } of blobs) deltaBytes -= rowSize(key, value);
          await this.#ledger.admitPage(tx, { partitionId: this.#pid, deltaBytes, freeBytes });
          const range = IDBKeyRange.bound([this.#pid], [this.#pid, RANGE_END]);
          tx.objectStore(KV_STORE.entries).delete(range);
          tx.objectStore(KV_STORE.blobs).delete(range);
          meta.put(row, this.#pid);
          await this.#ledger.accountCommit(tx, { partitionId: this.#pid, deltaBytes });
        });
        if (adoptGeneration) this.#generation = state.generation;
        return;
      } catch (error) {
        if (error !== CONFLICT) throw error;
      }
    }
    throw new ReplicaError(ReplicaErrorCode.BUSY, "The replica changed while preparing its encrypted erase.");
  }

  async reset(token: LeaseToken, reason: string, options?: { keepSource?: boolean }): Promise<void> {
    await this.#eraseRows((state) => {
      state.cursor = null;
      if (options?.keepSource !== true) state.nodeDid = null;
      state.coverage = "empty";
      state.lastSyncAt = null;
      state.lastCompleteAt = null;
      state.lastError = null;
      state.lastReset = { at: new Date(this.#now()).toISOString(), reason };
      state.generation += 1;
    }, token, true);
  }

  async markRevoked(detail: string): Promise<void> {
    await this.#eraseRows((state) => {
      state.cursor = null;
      state.coverage = "empty";
      state.lastSyncAt = null;
      state.lastCompleteAt = null;
      state.writerEpoch += 1;
      state.writerHolder = null;
      state.leaseToken += 1;
      state.leaseHolder = null;
      state.leaseExpiresAt = null;
      state.revoked = detail;
      state.lastError = { at: new Date(this.#now()).toISOString(), code: ReplicaErrorCode.GRANT_REVOKED, message: detail };
      // The erase and fence committed together, so there is no unfinished purge to replay.
      state.purgePending = false;
    });
  }

  async collectGarbage(token: LeaseToken): Promise<number> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = await this.#snapshot();
      const state = this.#live(snapshot);
      this.#fence(state, token);
      const [entries, blobs] = await this.#run([KV_STORE.entries, KV_STORE.blobs], "readonly", (tx) =>
        Promise.all([scanRows(tx, KV_STORE.entries, this.#pid), scanRows(tx, KV_STORE.blobs, this.#pid)]));
      const keep = new Set<string>();
      for (const { key, value } of entries) {
        const entry = await this.#entry(key, value as SealedEntry);
        if (!entry.deleted && entry.content) keep.add((value as SealedEntry).hashId!);
      }
      const remove = blobs.filter(({ key }) => Array.isArray(key) && typeof key[1] === "string" && !keep.has(key[1]));
      if (remove.length === 0) return 0;
      const meta = await this.#sealedMeta(state, snapshot.row);
      const freeBytes = await this.#ledger.freeBytes();
      try {
        await this.#run([KV_STORE.meta, KV_STORE.blobs], "readwrite", async (tx) => {
          const metaStore = tx.objectStore(KV_STORE.meta);
          const old = await requestAsPromise<SealedMeta | undefined>(metaStore.get(this.#pid));
          if (old?.revision !== snapshot.row?.revision) throw CONFLICT;
          this.#fence(state, token);
          const blobStore = tx.objectStore(KV_STORE.blobs);
          let deltaBytes = meta.size - rowSize(this.#pid, old!);
          for (const { key } of remove) {
            const row = await requestAsPromise<SealedBlob | undefined>(blobStore.get(key));
            if (row !== undefined) deltaBytes -= rowSize(key, row);
          }
          await this.#ledger.admitPage(tx, { partitionId: this.#pid, deltaBytes, freeBytes });
          for (const { key } of remove) blobStore.delete(key);
          metaStore.put(meta, this.#pid);
          await this.#ledger.accountCommit(tx, { partitionId: this.#pid, deltaBytes });
        });
        return remove.length;
      } catch (error) {
        if (error !== CONFLICT) throw error;
      }
    }
    throw new ReplicaError(ReplicaErrorCode.BUSY, "The replica changed while preparing encrypted garbage collection.");
  }

  async #entry(key: IDBValidKey, value: SealedEntry): Promise<Entry> {
    if (!Array.isArray(key) || key.length !== 2 || key[0] !== this.#pid || typeof key[1] !== "string" || value.pid !== this.#pid) {
      throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "An encrypted replica entry has the wrong partition or key.");
    }
    rowSize(key, value);
    const entry = decodeJson<Entry>(await openSealed(this.#aes, value, this.#context("entries", key[1], value.hashId)));
    if (typeof entry.key !== "string" || typeof entry.deleted !== "boolean") {
      throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "An encrypted replica entry is corrupt.");
    }
    return entry;
  }

  async #allEntries(): Promise<Entry[]> {
    const rows = await this.#run([KV_STORE.entries], "readonly", (tx) => scanRows(tx, KV_STORE.entries, this.#pid));
    return Promise.all(rows.map(({ key, value }) => this.#entry(key, value as SealedEntry)));
  }

  async get(key: string): Promise<LocalEntry | undefined> {
    await this.#serving();
    const id = await opaqueId(this.#hmac, "entries", this.#pid, key);
    const row = await this.#run([KV_STORE.entries], "readonly", (tx) =>
      requestAsPromise<SealedEntry | undefined>(tx.objectStore(KV_STORE.entries).get([this.#pid, id])));
    return row === undefined ? undefined : this.#entry([this.#pid, id], row);
  }

  async list(options: ListOpts): Promise<LocalEntry[]> {
    await this.#serving();
    const entries = (await this.#allEntries()).filter((entry) =>
      !entry.deleted && (options.prefix === undefined || entry.key.startsWith(options.prefix)) &&
      (options.after === undefined || compareKeyBytes(entry.key, options.after) > 0));
    entries.sort((a, b) => compareKeyBytes(a.key, b.key));
    return options.limit === undefined ? entries : entries.slice(0, options.limit);
  }

  async pendingRepairs(limit: number): Promise<Array<Extract<LocalEntry, { deleted: false }>>> {
    this.#live(await this.#snapshot());
    const entries = (await this.#allEntries()).filter((entry): entry is Extract<Entry, { deleted: false }> =>
      !entry.deleted && !entry.content);
    entries.sort((a, b) => compareKeyBytes(a.key, b.key));
    return entries.slice(0, limit);
  }

  async hasContent(hashes: string[]): Promise<Set<string>> {
    this.#live(await this.#snapshot());
    const ids = await Promise.all(hashes.map((hash) => opaqueId(this.#hmac, "blobs", this.#pid, hash)));
    const present = await this.#run([KV_STORE.blobs], "readonly", async (tx) => {
      const blobs = tx.objectStore(KV_STORE.blobs);
      return Promise.all(ids.map((id) => requestAsPromise<number>(blobs.count([this.#pid, id]))));
    });
    return new Set(hashes.filter((_hash, index) => (present[index] ?? 0) > 0));
  }

  async readContent(hash: string): Promise<Uint8Array | undefined> {
    await this.#serving();
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    const id = await opaqueId(this.#hmac, "blobs", this.#pid, hash);
    const key: IDBValidKey = [this.#pid, id];
    const row = await this.#run([KV_STORE.blobs], "readonly", (tx) =>
      requestAsPromise<SealedBlob | undefined>(tx.objectStore(KV_STORE.blobs).get(key)));
    if (row === undefined) return undefined;
    if (row.pid !== this.#pid) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The encrypted replica blob belongs to another partition.");
    rowSize(key, row);
    const content = decodeBlob(await openSealed(this.#aes, row, this.#context("blobs", id)));
    if (content.hash !== hash) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The encrypted replica blob's hash does not match its key.");
    return content.bytes;
  }

  async status(now = this.#now()): Promise<ReplicaStatus> {
    const snapshot = await this.#snapshot();
    const state = this.#live(snapshot);
    const view = await this.#policyView(state);
    const { retentionRevoked: _retentionRevoked, ...authority } = effectiveAuthority({
      window: state.authority, grant: this.#cappedGrant(state.grant, view), revoked: state.revoked,
      retentionRevoked: state.retentionRevoked, policy: state.config.localReadPolicy, now,
    });
    const row = snapshot.row!;
    return {
      name: state.config.name,
      replicaId: this.#pid,
      source: { host: state.config.host, nodeDid: state.nodeDid, space: state.config.space, prefix: state.config.prefix },
      device: {
        did: state.config.deviceDid, delegationCid: state.grant?.cid ?? null,
        pendingDelegationCid: state.pendingGrant?.cid ?? null, pendingDelegationError: state.pendingGrantError,
      },
      authority: {
        ...authority, localReadPolicy: state.config.localReadPolicy, retentionGrantCid: state.config.retentionGrantCid,
        revokedDetail: state.revoked, retentionRevokedDetail: state.retentionRevoked,
      },
      consistency: "observed", coverage: state.coverage, lastSyncAt: state.lastSyncAt,
      lastCompleteAt: state.lastCompleteAt,
      counts: { keys: row.keys, contentMissing: row.contentMissing, tombstones: row.tombstones },
      bytes: row.contentBytes, durability: DURABILITY,
      syncing: state.leaseHolder !== null && state.leaseExpiresAt !== null && state.leaseExpiresAt > now,
      purgePending: state.purgePending, lastError: state.lastError, lastReset: state.lastReset,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
