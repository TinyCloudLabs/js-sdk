import type { ReplicaQuotaLedger, ReplicaQuotaSpec } from "@tinycloud/sdk-services/kv/replication";
import { DEFAULT_MIN_FREE_BYTES } from "@tinycloud/sdk-services/kv/replication/contractConstants";

import { requestAsPromise } from "../browser/idb.js";
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { KV_STORE } from "./schema.js";

type Usage = { bytes: number };
const TOTAL = "total";

function partitionKey(partitionId: string): string {
  return `partition:${partitionId}`;
}

function measured(row: Usage | undefined): number {
  const bytes = row?.bytes ?? 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica quota ledger has invalid byte accounting.");
  }
  return bytes;
}

function checkedDelta(delta: number): number {
  if (!Number.isSafeInteger(delta)) {
    throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica quota delta is not a safe integer.");
  }
  return delta;
}

/** Origin-wide quota, serialized by every readwrite transaction's shared `quota` store. */
export function ledgerFor(quota?: ReplicaQuotaSpec): ReplicaQuotaLedger<IDBTransaction> {
  const maxBytes = quota?.maxBytes;
  const minFreeBytes = quota?.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  return {
    async freeBytes() {
      if (typeof navigator === "undefined" || navigator.storage?.estimate === undefined) return null;
      const { quota: capacity, usage } = await navigator.storage.estimate();
      return typeof capacity === "number" && typeof usage === "number"
        && Number.isFinite(capacity) && Number.isFinite(usage)
        ? Math.max(0, capacity - usage)
        : null;
    },
    async admitPage(tx, page) {
      const delta = checkedDelta(page.deltaBytes);
      if (delta <= 0) return;
      const total = measured(await requestAsPromise<Usage | undefined>(tx.objectStore(KV_STORE.quota).get(TOTAL)));
      if (maxBytes !== undefined && total + delta > maxBytes) {
        throw new ReplicaError(ReplicaErrorCode.STORAGE_BUDGET, "The replica page exceeds the origin's byte budget.");
      }
      if (page.freeBytes !== null && page.freeBytes - delta < minFreeBytes) {
        throw new ReplicaError(ReplicaErrorCode.STORAGE_BUDGET, "The replica page would cross the browser's free-space floor.");
      }
    },
    async accountCommit(tx, { partitionId, deltaBytes }) {
      const delta = checkedDelta(deltaBytes);
      if (delta === 0) return;
      const store = tx.objectStore(KV_STORE.quota);
      const totalRequest = requestAsPromise<Usage | undefined>(store.get(TOTAL));
      const partitionRequest = requestAsPromise<Usage | undefined>(store.get(partitionKey(partitionId)));
      const total = measured(await totalRequest) + delta;
      const partition = measured(await partitionRequest) + delta;
      if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(partition) || partition < 0) {
        throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica quota ledger would become negative or imprecise.");
      }
      store.put({ bytes: total } satisfies Usage, TOTAL);
      if (partition === 0) store.delete(partitionKey(partitionId));
      else store.put({ bytes: partition } satisfies Usage, partitionKey(partitionId));
    },
    async accountErase(tx, { partitionId, bytes }) {
      const removed = checkedDelta(bytes);
      if (removed < 0) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica erase has negative bytes.");
      const store = tx.objectStore(KV_STORE.quota);
      const partition = await requestAsPromise<Usage | undefined>(store.get(partitionKey(partitionId)));
      if (partition === undefined) return; // A completed erase has no partition entry to subtract again.
      const remaining = measured(partition) - removed;
      if (remaining < 0) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica erase exceeds its accounted bytes.");
      const total = measured(await requestAsPromise<Usage | undefined>(store.get(TOTAL))) - removed;
      if (total < 0) throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica erase exceeds origin usage.");
      store.put({ bytes: total } satisfies Usage, TOTAL);
      if (remaining === 0) store.delete(partitionKey(partitionId));
      else store.put({ bytes: remaining } satisfies Usage, partitionKey(partitionId));
    },
  };
}
