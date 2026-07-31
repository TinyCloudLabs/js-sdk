/**
 * Node-only bounded HTTP transport (TC-407).
 *
 * A single module-shared connection-pool registry backs every default
 * (non-overridden) request TinyCloudNode makes, instead of one `undici`
 * agent per request/graph/session/instance. It deliberately does NOT call
 * `setGlobalDispatcher` — pooling is applied per request via
 * `RequestInit.dispatcher`, so it cannot affect unrelated `fetch` calls
 * elsewhere in the process.
 *
 * This module imports `undici` and must only be reachable from the Node
 * entry point (`index.ts` -> `nodeDefaults.ts`), never from `TinyCloudNode.ts`
 * directly or from the `/core` entry point browser consumers use — that
 * boundary is what keeps Undici out of browser bundles.
 *
 * Per-origin pooling is implemented directly on top of `undici.Client`
 * (one persistent connection each) rather than `undici.Pool`, and checkout
 * of a client for a request is tracked with our own LIFO free list instead
 * of relying on `Pool`'s internal per-client busy signal. `Pool` picks
 * among its clients based on an internal "needs drain" flag that clears
 * asynchronously relative to when a response body finishes streaming, so a
 * tight sequential loop (dispatch, fully read the response, dispatch again)
 * can observe a stale "still busy" signal and open a second connection it
 * didn't need — verified empirically against the real package under Node
 * 20. Owning checkout ourselves and releasing a client only once *our own*
 * response wrapper sees its body fully drained keeps that decision on the
 * exact promise chain the caller already awaits, which removes the race
 * and guarantees sequential single-flight traffic reuses one connection.
 *
 * The `undici.Client` constructor is resolved lazily by runtime rather than
 * imported statically from the package root (see {@link resolveClientConstructor}):
 * under real Node the supported root export is used directly; under Bun
 * (used to run this package's own test suite) the bare `"undici"` specifier
 * resolves to Bun's own built-in compatibility shim whose `Client` is a
 * non-functional stub, so a deep, non-exports-mapped subpath import is used
 * instead — reached only by this package's own `bun test` run, never by
 * Bun-runtime production traffic (see `getDefaultNodeFetch`). See
 * `./undici-client.d.ts` for the matching type declaration.
 *
 * No transport-level retries: this module never re-dispatches a request. A
 * dispatch failure (connection refused, a stale pooled connection the
 * server had already closed, a peer reset, etc.) is surfaced to the caller
 * as a rejected promise, and the checked-out client is discarded (see
 * `OriginConnectionPool.discard`) rather than reused. The only case that
 * opens a fresh connection instead of failing outright is a *known-closed*
 * connection being replaced before a new request is dispatched on it (see
 * `OriginConnectionPool.discard`'s waiter handoff) — that is capacity
 * replacement for a connection nothing was ever sent on, not a retry of a
 * request. A request that may have already reached the server (anything
 * past a successful dispatch) is never replayed, since TinyCloudNode's
 * authorization/delegation requests carry durable nonce/state-based replay
 * protection that this transport must not risk double-submitting against.
 * Callers that want retry semantics (e.g. idempotent GETs) must implement
 * them above this layer with full knowledge of what is safe to resend.
 *
 * @packageDocumentation
 */

import type { Client as ClientNamespace, Dispatcher } from "undici";

/** Max concurrent HTTP/1.1 connections held open per origin. */
export const MAX_CONNECTIONS_PER_ORIGIN = 4;
/** Max number of distinct origins retained at once. */
export const MAX_RETAINED_ORIGINS = 16;
/** Max acquisitions queued per origin once every connection is checked out. */
export const MAX_QUEUED_PER_ORIGIN = 64;
/** No real pipelining: one in-flight request per connection. */
export const PIPELINING = 1;
/** Time allowed to establish a new connection. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** A connection (or an origin's pool entry) idle this long is reclaimed. */
export const IDLE_TIMEOUT_MS = 30_000;
/** Upper bound placed on server keep-alive hints; never exceeds the idle bound. */
export const MAX_KEEP_ALIVE_HINT_MS = IDLE_TIMEOUT_MS;

type ClientConstructor = new (origin: string, options: ClientNamespace.Options) => ClientNamespace;

let clientConstructorPromise: Promise<ClientConstructor> | undefined;

/**
 * Resolve the `undici.Client` constructor once, choosing the import path by
 * runtime. Under real Node, the supported package-root export
 * (`import("undici")`) is the actual, fully-functional implementation. Under
 * Bun, that same specifier resolves to Bun's built-in stub (`request()` is a
 * no-op), so the deep subpath is used instead — solely so this package's own
 * `bun test` run can exercise genuine pooling behavior; Bun-runtime
 * production fetch never calls this function (see `getDefaultNodeFetch`).
 */
function resolveClientConstructor(): Promise<ClientConstructor> {
  if (!clientConstructorPromise) {
    clientConstructorPromise = isBunRuntime()
      ? import("undici/lib/dispatcher/client.js").then(
        (mod) => (mod.default ?? mod) as ClientConstructor,
      )
      : import("undici").then((mod) => mod.Client as unknown as ClientConstructor);
  }
  return clientConstructorPromise;
}

type NodeFetchInit = RequestInit & { dispatcher?: Dispatcher };

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Resolve the `AbortSignal` that actually governs a `fetch()` call, matching
 * the Fetch spec's own precedence: `init.signal` wins whenever the caller
 * specifies the `signal` property at all (including explicit `null`, which
 * means "no signal" even if `input` is a `Request` carrying one); otherwise,
 * when `input` is a `Request`, its own `.signal` applies.
 *
 * Reading only `init?.signal` misses the common `fetch(new Request(url, {
 * signal }))` shape entirely — an abort firing after headers arrive would
 * never reach {@link wrapResponseForRelease}'s abort listener, leaving that
 * response's checked-out client stuck open until (if ever) something reads
 * its body.
 */
function resolveEffectiveSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | undefined {
  if (init && "signal" in init) {
    return init.signal ?? undefined;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.signal;
  }
  return undefined;
}

const BODY_CONSUMER_METHODS = new Set<PropertyKey>([
  "arrayBuffer",
  "blob",
  "bytes",
  "formData",
  "json",
  "text",
]);

/**
 * Wrap a `ReadableStream` so exactly one of `onDrained`/`onDiscard` fires
 * once the stream is fully drained, cancelled, or errors.
 *
 * Hooks/SSE consumes `response.body` directly (as an async iterable or via
 * `getReader()`) instead of calling a body-consuming method, so without this
 * the client checkout above would never be released for a streaming
 * response — a handful of opened-and-cancelled streams could permanently
 * occupy every connection in an origin's pool and starve ordinary traffic.
 * Reimplemented as a pass-through stream (rather than e.g. `tee()`) so
 * `cancel()` propagates to the real underlying reader.
 *
 * A natural end-of-stream (`done: true`) is the only outcome that leaves the
 * HTTP/1.1 connection in a state safe to keep alive for reuse, so it alone
 * triggers `onDrained`. Cancelling mid-stream (the normal way a Hooks/SSE
 * consumer gives up on an unbounded stream) or a read error both leave
 * unknown bytes in flight on the socket — those cannot be safely
 * pipelined into a next request, so both trigger `onDiscard` instead.
 */
function wrapStreamForRelease(
  stream: ReadableStream<Uint8Array>,
  onDrained: () => void,
  onDiscard: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          onDrained();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        onDiscard();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        onDiscard();
      }
    },
  });
}

/**
 * Wrap a `Response` so exactly one of `onDrained`/`onDiscard` fires once a
 * body-consuming method settles, or once a stream obtained via the `.body`
 * getter is fully drained/cancelled/errored — i.e. exactly when the
 * connection's fate (safe to keep alive vs. must be discarded) is known, on
 * the same promise chain (or stream) the caller is already consuming.
 * Callers that never read the body never settle either callback, matching
 * real keep-alive semantics: an undrained response genuinely can't be reused
 * for the next request either.
 *
 * `signal`, when given, is the effective `AbortSignal` governing the request
 * (see {@link resolveEffectiveSignal}). An abort firing after headers arrive
 * (the response promise already settled, so the `fetch()` call site's own
 * try/catch can no longer see it) would otherwise leave the checked-out
 * client stuck open forever, since neither a body-consuming call nor a
 * `.body` read is guaranteed to ever happen — observing the signal directly
 * is what lets an abort-after-headers still discard the client and free its
 * slot for queued work.
 */
function wrapResponseForRelease(
  response: Response,
  onDrained: () => void,
  onDiscard: () => void,
  signal?: AbortSignal,
): Response {
  let settled = false;
  let detachAbortListener: (() => void) | undefined;
  const settleOnce = (action: () => void): void => {
    if (settled) return;
    settled = true;
    detachAbortListener?.();
    action();
  };
  if (signal) {
    const onAbort = () => settleOnce(onDiscard);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      detachAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
  }
  let wrappedBody: ReadableStream<Uint8Array> | null | undefined;
  return new Proxy(response, {
    get(target, property) {
      if (property === "body") {
        if (wrappedBody === undefined) {
          const original = Reflect.get(target, property, target) as ReadableStream<Uint8Array> | null;
          wrappedBody = original === null
            ? null
            : wrapStreamForRelease(
              original,
              () => settleOnce(onDrained),
              () => settleOnce(onDiscard),
            );
        }
        return wrappedBody;
      }
      if (BODY_CONSUMER_METHODS.has(property)) {
        const consume = Reflect.get(target, property, target);
        if (typeof consume === "function") {
          return async (...args: unknown[]) => {
            try {
              const result = await consume.apply(target, args);
              settleOnce(onDrained);
              return result;
            } catch (error) {
              settleOnce(onDiscard);
              throw error;
            }
          };
        }
      }
      // Getters like `.ok`/`.status` are brand-checked against a genuine
      // `Response` instance, so they must run with `target` as `this`, not
      // `receiver` (the proxy) — passing `receiver` here throws.
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A queued connection request, rejected (never left hanging) if the pool is
 * closed before a connection becomes available.
 */
interface Waiter {
  resolve: (client: ClientNamespace) => void;
  reject: (error: Error) => void;
}

/**
 * One persistent `undici.Client` per checked-out connection, up to
 * {@link MAX_CONNECTIONS_PER_ORIGIN}. Checkout is a LIFO free list we
 * manage ourselves (see module header for why) rather than `Pool`'s
 * internal client selection.
 */
class OriginConnectionPool {
  private readonly clientOptions: ClientNamespace.Options;
  private readonly all = new Set<ClientNamespace>();
  private readonly idle: ClientNamespace[] = [];
  private readonly waiters: Waiter[] = [];
  /** In-flight `client.destroy()` calls from {@link discard}, awaited by {@link close}. */
  private readonly discarding = new Set<Promise<void>>();
  /**
   * Set synchronously as the first step of {@link close}. `close()` clears
   * `all`/`idle` before its first `await`, but a caller's `fetch()` can be
   * paused mid-microtask-chain (e.g. at its own `await` inside
   * `getOriginPool`) when that happens — without this flag, that call would
   * resume into an `acquire()` that sees empty `all`/`idle` sets and treats
   * them as fresh capacity, silently opening an orphaned connection this
   * (now-closed) pool never tracks, destroys, or awaits.
   */
  private closed = false;

  constructor(
    private readonly origin: string,
    private readonly maxConnections: number,
    private readonly maxQueued: number,
    private readonly clientCtor: ClientConstructor,
    /** Invoked whenever this pool transitions between idle and in-use. */
    private readonly onIdleChange: (isIdle: boolean) => void,
  ) {
    this.clientOptions = {
      pipelining: PIPELINING,
      connectTimeout: CONNECT_TIMEOUT_MS,
      keepAliveTimeout: IDLE_TIMEOUT_MS,
      keepAliveMaxTimeout: MAX_KEEP_ALIVE_HINT_MS,
    };
  }

  /** Active (checked-out or idle) connection count. Test/introspection only. */
  get connectionCount(): number {
    return this.all.size;
  }

  /** Checked-out (in-use) connection count. Test/introspection only. */
  get checkedOutCount(): number {
    return this.all.size - this.idle.length;
  }

  /** Queued acquisitions awaiting a free connection. Test/introspection only. */
  get queuedCount(): number {
    return this.waiters.length;
  }

  /**
   * No checked-out connections and no queued acquisitions — i.e. genuinely
   * safe to close without dropping in-flight or queued work. A pool with a
   * long-lived open request (e.g. Hooks/SSE) is never idle, however long
   * that request has been running.
   */
  get isIdle(): boolean {
    return this.checkedOutCount === 0 && this.waiters.length === 0;
  }

  private acquire(): ClientNamespace | Promise<ClientNamespace> {
    if (this.closed) {
      throw new Error(`Node transport pool for ${this.origin} closed while a request was starting`);
    }

    const wasIdle = this.isIdle;
    let result: ClientNamespace | Promise<ClientNamespace>;

    const idleClient = this.idle.pop();
    if (idleClient) {
      result = idleClient;
    } else if (this.all.size < this.maxConnections) {
      const client = new this.clientCtor(this.origin, this.clientOptions);
      this.all.add(client);
      result = client;
    } else if (this.waiters.length >= this.maxQueued) {
      throw new TransportQueueLimitError(this.origin, this.maxQueued);
    } else {
      result = new Promise<ClientNamespace>((resolve, reject) => this.waiters.push({ resolve, reject }));
    }

    if (wasIdle) this.onIdleChange(false);
    return result;
  }

  private release(client: ClientNamespace): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      // Hand the connection directly to the next queued caller instead of
      // round-tripping through the idle stack. Still checked out, so no
      // idle-state transition here.
      waiter.resolve(client);
      return;
    }
    this.idle.push(client);
    if (this.isIdle) this.onIdleChange(true);
  }

  /**
   * Discard and destroy a checked-out connection whose state is unknown or
   * unsafe to reuse (cancellation, body error, abort, peer reset, or a
   * dispatch rejection) instead of returning it to the idle pool.
   *
   * The freed capacity is handed to the next queued waiter, if any, as a
   * brand-new connection — never the discarded one, since its socket state
   * is exactly what made it unsafe to reuse in the first place.
   */
  private discard(client: ClientNamespace): void {
    this.all.delete(client);
    const destroying = client.destroy().catch(() => {
      // Best-effort: we only need the socket gone, not confirmation.
    });
    this.discarding.add(destroying);
    void destroying.finally(() => this.discarding.delete(destroying));

    const waiter = this.waiters.shift();
    if (waiter) {
      const replacement = new this.clientCtor(this.origin, this.clientOptions);
      this.all.add(replacement);
      waiter.resolve(replacement);
      return;
    }
    if (this.isIdle) this.onIdleChange(true);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const client = await this.acquire();
    let response: Response;
    try {
      const nodeInit: NodeFetchInit = { ...init, dispatcher: client };
      response = await globalThis.fetch(input, nodeInit as RequestInit);
    } catch (error) {
      this.discard(client);
      throw error;
    }

    // No body to drain (HEAD, 204, 304, or an explicitly null body): the
    // connection is already free, so release it now rather than waiting
    // for a body-consuming call that will never come.
    if (response.body === null || response.status === 204 || response.status === 304) {
      this.release(client);
      return response;
    }

    return wrapResponseForRelease(
      response,
      () => this.release(client),
      () => this.discard(client),
      resolveEffectiveSignal(input, init),
    );
  }

  /**
   * Close every held connection and reject any queued acquisitions — a
   * queued caller must be told the pool is gone rather than hang forever
   * awaiting a connection that will never arrive.
   *
   * Uses `destroy()`, not `close()`: `close()` gracefully waits for any
   * in-flight request on that client to finish first, which would hang
   * shutdown indefinitely against a server that never responds to a
   * checked-out client's outstanding request.
   */
  async close(): Promise<void> {
    // Set before anything else (including before the first `await`): this
    // is what makes a same-origin `acquire()` racing this call observe a
    // closed pool instead of an emptied-but-still-open one. See the
    // `closed` field doc for why that race is otherwise reachable.
    this.closed = true;
    const closing = [...this.all].map((client) =>
      client.destroy().catch(() => {
        // Best-effort: the client is already unreachable from new requests.
      }),
    );
    this.all.clear();
    this.idle.length = 0;
    const pendingWaiters = this.waiters.splice(0);
    for (const waiter of pendingWaiters) {
      waiter.reject(new Error(`Node transport pool for ${this.origin} closed while a request was queued`));
    }
    await Promise.all([...closing, ...this.discarding]);
  }
}

interface OriginEntry {
  pool: OriginConnectionPool;
  /**
   * Timestamp the pool last became fully idle, or `undefined` while it has
   * checked-out connections or queued acquisitions. Only an `idleSince`
   * origin is eligible for idle-timeout or capacity eviction — this is what
   * keeps a long-lived Hooks/SSE request (open far longer than
   * {@link IDLE_TIMEOUT_MS}) from having its origin reclaimed out from
   * under it.
   */
  idleSince: number | undefined;
  /** Pending precise eviction timer scheduled from {@link idleSince}, if any. */
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Thrown when a request is made after {@link BoundedNodeTransportManager.shutdown} has started. */
export class TransportManagerClosedError extends Error {
  constructor() {
    super("Node transport manager is shut down and cannot open new connections");
    this.name = "TransportManagerClosedError";
  }
}

/** Thrown when an origin's acquisition queue is already at {@link MAX_QUEUED_PER_ORIGIN}. */
export class TransportQueueLimitError extends Error {
  constructor(origin: string, limit: number) {
    super(
      `Node transport queue for ${origin} is full: ${limit} requests are already waiting for a connection`,
    );
    this.name = "TransportQueueLimitError";
  }
}

/** Thrown when a new origin cannot be admitted because every retained origin is active. */
export class TransportOriginLimitError extends Error {
  constructor(origin: string, limit: number) {
    super(
      `Node transport cannot open origin ${origin}: ${limit} origins are already retained and active (no idle origin available to evict)`,
    );
    this.name = "TransportOriginLimitError";
  }
}

/**
 * Bounded per-origin connection-pool registry. One instance is meant to be
 * shared for the lifetime of the process (see {@link getSharedNodeTransportManager}).
 *
 * Origins are evicted (closed) when fully idle for {@link IDLE_TIMEOUT_MS},
 * or, failing that, the oldest-idle origin is evicted first once
 * {@link MAX_RETAINED_ORIGINS} is reached — so retained state can never grow
 * unbounded regardless of how many distinct hosts a process talks to.
 * Active origins (checked-out connections or queued acquisitions) are never
 * evicted; if every retained origin is active when a new one is needed, the
 * request fails with {@link TransportOriginLimitError} rather than silently
 * exceeding the bound.
 */
export class BoundedNodeTransportManager {
  private readonly origins = new Map<string, OriginEntry>();
  /** Close() promises for origins currently being torn down, keyed by origin. */
  private readonly closing = new Map<string, Promise<void>>();
  /**
   * In-flight first-time creation promises, keyed by origin. Registered
   * synchronously before the only `await` in {@link createOriginPool} so
   * concurrent `getOriginPool()` calls racing for the same brand-new origin
   * (e.g. several requests fired at once at startup) all observe and await
   * the same promise instead of each independently concluding no pool
   * exists yet and constructing its own — which would silently multiply the
   * per-origin connection cap by however many requests raced the creation.
   */
  private readonly creating = new Map<string, Promise<OriginConnectionPool>>();
  /**
   * Set synchronously as the first step of {@link shutdown}, before any
   * `await`, for the same reason `OriginConnectionPool.closed` is: without
   * it, a `fetch()` call already paused mid-microtask-chain when shutdown
   * starts could resume into `getOriginPool` and open a brand-new origin
   * this manager will never track or close.
   */
  private closed = false;
  private clientCtor?: ClientConstructor;

  private async ensureClientConstructor(): Promise<ClientConstructor> {
    if (!this.clientCtor) {
      this.clientCtor = await resolveClientConstructor();
    }
    return this.clientCtor;
  }

  /**
   * Schedule (or reschedule) a precise eviction for `origin` exactly
   * {@link IDLE_TIMEOUT_MS} after it became idle, instead of relying on a
   * periodic sweep — a fixed-interval sweep can retain an origin idle for
   * up to nearly double the configured bound depending on when it happens
   * to go idle relative to the last tick.
   */
  private scheduleIdleEviction(origin: string, entry: OriginEntry): void {
    this.cancelIdleEviction(entry);
    const timer = setTimeout(() => {
      const current = this.origins.get(origin);
      if (current === entry && entry.idleSince !== undefined) {
        this.closeEntry(origin, entry);
      }
    }, IDLE_TIMEOUT_MS);
    timer.unref?.();
    entry.idleTimer = timer;
  }

  private cancelIdleEviction(entry: OriginEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  /** Evict the oldest fully-idle origin, if any. Returns whether one was evicted. */
  private evictOldestIdleOrigin(): boolean {
    let oldestOrigin: string | undefined;
    let oldestAt = Infinity;
    for (const [origin, entry] of this.origins) {
      if (entry.idleSince !== undefined && entry.idleSince < oldestAt) {
        oldestAt = entry.idleSince;
        oldestOrigin = origin;
      }
    }
    if (oldestOrigin === undefined) return false;
    const entry = this.origins.get(oldestOrigin);
    if (!entry) return false;
    this.closeEntry(oldestOrigin, entry);
    return true;
  }

  /**
   * Remove `origin`'s entry and start (but do not await) closing its pool.
   * The close is tracked in {@link closing} so a request for the same
   * origin arriving before the close finishes waits for it instead of
   * opening a second, overlapping set of connections to that origin.
   */
  private closeEntry(origin: string, entry: OriginEntry): void {
    this.cancelIdleEviction(entry);
    this.origins.delete(origin);
    const closePromise = entry.pool.close();
    this.closing.set(origin, closePromise);
    void closePromise.finally(() => {
      if (this.closing.get(origin) === closePromise) {
        this.closing.delete(origin);
      }
    });
  }

  private async getOriginPool(origin: string): Promise<OriginConnectionPool> {
    if (this.closed) {
      throw new TransportManagerClosedError();
    }

    const pendingClose = this.closing.get(origin);
    if (pendingClose) {
      // Let a just-evicted origin's teardown finish before reusing its key,
      // so the old and new connection sets for that origin never overlap.
      await pendingClose;
    }
    // Re-check: shutdown() may have started while the above await was pending.
    if (this.closed) {
      throw new TransportManagerClosedError();
    }

    const existing = this.origins.get(origin);
    if (existing) {
      return existing.pool;
    }

    // A creation already in flight for this origin (from a concurrent
    // caller that reached here first): await and share its result rather
    // than starting a second, independent pool for the same origin.
    const pendingCreate = this.creating.get(origin);
    if (pendingCreate) {
      return pendingCreate;
    }

    // Registered synchronously (before the `await` inside) so any other
    // `getOriginPool()` call for this origin that runs before this one
    // resolves sees it via `this.creating.get(origin)` above.
    const createPromise = this.createOriginPool(origin);
    this.creating.set(origin, createPromise);
    try {
      return await createPromise;
    } finally {
      if (this.creating.get(origin) === createPromise) {
        this.creating.delete(origin);
      }
    }
  }

  private async createOriginPool(origin: string): Promise<OriginConnectionPool> {
    // Counts both fully-registered origins (`this.origins`) and creations
    // already admitted but still in flight (`this.creating`) — the latter
    // have not inserted into `this.origins` yet (that only happens after the
    // `await` below), so checking `this.origins.size` alone would let every
    // concurrent first-time request to a distinct origin observe spare
    // capacity and all pass this check before any of them registers,
    // admitting more than `MAX_RETAINED_ORIGINS` origins at once. Because
    // `getOriginPool` registers its entry in `this.creating` synchronously
    // right after calling this method (before yielding to any other call),
    // this check always sees every concurrent admission that was accepted
    // earlier in the same synchronous burst.
    if (this.origins.size + this.creating.size >= MAX_RETAINED_ORIGINS) {
      const evicted = this.evictOldestIdleOrigin();
      if (!evicted) {
        throw new TransportOriginLimitError(origin, MAX_RETAINED_ORIGINS);
      }
    }

    const clientCtor = await this.ensureClientConstructor();
    // Re-check again: shutdown() may have started during constructor resolution.
    if (this.closed) {
      throw new TransportManagerClosedError();
    }

    const entry: OriginEntry = {
      pool: undefined as unknown as OriginConnectionPool,
      idleSince: Date.now(),
      idleTimer: undefined,
    };
    entry.pool = new OriginConnectionPool(
      origin,
      MAX_CONNECTIONS_PER_ORIGIN,
      MAX_QUEUED_PER_ORIGIN,
      clientCtor,
      (isIdle) => {
        if (isIdle) {
          entry.idleSince = Date.now();
          this.scheduleIdleEviction(origin, entry);
        } else {
          entry.idleSince = undefined;
          this.cancelIdleEviction(entry);
        }
      },
    );
    this.origins.set(origin, entry);
    this.scheduleIdleEviction(origin, entry);
    return entry.pool;
  }

  /** Number of distinct origins currently retained. Test/introspection only. */
  get originCount(): number {
    return this.origins.size;
  }

  /**
   * Bound method: safe to hand out as a `typeof fetch` value (e.g. assigned
   * to `TinyCloudNode`'s resolved default fetch) without losing `this`.
   */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    if (this.closed) {
      throw new TransportManagerClosedError();
    }
    const origin = new URL(resolveRequestUrl(input)).origin;
    const pool = await this.getOriginPool(origin);
    return pool.fetch(input, init);
  };

  /**
   * Deterministically close every pooled connection and stop all idle
   * eviction timers, rejecting any queued acquisitions rather than leaving
   * them to hang. Not wired to any process-exit signal — this package does
   * not install a `process.on("exit"/"SIGINT"/"SIGTERM")` hook, since the
   * process-wide shared manager (see {@link getSharedNodeTransportManager})
   * is meant to live for the process's natural lifetime and its sockets are
   * `unref()`'d (see {@link scheduleIdleEviction}), so they never keep the
   * process alive on their own. `shutdown()` exists as an explicit lifecycle
   * seam for callers (currently only this package's own test suite, via
   * {@link __resetNodeTransportForTests}) that need pooled connections
   * closed deterministically before continuing.
   */
  async shutdown(): Promise<void> {
    // Set before anything else (including before the first `await`): see
    // the `closed` field doc for why a same-tick `fetch()` race otherwise
    // reaches `getOriginPool` and opens an origin this manager never closes.
    this.closed = true;
    for (const entry of this.origins.values()) {
      this.cancelIdleEviction(entry);
    }
    const stillClosing = [...this.closing.values()];
    const closingNow = [...this.origins.values()].map((entry) => entry.pool.close());
    this.origins.clear();
    this.closing.clear();
    await Promise.all([...stillClosing, ...closingNow]);
  }
}

let sharedManager: BoundedNodeTransportManager | undefined;

/** The process-wide bounded transport manager. Created lazily, once. */
export function getSharedNodeTransportManager(): BoundedNodeTransportManager {
  if (!sharedManager) {
    sharedManager = new BoundedNodeTransportManager();
  }
  return sharedManager;
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Default fetch for Node-initialized TinyCloudNode instances.
 *
 * Bun ships its own bounded `fetch` connection pool; handing Bun a Node
 * `undici` dispatcher would be redundant at best and is not guaranteed to
 * behave the same way, so Bun keeps using its native global fetch.
 */
export function getDefaultNodeFetch(): typeof fetch {
  if (isBunRuntime()) {
    // Forward rather than eagerly `.bind()` the current `globalThis.fetch`:
    // this keeps working if a caller (e.g. a test double) reassigns
    // `globalThis.fetch` after this function has already been called and
    // its result stored on a long-lived instance.
    return (input, init) => globalThis.fetch(input, init);
  }
  return getSharedNodeTransportManager().fetch;
}

/**
 * Test-only deterministic shutdown seam. Closes and discards the current
 * shared manager (if any) so the next {@link getSharedNodeTransportManager}
 * call starts clean. Not part of the package's public API.
 * @internal
 */
export async function __resetNodeTransportForTests(): Promise<void> {
  const manager = sharedManager;
  sharedManager = undefined;
  if (manager) await manager.shutdown();
}
