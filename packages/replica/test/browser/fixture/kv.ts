/**
 * The kv-storage fixture page. Its whole API is `window.__kv`: tests drive
 * `indexedDbReplicaStorage()` through `page.evaluate`, exactly as the
 * read-through controller would, with the adapter's test gate standing in
 * for the lifecycle slice's gate. `fake` storages run the worker host over
 * the fake feed (`kv-test-worker.ts`); `real` storages run it with the
 * production WASM signing path (`kv-real-worker.ts`) against a node;
 * `published` storages run the published `kv-storage.worker.js`, which has
 * no gate wired and must fail closed.
 */
import type { KVReplicaHandle, KVReplicaSpec, KVReplicaStorage, PurgeTarget, ReplicaPeerCommit, ReplicaQuotaSpec, ReplicaSessionStamp, ReplicationIdentity } from "@tinycloud/sdk-services/kv/replication";
import { indexedDbReplicaStorage } from "@tinycloud/replica/kv-storage";
import { killReplicaWorker } from "@tinycloud/replica/kv-storage/testing";
// @ts-expect-error `?url` is a Vite module query.
import publishedWorkerUrl from "@tinycloud/replica/kv-storage/worker?url";

import { createTestGate, createTestLifecycle } from "../../test-gate.js";
import { ledgerFor } from "../../../src/kv-storage/ledger.js";

const gate = createTestGate();
const lifecycle = createTestLifecycle(gate);

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string; gate?: string };

async function outcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "ERROR";
    const gate = typeof error === "object" && error !== null && "gate" in error && typeof error.gate === "string" ? { gate: error.gate } : {};
    return { ok: false, code, message: error instanceof Error ? error.message : String(error), ...gate };
  }
}

type WireSpec = Omit<KVReplicaSpec, "fetch" | "onPeerCommit">;

const storages = new Map<string, KVReplicaStorage>();
const handles = new Map<string, KVReplicaHandle>();
const peerCommits = new Map<string, ReplicaPeerCommit[]>();
const syncs = new Map<string, { abort: AbortController; result: Promise<Outcome<unknown>> }>();
const closes = new Map<string, Promise<void>>();
/** Settlement order of started syncs and closes (`sync:<name>`, `close:<name>`). */
const settled: string[] = [];

function need<T>(map: Map<string, T>, name: string): T {
  const value = map.get(name);
  if (value === undefined) throw new Error(`no ${name}`);
  return value;
}

const api = {
  createStorage(name: string, kind: "fake" | "real" | "published", quota?: ReplicaQuotaSpec): void {
    const worker =
      kind === "fake"
        ? () => new Worker(new URL("./kv-test-worker.ts", import.meta.url), { type: "module" })
        : kind === "real"
          ? () => new Worker(new URL("./kv-real-worker.ts", import.meta.url), { type: "module" })
          : new URL(publishedWorkerUrl, import.meta.url);
    storages.set(name, indexedDbReplicaStorage({ worker, lifecycle, gateTx: gate, ...(quota === undefined ? {} : { ledger: ledgerFor(quota) }) }));
  },
  /** The session stamp a fresh sign-in of `principal` gets from the test gate. */
  establish: (principal: string) => gate.establish(principal),
  /** Sign-out at the test gate: every earlier stamp goes stale. */
  deny: () => gate.deny(),
  /** Make this tab's view refuse delivery under `stamp` (the main-thread check). */
  revoke: (stamp: ReplicaSessionStamp) => lifecycle.revoke(stamp),
  /** Open with `spec.stamp`, or a fresh stamp for the spec's principal; `stamp: null` opens without one. */
  open: (storage: string, name: string, spec: Omit<WireSpec, "stamp"> & { stamp?: ReplicaSessionStamp | null }) =>
    outcome(async () => {
      peerCommits.set(name, []);
      const { stamp, ...rest } = spec;
      const resolved = stamp === null ? undefined : (stamp ?? (await gate.establish(spec.identity.principal)));
      const handle = await need(storages, storage).open({ ...rest, ...(resolved === undefined ? {} : { stamp: resolved }), onPeerCommit: (info) => peerCommits.get(name)!.push(info) });
      handles.set(name, handle);
      return { deviceDid: handle.deviceDid };
    }),
  peerCommits: (name: string) => peerCommits.get(name) ?? [],
  replicaId: (name: string) => need(handles, name).replicaId,
  installGrant: (name: string, ucan: string) => outcome(() => need(handles, name).installGrant(ucan)),
  grant: (name: string) => outcome(() => need(handles, name).grant()),
  get: (name: string, key: string) =>
    outcome(async () => {
      const result = await need(handles, name).get(key);
      return result.status === "present" ? { ...result, value: new TextDecoder().decode(result.value) } : result;
    }),
  list: (name: string, prefix: string) => outcome(() => need(handles, name).list({ prefix })),
  status: (name: string) => outcome(() => need(handles, name).status()),
  /** Start a sync; `awaitSync` collects its outcome, `abortSync` cancels it. */
  startSync(name: string, sync: string, syncStartEpoch: number): void {
    const abort = new AbortController();
    const result = outcome(() => need(handles, name).sync({ signal: abort.signal, syncStartEpoch }));
    void result.then(() => settled.push(`sync:${sync}`));
    syncs.set(sync, { abort, result });
  },
  abortSync: (sync: string) => need(syncs, sync).abort.abort(),
  awaitSync: (sync: string) => need(syncs, sync).result,
  sync: (name: string, syncStartEpoch: number) => outcome(() => need(handles, name).sync({ signal: new AbortController().signal, syncStartEpoch })),
  startClose(name: string): void {
    closes.set(name, need(handles, name).close().then(() => void settled.push(`close:${name}`)));
  },
  awaitClose: (name: string) => need(closes, name),
  settled: () => settled.slice(),
  close: (name: string) => outcome(() => need(handles, name).close()),
  purge: (storage: string, target: PurgeTarget) => outcome(() => need(storages, storage).purge(target)),
  inspectStatus: (storage: string, spec: WireSpec) => outcome(() => need(storages, storage).inspectStatus!(spec, { signal: new AbortController().signal })),
  inspectAborted: (storage: string, spec: WireSpec) => {
    const abort = new AbortController();
    const result = need(storages, storage).inspectStatus!(spec, { signal: abort.signal });
    abort.abort();
    return outcome(() => result);
  },
  /** `count` concurrent read-modify-writes, each appending one record tagged `tag`. */
  pendingWrites: (storage: string, identity: ReplicationIdentity, tag: string, count: number) =>
    outcome(async () => {
      const store = need(storages, storage).pendingWrites!(identity, { stamp: await gate.establish(identity.principal) });
      return Promise.all(
        Array.from({ length: count }, (_, index) =>
          store.update((state) => {
            state.seq += 1;
            state.records.push({ opId: `${tag}-${index}`, seq: state.seq, key: `notes/${tag}/${index}`, op: "put", state: "in_flight", epoch: null, at: new Date().toISOString(), settledAt: null });
            return state.seq;
          }),
        ),
      );
    }),
  pendingRead: (storage: string, identity: ReplicationIdentity) =>
    outcome(async () => need(storages, storage).pendingWrites!(identity, { stamp: await gate.establish(identity.principal) }).read()),
  killWorker: (storage: string) => killReplicaWorker(need(storages, storage)),
  /** Row counts per object store of the origin database, by partition where keys carry one. */
  async dump(): Promise<Record<string, Record<string, number>>> {
    const settle = <T>(request: IDBRequest<T>): Promise<T> => {
      const { promise, resolve, reject } = Promise.withResolvers<T>();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      return promise;
    };
    const db = await settle(indexedDB.open("tinycloud-replica-kv"));
    const out: Record<string, Record<string, number>> = {};
    for (const name of Array.from(db.objectStoreNames)) {
      const keys = await settle(db.transaction(name).objectStore(name).getAllKeys());
      const counts: Record<string, number> = {};
      for (const key of keys) {
        const bucket = Array.isArray(key) ? String(key[0]) : String(key);
        counts[bucket] = (counts[bucket] ?? 0) + 1;
      }
      out[name] = counts;
    }
    db.close();
    return out;
  },
  databases: async () => (await indexedDB.databases()).map((info) => info.name),
};

declare global {
  interface Window {
    __kv: typeof api;
  }
}

window.__kv = api;
document.getElementById("status")!.textContent = "ready";
