/**
 * Identity-scoped pending writes: private gate-HMAC row names and Web Locks,
 * account-key sealed content, and gated compare-and-swap transactions.
 * A missing key or moved gate never falls back to an unlocked/plaintext store.
 */
import {
  canonicalReplicationIdentity,
  replicationIdentityKey,
  type PendingWriteState,
  type PendingWriteStore,
  type ReplicaBrowserGateAccess,
  type ReplicaSessionStamp,
  type ReplicationIdentity,
} from "@tinycloud/sdk-services/kv/replication";
import { REPLICA_PENDING_LOCK_PREFIX } from "@tinycloud/sdk-services/kv/replication/contractConstants";

import { ReplicaError, ReplicaErrorCode, gatedError } from "../errors.js";
import { requestAsPromise } from "../browser/idb.js";
import { decodeJson, encodeJson } from "./codec.js";
import { gateHash } from "./gateKeys.js";
import type { BrowserReplicaGateTx } from "./gateTx.js";
import { KV_STORE } from "./schema.js";
import { measureSealedRow, openSealed, seal, type SealedRecord } from "./sealed.js";

type SealedPending = SealedRecord & { size: number };

type Locks = Pick<LockManager, "request">;

function corrupt(message: string): ReplicaError {
  return new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, message);
}

export class IndexedDbPendingWriteStore implements PendingWriteStore {
  readonly durable = true;
  readonly identity: ReplicationIdentity;
  readonly #identityKey: string;
  readonly #gateTx: BrowserReplicaGateTx | undefined;
  readonly #stamp: ReplicaSessionStamp | undefined;
  readonly #locks: Locks | undefined;

  constructor(identity: ReplicationIdentity, options: { gateTx?: BrowserReplicaGateTx; stamp?: ReplicaSessionStamp; locks?: Locks } = {}) {
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

  async #access(): Promise<{ gateTx: BrowserReplicaGateTx; access: ReplicaBrowserGateAccess; id: string }> {
    const gateTx = this.#gateTx;
    if (gateTx === undefined) throw gatedError("gate_unavailable", "No lifecycle gate is wired into the pending-write store.");
    const stamp = this.#stamp;
    if (stamp === undefined) throw gatedError("not_established", "The pending-write store has no session stamp.");
    const snapshot = await gateTx.snapshot();
    if (snapshot === null) throw gatedError("not_established", "No replica gate exists on this origin yet.");
    const identityKeyHash = await gateHash(snapshot.gateHmac, "identity", this.#identityKey);
    const principalHash = await gateHash(snapshot.gateHmac, "principal", this.identity.principal.toLowerCase());
    return {
      gateTx,
      id: identityKeyHash,
      access: {
        stamp, incarnation: snapshot.incarnation, keyId: snapshot.keyId,
        accountKeyId: snapshot.accountKeyId, principalHash, identityKeyHash,
      },
    };
  }

  async #stored(): Promise<PendingWriteState | undefined> {
    const gated = await this.#access();
    const { gateTx, access, id } = gated;
    const row = await gateTx.run({ stores: [KV_STORE.pending], mode: "readonly" }, access, (tx) =>
      requestAsPromise<SealedPending | undefined>(tx.objectStore(KV_STORE.pending).get(id)));
    if (row === undefined) return undefined;
    const account = await gateTx.readAccountKey(access);
    return this.#parse(decodeJson(await openSealed(account.aesGcm, row, `pending\0${id}`)));
  }

  async read(): Promise<PendingWriteState> {
    return (await this.#stored()) ?? this.#empty();
  }

  async readExisting(): Promise<PendingWriteState | undefined> {
    return this.#stored();
  }

  async update<T>(mutate: (state: PendingWriteState) => T): Promise<T> {
    const gated = await this.#access();
    const { gateTx, access, id } = gated;
    if (this.#locks === undefined) throw gatedError("gate_unavailable", "Web Locks are required for pending-write mutations.");
    const section = async (): Promise<T> => {
      const old = await gateTx.run({ stores: [KV_STORE.pending], mode: "readonly" }, access, (tx) =>
        requestAsPromise<SealedPending | undefined>(tx.objectStore(KV_STORE.pending).get(id)));
      const account = await gateTx.readAccountKey(access);
      const state = old === undefined ? this.#empty() : this.#parse(decodeJson(await openSealed(account.aesGcm, old, `pending\0${id}`)));
      const result = mutate(state);
      const sealed = await seal(account.aesGcm, encodeJson(state), `pending\0${id}`);
      const row = { ...sealed, size: 0 };
      row.size = measureSealedRow(id, row);
      await gateTx.run({ stores: [KV_STORE.pending], mode: "readwrite" }, access, async (tx) => {
        const pending = tx.objectStore(KV_STORE.pending);
        const current = await requestAsPromise<SealedPending | undefined>(pending.get(id));
        if ((old === undefined) !== (current === undefined) ||
            (old !== undefined && current !== undefined &&
             (old.iv.length !== current.iv.length || old.iv.some((byte, index) => byte !== current.iv[index])))) {
          throw new ReplicaError(ReplicaErrorCode.BUSY, "The pending-write state changed during its sealed mutation.");
        }
        pending.put(row, id);
      });
      return result;
    };
    return this.#locks.request(`${REPLICA_PENDING_LOCK_PREFIX}${id}`, section) as Promise<T>;
  }
}
