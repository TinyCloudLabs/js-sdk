/**
 * Test-only gate fixture: real guarded transaction checks over an origin
 * database, with deterministic sign-in/deny helpers instead of a wallet.
 * It never appears in a package entry or a production worker.
 */
import type { ReplicaLifecycleGate, ReplicaSessionStamp } from "@tinycloud/sdk-services/kv/replication";

import { requestAsPromise, transactionDone } from "../src/browser/idb.js";
import { createIndexedDbGateTx, type BrowserReplicaGateTx } from "../src/kv-storage/gateTx.js";
import {
  ACCOUNT_KEY,
  GATE_HMAC_KEY,
  gateHash,
  newAccountKey,
  newGateHmac,
  validAccountKey,
  validGateHmac,
  type AccountKeyRecord,
  type BrowserGate,
  type GateHmacRecord,
} from "../src/kv-storage/gateKeys.js";
import { ledgerFor } from "../src/kv-storage/ledger.js";
import { createIndexedDbLifecycle } from "../src/kv-storage/lifecycle.js";
import { KV_STORE, openKvDatabase } from "../src/kv-storage/schema.js";
const CONSENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
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

export type TestGate = BrowserReplicaGateTx & {
  /** Create the gate record if absent and return the stamp for `principal` (a fresh sign-in). */
  establish(principal: string): Promise<ReplicaSessionStamp>;
  /** Sign-out: clear the principal and bump the epoch. */
  deny(): Promise<void>;
  /** Record a purge intent over a stored id. */
  addIntent(intent: { kind: "partition"; partitionId: string } | { kind: "pending"; identityKeyHash: string }): Promise<void>;
};

export function createTestGate(): TestGate {
  const gate = createIndexedDbGateTx((create) => openKvDatabase({ create }), {
    onConsentExpired: async () => { throw gated("gate_unavailable"); },
  });
  return Object.assign(gate, {
    async establish(principal: string): Promise<ReplicaSessionStamp> {
      const section = async (): Promise<ReplicaSessionStamp> => {
        const existing = await withDb(false, async (db) => {
        const tx = db.transaction([KV_STORE.gate, KV_STORE.device]);
        const account = await requestAsPromise<BrowserGate | undefined>(tx.objectStore(KV_STORE.gate).get("account"));
        const device = tx.objectStore(KV_STORE.device);
        const hash = await requestAsPromise<GateHmacRecord | undefined>(device.get(GATE_HMAC_KEY));
        const key = await requestAsPromise<AccountKeyRecord | undefined>(device.get(ACCOUNT_KEY));
        return { account, hash, key };
      });
      if (existing?.account !== undefined && existing.account.principalHash !== null &&
          validGateHmac(existing.hash, existing.account) && validAccountKey(existing.key, existing.account)) {
        const principalHash = await gateHash(existing.hash.hmac, "principal", principal.toLowerCase());
        if (existing.account.principalHash !== principalHash) throw gated("principal_mismatch");
        return { incarnation: existing.account.incarnation, lifecycleEpoch: existing.account.lifecycleEpoch };
      }
      const incarnation = crypto.randomUUID();
      const hash = await newGateHmac(incarnation);
      const principalHash = await gateHash(hash.hmac, "principal", principal.toLowerCase());
      const lifecycleEpoch = existing?.account?.lifecycleEpoch ?? 0;
      const key = await newAccountKey(incarnation, lifecycleEpoch, principalHash);
      const account: BrowserGate = {
        incarnation, lifecycleEpoch, principalHash, salt: TEST_SALT,
        deniedAt: existing?.account?.deniedAt ?? null,
        keyId: hash.keyId, accountKeyId: key.keyId,
        consentDeadline: Date.now() + CONSENT_WINDOW_MS,
      };
      await withDb(true, async (db) => {
        const tx = db.transaction([KV_STORE.gate, KV_STORE.device], "readwrite");
        const done = transactionDone(tx);
        try {
          const current = await requestAsPromise<BrowserGate | undefined>(tx.objectStore(KV_STORE.gate).get("account"));
          if (current?.lifecycleEpoch !== existing?.account?.lifecycleEpoch) throw gated("stamp_stale");
          tx.objectStore(KV_STORE.device).put(hash, GATE_HMAC_KEY);
          tx.objectStore(KV_STORE.device).put(key, ACCOUNT_KEY);
          tx.objectStore(KV_STORE.gate).put(account, "account");
          await done;
        } catch (error) {
          tx.abort();
          await done.catch(() => undefined);
          throw error;
        }
      });
        return { incarnation, lifecycleEpoch };
      };
      return typeof navigator !== "undefined" && navigator.locks !== undefined
        ? navigator.locks.request("tinycloud-replica-kv:test-establish", section)
        : section();
    },

    async deny(): Promise<void> {
      await withDb(false, async (db) => {
        const tx = db.transaction([KV_STORE.gate, KV_STORE.device, KV_STORE.pending], "readwrite");
        const done = transactionDone(tx);
        const account = await requestAsPromise<BrowserGate | undefined>(tx.objectStore(KV_STORE.gate).get("account"));
        if (account !== undefined) {
          tx.objectStore(KV_STORE.gate).put({
            ...account, principalHash: null, lifecycleEpoch: account.lifecycleEpoch + 1, deniedAt: Date.now(),
          }, "account");
          tx.objectStore(KV_STORE.device).delete(ACCOUNT_KEY);
          tx.objectStore(KV_STORE.device).delete(GATE_HMAC_KEY);
          tx.objectStore(KV_STORE.pending).clear();
        }
        await done;
      });
    },

    async addIntent(intent: { kind: "partition"; partitionId: string } | { kind: "pending"; identityKeyHash: string }): Promise<void> {
      await withDb(true, async (db) => {
        const tx = db.transaction(KV_STORE.purgeIntents, "readwrite");
        const done = transactionDone(tx);
        const id = intent.kind === "partition" ? intent.partitionId : `pending:${intent.identityKeyHash}`;
        tx.objectStore(KV_STORE.purgeIntents).put({ id, ...intent, principalHash: "test", recordedAt: Date.now() }, id);
        await done;
      });
    },
  });
}

/**
 * The main-thread facade the adapter consults (`deliverable`, `pendingPurge`,
 * `activationAllowed`) over a test gate. The sign-in/sign-out protocol
 * methods belong to the lifecycle slice and are not part of these tests.
 */
export function createTestLifecycle(gate: TestGate): ReplicaLifecycleGate & { revoke(stamp: ReplicaSessionStamp): void } {
  const revoked = new Set<string>();
  const recovery = createIndexedDbLifecycle({ ledger: ledgerFor() });
  const unsupported = (name: string) => () => Promise.reject(new Error(`${name} is not part of the adapter's test lifecycle.`));
  return {
    kind: "indexeddb",
    deliverable: (stamp) => !revoked.has(`${stamp.incarnation}:${stamp.lifecycleEpoch}`),
    checkDelivery: (stamp) => revoked.has(`${stamp.incarnation}:${stamp.lifecycleEpoch}`)
      ? { status: "gated", gate: "stamp_stale" } : { status: "allow" },
    consentDeadline: () => Date.now() + CONSENT_WINDOW_MS,
    revoke: (stamp) => void revoked.add(`${stamp.incarnation}:${stamp.lifecycleEpoch}`),
    activationAllowed: async () => true,
    pendingPurge: async () =>
      (await withDb(false, async (db) => requestAsPromise(db.transaction(KV_STORE.purgeIntents).objectStore(KV_STORE.purgeIntents).getAll()))) ?? [],
    establishSessionStamp: (principal) => gate.establish(principal),
    restoreSessionStamp: unsupported("restoreSessionStamp"),
    recover: (options) => recovery.recover(options),
    deny: unsupported("deny"),
    erasePending: unsupported("erasePending"),
  };
}
