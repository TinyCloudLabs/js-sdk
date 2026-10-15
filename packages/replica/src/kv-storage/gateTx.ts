/**
 * The browser `ReplicaGateTx` over the origin database's control stores
 * (`gate`, `partitions`, `purgeIntents`, `quota`). Every data transaction goes
 * through `run`, which reads the gate record as its FIRST request and refuses
 * — aborting, so nothing commits — unless the incarnation, the lifecycle epoch
 * and the principal hash all match, and no purge intent covers the partition
 * or identity. `run` resolves only after `oncomplete`.
 *
 * Erase transactions are exempt from `run`: they call `indexPartition`,
 * `unindexPartition` and `clearIntent` on their own transaction.
 */
import type {
  ReplicaBrowserGateAccess,
  ReplicaBrowserGateSnapshot,
  ReplicaGateReason,
  ReplicaGateScope,
  ReplicaGateTx,
  ReplicaPartitionIndexEntry,
  ReplicaDenyOutcome,
} from "@tinycloud/sdk-services/kv/replication";
import { ReplicaError, ReplicaErrorCode, gatedError } from "../errors.js";
import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { ACCOUNT_KEY, GATE_HMAC_KEY, validAccountKey, validGateHmac, type AccountKeyRecord, type BrowserGate, type GateHmacRecord } from "./gateKeys.js";
import { KV_STORE } from "./schema.js";

const ACCOUNT = "account";
const CONTROL = [KV_STORE.gate, KV_STORE.partitions, KV_STORE.purgeIntents, KV_STORE.quota, KV_STORE.device];

/**
 * Opens the origin database. `create` false yields `null` when it does not
 * exist; `create` true creates it (the first `run` may precede any schema).
 */
export type KvDatabaseOpener = (create: boolean) => Promise<IDBDatabase | null>;

function refusal(reason: ReplicaGateReason): Error {
  return gatedError(reason, `The replica gate refused: ${reason}.`);
}

export async function withDatabase<T>(open: KvDatabaseOpener, create: boolean, use: (db: IDBDatabase) => Promise<T>): Promise<T | null> {
  const db = await open(create);
  if (db === null) return null;
  try {
    return await use(db);
  } finally {
    db.close();
  }
}

/** Browser IDs and key ids are precomputed before opening a data transaction. */
export type BrowserGateAccess = ReplicaBrowserGateAccess;
export type BrowserGateSnapshot = ReplicaBrowserGateSnapshot;

export interface BrowserReplicaGateTx extends ReplicaGateTx<IDBTransaction, BrowserGateAccess> {
  snapshot(): Promise<BrowserGateSnapshot | null>;
  readAccountKey(access: BrowserGateAccess): Promise<AccountKeyRecord>;
}

export function createIndexedDbGateTx(
  open: KvDatabaseOpener,
  options: { now?: () => number; onConsentExpired?: () => Promise<ReplicaDenyOutcome> } = {},
): BrowserReplicaGateTx {
  const now = options.now ?? Date.now;
  function checkedNow(): number {
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0) throw refusal("gate_unavailable");
    return at;
  }

  let expiryFlight: Promise<ReplicaDenyOutcome> | undefined;

  async function snapshot(): Promise<BrowserGateSnapshot | null> {
    return withDatabase(open, false, async (db) => {
      const tx = db.transaction([KV_STORE.gate, KV_STORE.device]);
      const gate = await requestAsPromise<BrowserGate | undefined>(tx.objectStore(KV_STORE.gate).get(ACCOUNT));
      if (gate === undefined || gate.principalHash === null) return null;
      if (!Number.isSafeInteger(gate.consentDeadline) || gate.consentDeadline < 0) throw refusal("gate_unavailable");
      const hash = await requestAsPromise<GateHmacRecord | undefined>(tx.objectStore(KV_STORE.device).get(GATE_HMAC_KEY));
      if (!validGateHmac(hash, gate)) throw refusal("gate_unavailable");
      return { incarnation: gate.incarnation, salt: gate.salt, lifecycleEpoch: gate.lifecycleEpoch, keyId: hash.keyId, accountKeyId: gate.accountKeyId, gateHmac: hash.hmac };
    });
  }

  async function expire(access: Pick<BrowserGateAccess, "stamp" | "incarnation">): Promise<void> {
    if (options.onConsentExpired === undefined) throw refusal("gate_unavailable");
    const flight = expiryFlight ?? options.onConsentExpired();
    expiryFlight = flight;
    try {
      const outcome = await flight;
      if (outcome.status !== "denied" && outcome.status !== "deleted" && outcome.status !== "stale") throw refusal("gate_unavailable");
      // `stale` can also mean the main clock has not reached the deadline. Verify that
      // the old incarnation/epoch was actually removed before reporting expiry.
      const gate = await withDatabase(open, false, (db) =>
        requestAsPromise<BrowserGate | undefined>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get(ACCOUNT)),
      );
      if (gate !== null && (gate === undefined ||
          (gate.incarnation === access.incarnation && (gate.lifecycleEpoch <= access.stamp.lifecycleEpoch || gate.principalHash !== null)))) {
        throw refusal("gate_unavailable");
      }
    } finally {
      if (expiryFlight === flight) expiryFlight = undefined;
    }
  }

  async function runChecked<T>(scope: ReplicaGateScope, access: BrowserGateAccess, fn: (tx: IDBTransaction, account: AccountKeyRecord) => Promise<T>): Promise<T> {
    if (access === null || typeof access !== "object" || access.stamp === null || typeof access.stamp !== "object") {
      throw refusal("not_established");
    }
    if (!("principalHash" in access) || typeof access.principalHash !== "string" ||
        !("keyId" in access) || typeof access.keyId !== "string" ||
        !("accountKeyId" in access) || typeof access.accountKeyId !== "string") throw refusal("gate_unavailable");
    try {
      const result = await withDatabase(open, false, async (db) => {
        const tx = db.transaction([...scope.stores, ...CONTROL], scope.mode, { durability: "strict" });
        const done = transactionDone(tx);
        try {
          // The first request is always the gate. No WebCrypto work occurs inside this transaction.
          const gate = await requestAsPromise<BrowserGate | undefined>(tx.objectStore(KV_STORE.gate).get(ACCOUNT));
          if (gate === undefined) throw refusal("not_established");
          if (gate.incarnation !== access.incarnation || gate.incarnation !== access.stamp.incarnation ||
              gate.lifecycleEpoch !== access.stamp.lifecycleEpoch || gate.principalHash === null) throw refusal("stamp_stale");
          if (gate.keyId !== access.keyId || gate.accountKeyId !== access.accountKeyId) throw refusal("stamp_stale");
          if (gate.principalHash !== access.principalHash) throw refusal("principal_mismatch");
          if (!Number.isSafeInteger(gate.consentDeadline) || gate.consentDeadline < 0) throw refusal("gate_unavailable");
          if (checkedNow() >= gate.consentDeadline) throw new ReplicaError(ReplicaErrorCode.CONSENT_EXPIRED, "The account consent has expired.");
          const device = tx.objectStore(KV_STORE.device);
          const hash = await requestAsPromise<GateHmacRecord | undefined>(device.get(GATE_HMAC_KEY));
          const account = await requestAsPromise<AccountKeyRecord | undefined>(device.get(ACCOUNT_KEY));
          if (!validGateHmac(hash, gate) || !validAccountKey(account, gate)) throw refusal("gate_unavailable");
          const intents = tx.objectStore(KV_STORE.purgeIntents);
          if (access.partitionId !== undefined && (await requestAsPromise(intents.count(access.partitionId))) > 0) throw refusal("purge_pending");
          if (access.identityKeyHash !== undefined && (await requestAsPromise(intents.count(`pending:${access.identityKeyHash}`))) > 0) throw refusal("purge_pending");
          const value = await fn(tx, account);
          await done;
          return { value };
        } catch (error) {
          try {
            tx.abort();
          } catch {
            // Already settled.
          }
          await done.catch(() => undefined);
          throw error;
        }
      });
      if (result === null) throw refusal("gate_unavailable");
      return result.value;
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === ReplicaErrorCode.CONSENT_EXPIRED) {
        await expire(access);
      }
      throw error;
    }
  }

  return {
    snapshot,
    run: (scope, access, fn) => runChecked(scope, access, (tx) => fn(tx)),
    readAccountKey: (access) => runChecked({ stores: [KV_STORE.device], mode: "readonly" }, access, async (_tx, account) => account),

    async indexPartition(tx: IDBTransaction, entry: ReplicaPartitionIndexEntry): Promise<void> {
      tx.objectStore(KV_STORE.partitions).put(entry, entry.partitionId);
    },

    async unindexPartition(tx: IDBTransaction, partitionId: string): Promise<void> {
      tx.objectStore(KV_STORE.partitions).delete(partitionId);
    },

    async clearIntent(tx: IDBTransaction, id: string): Promise<void> {
      tx.objectStore(KV_STORE.purgeIntents).delete(id);
    },
  };
}
