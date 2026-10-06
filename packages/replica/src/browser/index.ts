/**
 * The main-thread browser API (TC-19): a thin RPC client over the replica
 * worker. IndexedDB, the network and the device key live in the worker; the
 * client's local reads never touch the network, and its sync calls are the
 * only path that does.
 *
 * The worker ships as `dist/replica.worker.js`, a self-contained ESM bundle
 * spawned via `new Worker(new URL("./replica.worker.js", import.meta.url),
 * { type: "module" })` — webpack 5 and Vite detect that form. A `worker`
 * option accepts a `Worker` or `URL` escape hatch. In Vite dev mode, list
 * `@tinycloud/replica` in `optimizeDeps.exclude` so the worker URL resolves
 * inside the package (vitejs/vite#20859).
 */
import { ReplicaError, ReplicaErrorCode } from "../errors.js";
import type {
  GetResult,
  ListResult,
  OpenResult,
  ReplicaReply,
  StatusResult,
  SyncResult,
} from "./protocol.js";

export { ReplicaError, ReplicaErrorCode };

export type BrowserReplicaOpenOptions = {
  /** The TinyCloud host to sync from; pinned for the replica's life. */
  host: string;
  /** The space id (native form) the replica covers. */
  space: string;
  /** The KV prefix, e.g. `notes/`. */
  prefix: string;
  /** A display name; defaults to the prefix. */
  name?: string;
  /**
   * The principal the sync grant is issued by, when the app knows it (for
   * example the owner's did:pkh under `createOwnerDelegation`, or the owner
   * session's did:key under `delegateTo`). Partitions the local database
   * (spec §8): a grant issued by another principal is refused at
   * `installGrant`. Leave empty when the app cannot know the issuer.
   */
  grantSubject?: string;
  /** Replicating the `secrets` space or a `vault/` prefix needs this opt-in. */
  allowSecrets?: boolean;
  /** Spawn this worker instead of the bundled one (custom bundler layouts). */
  worker?: Worker | URL | string;
};

export type BrowserReplicaGetResult = GetResult;
export type BrowserReplicaListResult = ListResult;
export type BrowserReplicaStatus = StatusResult;
export type BrowserReplicaSyncResult = SyncResult;
export type BrowserReplicaOpenResult = OpenResult;

/** Subscriptions for worker events (other tabs' commits, resets). */
export type BrowserReplicaEvents = {
  /** Another tab's worker committed a page (`serial` is monotonic). */
  onCommitted?: (serial: number) => void;
  /** The replica's authority state changed. */
  onAuthority?: (state: string) => void;
  /** The replica was reset in this tab or observed elsewhere. */
  onReset?: (reason: string) => void;
};

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

function workerFrom(source: Worker | URL | string | undefined): Worker {
  if (source !== undefined) {
    if (typeof Worker !== "undefined" && source instanceof Worker) return source;
    if (source instanceof URL || typeof source === "string") return new Worker(source, { type: "module" });
  }
  return new Worker(new URL("./replica.worker.js", import.meta.url), { type: "module" });
}

/**
 * Open (or create) a replica in a dedicated worker. The first call also asks
 * the browser for durable storage (`navigator.storage.persist()`), so an
 * eviction under pressure is less likely; `status()` reports the outcome.
 * In environments without IndexedDB the returned promise rejects with
 * `RUNTIME_UNSUPPORTED` — there is no in-memory fallback, reads would lose
 * their durability guarantee.
 */
export async function openReplica(options: BrowserReplicaOpenOptions, events: BrowserReplicaEvents = {}): Promise<BrowserReplica> {
  const replica = new BrowserReplica(workerFrom(options.worker), events);
  await replica.ready;
  const persisted =
    typeof navigator !== "undefined" && typeof navigator.storage?.persist === "function"
      ? await navigator.storage.persist().catch(() => undefined)
      : undefined;
  return replica.open({ ...options, persisted });
}

export class BrowserReplica {
  /** The open() result: replicaId, deviceDid and the status at open time. */
  opened: OpenResult | null = null;

  readonly #worker: Worker;
  readonly #events: BrowserReplicaEvents;
  /** Settles when the worker reports it is listening (or fails to start). */
  readonly ready: Promise<void>;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;

  /** For tests and advanced use: drive an already-spawned worker. */
  constructor(worker: Worker, events: BrowserReplicaEvents = {}) {
    this.#worker = worker;
    this.#events = events;
    const ready = Promise.withResolvers<void>();
    this.ready = ready.promise;
    // A close() before the worker reports ready rejects `ready`; not every
    // consumer awaits it, so mark that rejection handled up front.
    ready.promise.catch(() => undefined);
    this.#readyResolve = ready.resolve;
    this.#readyReject = ready.reject;
    worker.onmessage = (message: MessageEvent) => this.#onMessage(message.data);
    worker.onerror = (event) => {
      const error = new Error(event.message ?? "The replica worker failed.");
      this.#readyReject(error);
      this.#failAll(error);
    };
  }

  #readyResolve: () => void;
  #readyReject: (error: Error) => void;

  #onMessage(data: unknown): void {
    if (typeof data === "object" && data !== null && "event" in data) {
      const event = (data as { event: { event?: unknown } }).event;
      switch (event.event) {
        case "ready":
          this.#readyResolve();
          return;
        case "committed":
          if (typeof (event as { serial?: unknown }).serial === "number") {
            this.#events.onCommitted?.((event as { serial: number }).serial);
          }
          return;
        case "authority":
          if (typeof (event as { state?: unknown }).state === "string") {
            this.#events.onAuthority?.((event as { state: string }).state);
          }
          return;
        case "reset":
          if (typeof (event as { reason?: unknown }).reason === "string") {
            this.#events.onReset?.((event as { reason: string }).reason);
          }
          return;
        default:
          return;
      }
    }
    const reply = data as ReplicaReply;
    if (typeof reply.id !== "number") return;
    const pending = this.#pending.get(reply.id);
    if (pending === undefined) return;
    this.#pending.delete(reply.id);
    if (reply.ok) {
      pending.resolve(reply.result);
    } else {
      pending.reject(new ReplicaError(reply.err.code as ReplicaErrorCode, reply.err.message, reply.err.detail));
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async #call<T>(request: Record<string, unknown>): Promise<T> {
    if (this.#closed) throw new ReplicaError(ReplicaErrorCode.CLOSED, "The replica is closed.");
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#pending.set(id, { resolve, reject });
    this.#worker.postMessage({ id, ...request });
    return (await promise) as T;
  }

  /** Open or create the replica; `openReplica` calls this for you. */
  async open(options: BrowserReplicaOpenOptions & { persisted?: boolean }): Promise<BrowserReplica> {
    this.opened = await this.#call<OpenResult>({
      op: "open",
      host: options.host,
      space: options.space,
      prefix: options.prefix,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.grantSubject === undefined ? {} : { grantSubject: options.grantSubject }),
      ...(options.allowSecrets === undefined ? {} : { allowSecrets: options.allowSecrets }),
      ...(options.persisted === undefined ? {} : { persisted: options.persisted }),
    });
    return this;
  }

  /** The DID the app delegates to (`tcw.delegateTo(deviceDid, […sync…])`). */
  get deviceDid(): string {
    if (this.opened === null) throw new Error("open() has not completed.");
    return this.opened.deviceDid;
  }

  /** Install a signed grant: the compact UCAN (`delegation.delegationHeader.Authorization`). */
  installGrant(delegation: string): Promise<{ cid: string; audience: string; expiresAt: number | null }> {
    return this.#call({ op: "installGrant", delegation });
  }

  /** Pull the feed and commit each page atomically. `busy` when another tab syncs. */
  sync(options: { limit?: number } = {}): Promise<SyncResult> {
    return this.#call({ op: "sync", ...(options.limit === undefined ? {} : { limit: options.limit }) });
  }

  /** Local read: never touches the network. */
  get(key: string): Promise<GetResult> {
    return this.#call({ op: "get", key });
  }

  /** Local read: never touches the network. */
  list(options: { prefix?: string; after?: string; limit?: number } = {}): Promise<ListResult> {
    return this.#call({ op: "list", ...options });
  }

  /** Replica status plus browser persistence facts. */
  status(): Promise<StatusResult> {
    return this.#call({ op: "status" });
  }

  /** Opt in to post-expiry reads under a `tinycloud.kv/retain` grant. */
  setRetentionGrant(cid: string | null): Promise<{ retentionGrantCid: string | null }> {
    return this.#call({ op: "setRetention", grantCid: cid });
  }

  /** Clear entries and cursor (keeps config and grant); `purge` deletes the database. */
  reset(options: { purge?: boolean } = {}): Promise<{ reset: true; purged: boolean }> {
    return this.#call({ op: "reset", purge: options.purge === true });
  }

  /** Close the worker-side handles and terminate the worker. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#readyReject(new ReplicaError(ReplicaErrorCode.CLOSED, "The replica is closed."));
    // Give the worker a moment to close its store handles, then terminate
    // either way: a close that never replies must not hang, and every
    // in-flight call rejects with a typed error.
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#pending.set(id, { resolve, reject });
    this.#worker.postMessage({ id, op: "close" });
    const timeout = setTimeout(() => {
      this.#pending.delete(id);
      resolve(undefined);
    }, 2_000);
    await promise.catch(() => undefined).finally(() => clearTimeout(timeout));
    this.#worker.terminate();
    this.#failAll(new ReplicaError(ReplicaErrorCode.CLOSED, "The replica is closed."));
  }
}
