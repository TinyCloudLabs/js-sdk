import type { ReplicaQuotaLedger, ReplicaQuotaSpec } from "@tinycloud/sdk-services/kv/replication";
import { DEFAULT_MIN_FREE_BYTES } from "@tinycloud/sdk-services/kv/replication/contractConstants";

import { requestAsPromise } from "../browser/idb.js";
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import { KV_STORE } from "./schema.js";

type Usage = { bytes: number };
const TOTAL = "total";

/** A reserved origin-wide bucket for sealed owner-device and install-stamp rows. */
export const DEVICE_QUOTA_PARTITION_ID = "device";

export interface ReplicaBrowserQuotaLedger extends ReplicaQuotaLedger<IDBTransaction> {
  /** Admit the combined signed origin delta once, before any sealed row is written. */
  admitRows(tx: IDBTransaction, rows: {
    partitionId: string;
    partitionDeltaBytes: number;
    deviceDeltaBytes: number;
    freeBytes: number | null;
  }): Promise<void>;
  /** Commit that same delta, split between the partition and retained device rows. */
  accountRows(tx: IDBTransaction, rows: {
    partitionId: string;
    partitionDeltaBytes: number;
    deviceDeltaBytes: number;
  }): Promise<void>;
}

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
export function ledgerFor(quota?: ReplicaQuotaSpec): ReplicaBrowserQuotaLedger {
  const maxBytes = quota?.maxBytes;
  const minFreeBytes = quota?.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;

  async function admit(tx: IDBTransaction, delta: number, freeBytes: number | null): Promise<void> {
    if (delta <= 0) return;
    const total = measured(await requestAsPromise<Usage | undefined>(tx.objectStore(KV_STORE.quota).get(TOTAL)));
    if (maxBytes !== undefined && total + delta > maxBytes) {
      throw new ReplicaError(ReplicaErrorCode.STORAGE_BUDGET, "The replica page exceeds the origin's byte budget.");
    }
    if (freeBytes !== null && freeBytes - delta < minFreeBytes) {
      throw new ReplicaError(ReplicaErrorCode.STORAGE_BUDGET, "The replica page would cross the browser's free-space floor.");
    }
  }

  const ledger: ReplicaBrowserQuotaLedger = {
    async freeBytes() {
      if (typeof navigator === "undefined" || navigator.storage?.estimate === undefined) return null;
      const { quota: capacity, usage } = await navigator.storage.estimate();
      return typeof capacity === "number" && typeof usage === "number"
        && Number.isFinite(capacity) && Number.isFinite(usage)
        ? Math.max(0, capacity - usage)
        : null;
    },
    async admitPage(tx, page) {
      await admit(tx, checkedDelta(page.deltaBytes), page.freeBytes);
    },
    async admitRows(tx, { partitionDeltaBytes, deviceDeltaBytes, freeBytes }) {
      const delta = checkedDelta(checkedDelta(partitionDeltaBytes) + checkedDelta(deviceDeltaBytes));
      await admit(tx, delta, freeBytes);
    },
    async accountCommit(tx, { partitionId, deltaBytes }) {
      await ledger.accountRows(tx, { partitionId, partitionDeltaBytes: deltaBytes, deviceDeltaBytes: 0 });
    },
    async accountRows(tx, { partitionId, partitionDeltaBytes, deviceDeltaBytes }) {
      const partitionDelta = checkedDelta(partitionDeltaBytes);
      const deviceDelta = checkedDelta(deviceDeltaBytes);
      if (partitionDelta === 0 && deviceDelta === 0) return;
      if (partitionDelta !== 0 && partitionId === DEVICE_QUOTA_PARTITION_ID) {
        throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The device quota bucket cannot contain partition rows.");
      }
      const combined = checkedDelta(partitionDelta + deviceDelta);
      const store = tx.objectStore(KV_STORE.quota);
      const totalRequest = combined === 0 ? undefined : requestAsPromise<Usage | undefined>(store.get(TOTAL));
      const partitionRequest = partitionDelta === 0 ? undefined : requestAsPromise<Usage | undefined>(store.get(partitionKey(partitionId)));
      const deviceRequest = deviceDelta === 0 ? undefined : requestAsPromise<Usage | undefined>(store.get(partitionKey(DEVICE_QUOTA_PARTITION_ID)));
      const total = totalRequest === undefined ? 0 : measured(await totalRequest) + combined;
      const partition = partitionRequest === undefined ? 0 : measured(await partitionRequest) + partitionDelta;
      const device = deviceRequest === undefined ? 0 : measured(await deviceRequest) + deviceDelta;
      if ((totalRequest !== undefined && (!Number.isSafeInteger(total) || total < 0))
        || (partitionRequest !== undefined && (!Number.isSafeInteger(partition) || partition < 0))
        || (deviceRequest !== undefined && (!Number.isSafeInteger(device) || device < 0))) {
        throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The replica quota ledger would become negative or imprecise.");
      }
      if (totalRequest !== undefined) store.put({ bytes: total } satisfies Usage, TOTAL);
      if (partitionRequest !== undefined) {
        if (partition === 0) store.delete(partitionKey(partitionId));
        else store.put({ bytes: partition } satisfies Usage, partitionKey(partitionId));
      }
      if (deviceRequest !== undefined) {
        if (device === 0) store.delete(partitionKey(DEVICE_QUOTA_PARTITION_ID));
        else store.put({ bytes: device } satisfies Usage, partitionKey(DEVICE_QUOTA_PARTITION_ID));
      }
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
  return ledger;
}
