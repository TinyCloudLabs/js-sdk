import type { ReplicaGatedStorage, ReplicaPartitionEraser } from "@tinycloud/sdk-services/kv/replication";
// @ts-expect-error `?url` is a Vite module query: the worker's asset URL, a string. Nothing is fetched until a worker is spawned.
import workerUrl from "@tinycloud/replica/kv-storage/worker?url";

/**
 * The replication storage the fixture hands to `TinyCloudWeb`: master's real IndexedDB adapter
 * and its real lifecycle gate. Everything replica-side is imported on demand, so a page that
 * never enables replication fetches no replica chunk. Only the eraser is indirected, so a
 * scenario can make sign-out's erase fail (the `@tinycloud/replica/kv-storage/testing` seams).
 */
type Eraser = ReplicaPartitionEraser<IDBTransaction>;
type Testing = typeof import("@tinycloud/replica/kv-storage/testing");

let testing: Testing | undefined;
let failing: (Eraser & { remaining(): number }) | undefined;
let delegate: Eraser | undefined;
let lifecycle: ReturnType<Testing["createIndexedDbLifecycle"]> | undefined;
let storage: ReplicaGatedStorage | undefined;

function seams(): Testing {
  if (testing === undefined) throw new Error("replication storage not loaded: boot with replication 'on' first");
  return testing;
}

export async function replicationStorage(): Promise<ReplicaGatedStorage> {
  if (storage !== undefined) return storage;
  const [{ indexedDbReplicaStorage }, loaded] = await Promise.all([
    import("@tinycloud/replica/kv-storage"),
    import("@tinycloud/replica/kv-storage/testing"),
  ]);
  testing = loaded;
  // `injectEraseFailure({ times: 0 })` delegates straight to the production eraser.
  delegate = loaded.injectEraseFailure({ times: 0 });
  const eraser: Eraser = {
    erasePartition: (tx, partitionId) => (failing ?? delegate!).erasePartition(tx, partitionId),
    eraseIdentityPending: (tx, hash) => (failing ?? delegate!).eraseIdentityPending(tx, hash),
  };
  lifecycle = loaded.createIndexedDbLifecycle({ eraser });
  storage = indexedDbReplicaStorage({ worker: new URL(workerUrl, import.meta.url), lifecycle });
  return storage;
}

async function rows(): Promise<Record<string, number>> {
  const settle = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const out: Record<string, number> = {};
  for (const info of await indexedDB.databases()) {
    if (info.name !== "tinycloud-replica-kv") continue;
    const db = await settle(indexedDB.open(info.name));
    try {
      for (const name of Array.from(db.objectStoreNames)) {
        out[name] = (await settle(db.transaction(name).objectStore(name).getAllKeys())).length;
      }
    } finally {
      db.close();
    }
  }
  return out;
}

export const replicationHooks = {
  rows,
  async keyPresence() {
    const { inspectReplicaKeyPresence } = await import("../../../src/kv-storage/lifecycle.js");
    return inspectReplicaKeyPresence();
  },
  async pendingPurge() {
    if (lifecycle === undefined) throw new Error("replica lifecycle not loaded");
    return lifecycle.pendingPurge();
  },
  failErases: () => {
    failing = seams().injectEraseFailure();
  },
  failDeny: (stage: "deny_tx" | "delete_database", once: boolean) => {
    seams().injectDenyFailure(stage, { once });
  },
  killWorker: () => {
    if (storage === undefined) throw new Error("replica storage not loaded");
    seams().killReplicaWorker(storage);
  },
};
