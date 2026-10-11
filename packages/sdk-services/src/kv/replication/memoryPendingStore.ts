import { canonicalReplicationIdentity, replicationIdentityKey } from "./identity";
import { emptyPendingState } from "./pendingWrites";
import type { PendingWriteState, PendingWriteStore, ReplicationIdentity } from "./types";

export function createMemoryPendingStore(identity: ReplicationIdentity): PendingWriteStore {
  const canonical = canonicalReplicationIdentity(identity);
  const key = replicationIdentityKey(canonical);
  let state = emptyPendingState(canonical);
  let tail: Promise<void> = Promise.resolve();
  return {
    identity: canonical,
    durable: false,
    async read(): Promise<PendingWriteState> { return structuredClone(state); },
    async update<T>(mutate: (s: PendingWriteState) => T): Promise<T> {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const result = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      const operation = tail.then(() => {
        try {
          if (replicationIdentityKey(state.identity) !== key) throw Object.assign(new Error("Pending-store identity mismatch"), { code: "STORAGE_ERROR" });
          const next = structuredClone(state);
          const value = mutate(next);
          state = next;
          resolve(value);
        } catch (error) { reject(error); }
      });
      tail = operation.then(() => undefined, () => undefined);
      return result;
    },
  };
}
