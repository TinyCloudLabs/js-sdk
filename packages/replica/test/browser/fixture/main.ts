/**
 * The TC-19 browser fixture. The page's whole API is `window.__replica`: the
 * tests drive it through `page.evaluate`, mirroring how an app would use
 * `@tinycloud/replica/browser`. Worker bytes are emitted by Vite as an asset
 * (`?url`) and handed to the client — the same path a bundler app takes when
 * `new URL("./replica.worker.js", import.meta.url)` is not visible to it.
 */
import { openReplica, ReplicaError } from "@tinycloud/replica/browser";
import type { BrowserReplica } from "@tinycloud/replica/browser";
// Vite emits the self-contained worker bundle as an asset.
// @ts-expect-error `?url` is a Vite module query.
import workerUrl from "@tinycloud/replica/worker?url";

type OpenOptions = {
  host: string;
  space: string;
  prefix: string;
  /** The signed-in user's identity DID; partitions the replica database. */
  principal: string;
  allowSecrets?: boolean;
  /** Omit the `worker` escape hatch so the client resolves its bundled URL. */
  defaultWorker?: boolean;
};

const state: {
  replica: BrowserReplica | null;
  committedSerials: number[];
} = { replica: null, committedSerials: [] };

const statusEl = document.getElementById("status");
const setStatus = (text: string) => {
  if (statusEl !== null) statusEl.textContent = text;
};

async function open(
  options: OpenOptions,
): Promise<{ replicaId: string; deviceDid: string; created: boolean; status: unknown }> {
  if (state.replica !== null) await state.replica.close().catch(() => undefined);
  state.committedSerials = [];
  const { defaultWorker, ...openOptions } = options;
  const replica = await openReplica(
    { ...openOptions, ...(defaultWorker === true ? {} : { worker: new URL(workerUrl, import.meta.url) }) },
    { onCommitted: (serial) => state.committedSerials.push(serial) },
  );
  state.replica = replica;
  const opened = replica.opened!;
  return {
    replicaId: opened.replicaId,
    deviceDid: opened.deviceDid,
    created: opened.created,
    status: opened.status,
  };
}

function needReplica(): BrowserReplica {
  if (state.replica === null) throw new Error("replica is not open");
  return state.replica;
}

const api = {
  open,
  committedSerials: () => state.committedSerials.slice(),
  deviceDid: () => needReplica().deviceDid,
  installGrant: (delegation: string) => needReplica().installGrant(delegation),
  sync: (options?: { limit?: number }) => needReplica().sync(options),
  get: async (key: string) => {
    const result = await needReplica().get(key);
    // page.evaluate cannot ferry ArrayBuffers; return a byte array. The
    // worker may post `value` as a Uint8Array or its bare ArrayBuffer.
    if (result.status === "present") {
      const raw = result.value as unknown;
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
      return { ...result, value: Array.from(bytes) };
    }
    return result;
  },
  list: (options?: { prefix?: string; after?: string; limit?: number }) => needReplica().list(options),
  status: () => needReplica().status(),
  setRetentionGrant: (cid: string | null) => needReplica().setRetentionGrant(cid),
  reset: (options?: { purge?: boolean }) => needReplica().reset(options),
  close: async () => {
    await state.replica?.close();
    state.replica = null;
  },
  /** IndexedDB dump for scope assertions: every object store's keys and bytes. */
  async dumpDatabases(): Promise<{ name: string; stores: Record<string, { keys: string[]; bytes: string }> }[]> {
    const dbs = await indexedDB.databases();
    const out: { name: string; stores: Record<string, { keys: string[]; bytes: string }> }[] = [];
    for (const info of dbs) {
      if (info.name === undefined) continue;
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const request = indexedDB.open(info.name!);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const stores: Record<string, { keys: string[]; bytes: string }> = {};
      for (const name of Array.from(db.objectStoreNames)) {
        const tx = db.transaction(name, "readonly");
        const records: unknown[] = await new Promise((resolve, reject) => {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
          request.onerror = () => reject(request.error);
        });
        const keys: string[] = [];
        let bytes = "";
        for (const record of records) {
          try {
            const json = JSON.stringify(record);
            if (record !== null && typeof record === "object" && "key" in record) keys.push(String((record as { key: unknown }).key));
            if (record !== null && typeof record === "object" && "bytes" in record) {
              const blob = (record as { bytes: unknown }).bytes;
              if (blob instanceof Uint8Array) bytes += new TextDecoder().decode(blob);
            }
            bytes += json.length > 200 ? "" : json;
          } catch {
            // unserializable value
          }
        }
        stores[name] = { keys, bytes };
      }
      db.close();
      out.push({ name: info.name, stores });
    }
    return out;
  },
  /** True once the test service worker controls this page. */
  async serviceWorkerReady(): Promise<boolean> {
    if (!("serviceWorker" in navigator)) return false;
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  },
};

declare global {
  interface Window {
    __replica: typeof api;
  }
}

window.__replica = api;
setStatus("ready");

// Register the offline shell immediately so it controls the page (and the
// replica worker's spawn request) before the first sync.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}

void ReplicaError;
