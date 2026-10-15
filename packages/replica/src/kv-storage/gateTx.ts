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
  ReplicaAccountGate,
  ReplicaGateAccess,
  ReplicaGateReason,
  ReplicaGateScope,
  ReplicaGateSnapshot,
  ReplicaGateTx,
  ReplicaPartitionIndexEntry,
} from "@tinycloud/sdk-services/kv/replication";

import { gatedError } from "../errors.js";
import { requestAsPromise, transactionDone } from "../browser/idb.js";
import { saltedHash } from "../profile-gate/saltedHash.js";
import { KV_STORE } from "./schema.js";

const ACCOUNT = "account";
const CONTROL = [KV_STORE.gate, KV_STORE.partitions, KV_STORE.purgeIntents, KV_STORE.quota];

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

export function createIndexedDbGateTx(open: KvDatabaseOpener): ReplicaGateTx<IDBTransaction> {
  // Read-only and outside any data transaction: the salt and epoch needed to
  // derive salted ids before `run` opens its transaction.
  async function snapshot(): Promise<ReplicaGateSnapshot | null> {
    return withDatabase(open, false, async (db) => {
      const gate = await requestAsPromise<ReplicaAccountGate | undefined>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get(ACCOUNT));
      return gate === undefined ? null : { incarnation: gate.incarnation, salt: gate.salt, lifecycleEpoch: gate.lifecycleEpoch };
    });
  }

  return {
    snapshot,

    async run<T>(scope: ReplicaGateScope, access: ReplicaGateAccess, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
      const current = await snapshot();
      if (current === null) throw refusal("not_established");
      // The salt belongs to the incarnation. The in-transaction check below
      // compares the incarnation first, so a salt read from a replaced gate
      // is refused as `stamp_stale` before any principal comparison.
      const principalHash = await saltedHash(current.salt, access.principal.toLowerCase());

      const result = await withDatabase(open, true, async (db) => {
        const tx = db.transaction([...scope.stores, ...CONTROL], scope.mode, { durability: "strict" });
        const done = transactionDone(tx);
        try {
          const gate = await requestAsPromise<ReplicaAccountGate | undefined>(tx.objectStore(KV_STORE.gate).get(ACCOUNT));
          if (gate === undefined) throw refusal("not_established");
          if (gate.incarnation !== access.incarnation || gate.incarnation !== access.stamp.incarnation || gate.lifecycleEpoch !== access.stamp.lifecycleEpoch) {
            throw refusal("stamp_stale");
          }
          if (gate.principalHash !== principalHash) throw refusal("principal_mismatch");
          const intents = tx.objectStore(KV_STORE.purgeIntents);
          if (access.partitionId !== undefined && (await requestAsPromise(intents.count(access.partitionId))) > 0) throw refusal("purge_pending");
          if (access.identityKeyHash !== undefined && (await requestAsPromise(intents.count(`pending:${access.identityKeyHash}`))) > 0) {
            throw refusal("purge_pending");
          }
          const value = await fn(tx);
          await done;
          return { value };
        } catch (error) {
          try {
            tx.abort();
          } catch {
            // Already finished.
          }
          await done.catch(() => undefined);
          throw error;
        }
      });
      if (result === null) throw refusal("gate_unavailable");
      return result.value;
    },

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
