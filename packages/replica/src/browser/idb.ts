/**
 * IndexedDB plumbing for the browser replica store: request promises and a
 * transaction-completer. A transaction's promise resolves on `oncomplete`
 * (never on request success — the SignatureCache mistake the design calls
 * out) and rejects on `onabort`/`onerror`.
 */
import { ReplicaError, ReplicaErrorCode } from "../errors.js";

export function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new DOMException("IndexedDB request failed", "UnknownError"));
  return promise;
}

/** Resolves when the transaction commits; rejects when it aborts or errors. */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
  tx.onerror = () => reject(tx.error ?? new DOMException("Transaction failed", "UnknownError"));
  return promise;
}

export function openDatabase(name: string, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new ReplicaError(
        ReplicaErrorCode.RUNTIME_UNSUPPORTED,
        "IndexedDB is unavailable (private browsing or a non-browser runtime); the replica cannot persist.",
      ),
    );
  }
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => upgrade(request.result);
  request.onsuccess = () => {
    const db = request.result;
    // A newer copy in another tab asks us to close; refuse silently so the
    // caller's transactions still work, then surface the version error to
    // the next opener instead of dropping writes mid-sync.
    db.onversionchange = () => db.close();
    resolve(db);
  };
  request.onerror = () => reject(request.error ?? new DOMException(`Opening ${name} failed`, "UnknownError"));
  request.onblocked = () =>
    reject(
      new ReplicaError(
        ReplicaErrorCode.BUSY,
        `Opening ${name} is blocked by another connection; close the replica in its other tab.`,
      ),
    );
  return promise;
}

const byteEncoder = new TextEncoder();

/** UTF-8 byte order for keys — the order SQLite, the node and `batchGet` share. */
export function compareKeyBytes(a: string, b: string): number {
  const x = byteEncoder.encode(a);
  const y = byteEncoder.encode(b);
  for (let index = 0; index < Math.min(x.length, y.length); index += 1) {
    if (x[index] !== y[index]) return x[index]! - y[index]!;
  }
  return x.length - y.length;
}

type NamedError = { name: string };

function hasName(error: unknown): error is NamedError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof (error as Record<string, unknown>).name === "string"
  );
}

/** Map an IndexedDB failure to a replica error. Quota exceeded is STORAGE_FULL. */
export function idbError(error: unknown, action: string): ReplicaError {
  if (error instanceof ReplicaError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (hasName(error) && error.name === "QuotaExceededError") {
    return new ReplicaError(ReplicaErrorCode.STORAGE_FULL, `${action}: the browser's storage quota is exceeded.`, undefined, {
      cause: error,
    });
  }
  return new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, `${action}: ${message}`, undefined, { cause: error });
}
