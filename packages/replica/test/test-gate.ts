/**
 * A test-only `ReplicaGateTx` over the origin database's control stores, for
 * the adapter's own suites (fake-indexeddb and the Chromium fixture). It is
 * never exported by a package entry: the real gate is the lifecycle slice's
 * `createIndexedDbGateTx`. Like the real one, `run` reads the gate record as
 * its FIRST request inside the transaction it opens and refuses — aborting,
 * so nothing commits — unless the incarnation, the epoch and the principal
 * hash all match, and while a purge intent covers the partition or identity.
 * The salt is fixed per test gate, which is fine for test data.
 */
import type {
  ReplicaAccountGate,
  ReplicaGateAccess,
  ReplicaGateScope,
  ReplicaGateSnapshot,
  ReplicaGateTx,
  ReplicaLifecycleGate,
  ReplicaSessionStamp,
} from "@tinycloud/sdk-services/kv/replication";

import { requestAsPromise, transactionDone } from "../src/browser/idb.js";
import { saltedHash } from "../src/profile-gate/saltedHash.js";
import { KV_STORE, openKvDatabase } from "../src/kv-storage/schema.js";

const CONTROL = [KV_STORE.gate, KV_STORE.partitions, KV_STORE.purgeIntents, KV_STORE.quota];
export const TEST_SALT = "dGVzdC1nYXRlLXNhbHQtdGhpcnR5LXR3by1ieXRlcyE";

function gated(gate: string): Error {
  return Object.assign(new Error(`The test gate refused: ${gate}.`), { code: "REPLICA_GATED", gate });
}

async function withDb<T>(create: boolean, use: (db: IDBDatabase) => Promise<T>): Promise<T | null> {
  const db = await openKvDatabase({ create });
  if (db === null) return null;
  try {
    return await use(db);
  } finally {
    db.close();
  }
}

export type TestGate = ReplicaGateTx<IDBTransaction> & {
  /** Create the gate record if absent and return the stamp for `principal` (a fresh sign-in). */
  establish(principal: string): Promise<ReplicaSessionStamp>;
  /** Sign-out: clear the principal and bump the epoch. */
  deny(): Promise<void>;
  /** Record a purge intent over a stored id. */
  addIntent(intent: { kind: "partition"; partitionId: string } | { kind: "pending"; identityKeyHash: string }): Promise<void>;
};

export function createTestGate(): TestGate {
  return {
    async snapshot(): Promise<ReplicaGateSnapshot | null> {
      return (
        (await withDb(false, async (db) => {
          const gate = await requestAsPromise<ReplicaAccountGate | undefined>(db.transaction(KV_STORE.gate).objectStore(KV_STORE.gate).get("account"));
          return gate === undefined ? null : { incarnation: gate.incarnation, salt: gate.salt, lifecycleEpoch: gate.lifecycleEpoch };
        })) ?? null
      );
    },

    async run<T>(scope: ReplicaGateScope, access: ReplicaGateAccess, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
      // The principal hash is derived before the transaction opens (HMAC is async).
      const principalHash = await saltedHash(TEST_SALT, access.principal.toLowerCase());
      const result = await withDb(true, async (db) => {
        const tx = db.transaction([...scope.stores, ...CONTROL], scope.mode, { durability: "strict" });
        const done = transactionDone(tx);
        try {
          const gate = await requestAsPromise<ReplicaAccountGate | undefined>(tx.objectStore(KV_STORE.gate).get("account"));
          if (gate === undefined) throw gated("not_established");
          if (gate.incarnation !== access.incarnation || gate.incarnation !== access.stamp.incarnation || gate.lifecycleEpoch !== access.stamp.lifecycleEpoch) {
            throw gated("stamp_stale");
          }
          if (gate.principalHash !== principalHash) throw gated("principal_mismatch");
          const intents = tx.objectStore(KV_STORE.purgeIntents);
          if (access.partitionId !== undefined && (await requestAsPromise(intents.count(access.partitionId))) > 0) throw gated("purge_pending");
          if (access.identityKeyHash !== undefined && (await requestAsPromise(intents.count(`pending:${access.identityKeyHash}`))) > 0) throw gated("purge_pending");
          const value = await fn(tx);
          await done;
          return { value };
        } catch (error) {
          try {
            tx.abort();
          } catch {
            // already finished
          }
          await done.catch(() => undefined);
          throw error;
        }
      });
      if (result === null) throw gated("gate_unavailable");
      return result.value;
    },

    async indexPartition(tx, entry) {
      tx.objectStore(KV_STORE.partitions).put(entry, entry.partitionId);
    },
    async unindexPartition(tx, partitionId) {
      tx.objectStore(KV_STORE.partitions).delete(partitionId);
    },
    async clearIntent(tx, id) {
      tx.objectStore(KV_STORE.purgeIntents).delete(id);
    },

    async establish(principal) {
      const principalHash = await saltedHash(TEST_SALT, principal.toLowerCase());
      const stamp = await withDb(true, async (db) => {
        const tx = db.transaction(KV_STORE.gate, "readwrite");
        const done = transactionDone(tx);
        const existing = await requestAsPromise<ReplicaAccountGate | undefined>(tx.objectStore(KV_STORE.gate).get("account"));
        const gate: ReplicaAccountGate = existing ?? { incarnation: crypto.randomUUID(), salt: TEST_SALT, principalHash: null, lifecycleEpoch: 0, deniedAt: null };
        gate.principalHash = principalHash;
        tx.objectStore(KV_STORE.gate).put(gate, "account");
        await done;
        return { incarnation: gate.incarnation, lifecycleEpoch: gate.lifecycleEpoch };
      });
      return stamp!;
    },

    async deny() {
      await withDb(true, async (db) => {
        const tx = db.transaction(KV_STORE.gate, "readwrite");
        const done = transactionDone(tx);
        const gate = await requestAsPromise<ReplicaAccountGate | undefined>(tx.objectStore(KV_STORE.gate).get("account"));
        if (gate !== undefined) tx.objectStore(KV_STORE.gate).put({ ...gate, principalHash: null, lifecycleEpoch: gate.lifecycleEpoch + 1, deniedAt: Date.now() }, "account");
        await done;
      });
    },

    async addIntent(intent) {
      await withDb(true, async (db) => {
        const tx = db.transaction(KV_STORE.purgeIntents, "readwrite");
        const done = transactionDone(tx);
        const id = intent.kind === "partition" ? intent.partitionId : `pending:${intent.identityKeyHash}`;
        tx.objectStore(KV_STORE.purgeIntents).put({ id, ...intent, principalHash: "test", recordedAt: Date.now() }, id);
        await done;
      });
    },
  };
}

/**
 * The main-thread facade the adapter consults (`deliverable`, `pendingPurge`,
 * `activationAllowed`) over a test gate. The sign-in/sign-out protocol
 * methods belong to the lifecycle slice and are not part of these tests.
 */
export function createTestLifecycle(gate: TestGate): ReplicaLifecycleGate & { revoke(stamp: ReplicaSessionStamp): void } {
  const revoked = new Set<string>();
  const unsupported = (name: string) => () => Promise.reject(new Error(`${name} is not part of the adapter's test lifecycle.`));
  return {
    kind: "indexeddb",
    deliverable: (stamp) => !revoked.has(`${stamp.incarnation}:${stamp.lifecycleEpoch}`),
    revoke: (stamp) => void revoked.add(`${stamp.incarnation}:${stamp.lifecycleEpoch}`),
    activationAllowed: async () => true,
    pendingPurge: async () =>
      (await withDb(false, async (db) => requestAsPromise(db.transaction(KV_STORE.purgeIntents).objectStore(KV_STORE.purgeIntents).getAll()))) ?? [],
    establishSessionStamp: (principal) => gate.establish(principal),
    restoreSessionStamp: unsupported("restoreSessionStamp"),
    recover: unsupported("recover"),
    deny: unsupported("deny"),
    erasePending: unsupported("erasePending"),
  };
}
