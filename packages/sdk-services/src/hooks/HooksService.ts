import { BaseService } from "../base/BaseService";
import type { RequestSignal } from "../base/types";
import type {
  FetchResponse,
  InvokeAnyEntry,
  ServiceError,
  ServiceHeaders,
  ServiceSession,
  Result,
} from "../types";
import { ErrorCodes, err, ok, serviceError } from "../types";
import { authRequiredError, wrapError } from "../errors";
import type { IHooksService } from "./IHooksService";
import type {
  HookEvent,
  HookStreamEvent,
  HookSubscription,
  HooksServiceConfig,
  SubscribeOptions,
  HookWebhookListOptions,
  HookWebhookRecord,
  HookWebhookRegistration,
  HookWebhookUnregisterOptions,
} from "./types";

interface HookSubscriber {
  requested: HookSubscription[];
  /** `subscriptionSignature` of each requested entry, fixed at subscribe time. */
  signatures: string[];
  ttlSeconds?: number;
  queue: AsyncQueue<HookEvent>;
}

/** The one stream the current subscribers need. */
interface StreamPlan {
  /** Session generation + merged subscriptions + TTL; a change supersedes the running phase. */
  key: string;
  subscriptions: HookSubscription[];
  ttlSeconds?: number;
}

type StreamPhase = "mint" | "open" | "read";

/** How one attempt ended. Holds only SDK-built values. */
type AttemptOutcome =
  | { kind: "ended" }
  | { kind: "stopped" }
  | { kind: "refused"; terminal: boolean; error: ServiceError }
  | { kind: "failed"; error: ServiceError };

interface StreamHealth {
  openedAt: number;
  delivered: boolean;
  contextSignal?: AbortSignal;
}
class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure?: unknown;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  push(value: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({ value: undefined as never, done: true });
    }
  }

  /**
   * Fail the queue: pending and future `next()` calls reject with `error`,
   * so a `for await` consumer sees the iterator throw.
   */
  fail(error: unknown): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.failure = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      const value = this.values.shift()!;
      return Promise.resolve({ value, done: false });
    }

    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }

    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

/** First shared-stream retry delay: fast enough to ride out a ticket 401. */
const HOOK_STREAM_RETRY_BASE_DELAY_MS = 250;
/** Ceiling for shared-stream retry backoff. */
const HOOK_STREAM_RETRY_MAX_DELAY_MS = 30_000;
/**
 * A stream that stays open at least this long without erroring counts as
 * healthy and resets the backoff streak. A stream that delivers an event
 * resets it immediately.
 */
const HOOK_STREAM_HEALTHY_MS = 5_000;

export class HooksService extends BaseService implements IHooksService {
  static readonly serviceName = "hooks";

  declare protected _config: HooksServiceConfig;
  private readonly _subscribers: Set<HookSubscriber> = new Set();
  /** True while the one supervisor loop runs. Set only by wake(), cleared only at loop exit. */
  private _supervising = false;
  /** The supervisor's current step, interruptible by wake(). */
  private _phase?: { key: string; interrupt: AbortController };
  /** Bumped on every session change; part of the plan key. */
  private _sessionGeneration = 0;

  constructor(config: HooksServiceConfig = {}) {
    super();
    this._config = config;
  }

  get config(): HooksServiceConfig {
    return this._config;
  }

  private get host(): string {
    return this._config.host ?? this.context.hosts[0];
  }

  async *subscribe(
    subscriptions: HookSubscription[],
    options: SubscribeOptions = {},
  ): AsyncIterable<HookEvent> {
    if (!this.requireAuth()) {
      throw new Error("Authentication required for hooks subscription");
    }
    if (subscriptions.length === 0) {
      throw new Error("At least one hook subscription is required");
    }

    const requested = subscriptions.map(normalizeSubscription);
    const subscriber: HookSubscriber = {
      requested,
      signatures: requested.map(subscriptionSignature),
      ttlSeconds: options.ttlSeconds,
      queue: new AsyncQueue<HookEvent>(),
    };
    const leave = (): void => {
      this._subscribers.delete(subscriber);
      subscriber.queue.close();
      this.wake();
    };
    const { signal } = options;
    if (signal?.aborted) {
      return;
    }
    signal?.addEventListener("abort", leave, { once: true });
    this._subscribers.add(subscriber);
    this.wake();

    try {
      for await (const event of subscriber.queue) {
        yield event;
      }
    } finally {
      signal?.removeEventListener("abort", leave);
      leave();
    }
  }

  async register(
    webhook: HookWebhookRegistration,
  ): Promise<Result<HookWebhookRecord>> {
    if (!this.requireAuth()) {
      return err(authRequiredError("hooks"));
    }

    if (typeof webhook.secret !== "string" || webhook.secret.trim().length === 0) {
      return err(
        serviceError(
          ErrorCodes.INVALID_INPUT,
          "Webhook secret is required",
          "hooks",
          { meta: { field: "secret" } },
        ),
      );
    }

    try {
      const response = await this.context.fetch(`${this.host}/hooks/webhooks`, {
        method: "POST",
        headers: {
          ...serviceHeadersToRecord(
            this.createHookHeaders(
              "tinycloud.hooks/register",
              buildScopePath(webhook.service, webhook.pathPrefix),
            ),
          ),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          space: webhook.space,
          service: webhook.service,
          pathPrefix: normalizePathPrefix(webhook.pathPrefix),
          abilities: webhook.abilities ?? [],
          callbackUrl: webhook.callbackUrl,
          secret: webhook.secret,
        }),
      });

      if (!response.ok) {
        return err(
          await responseError("hooks", "failed to register webhook", response),
        );
      }

      const data = normalizeWebhookRecord(await response.json());
      if (!data) {
        return err(
          wrapError(
            "hooks",
            new Error("Webhook registration response did not include a record"),
          ),
        );
      }

      return ok(data);
    } catch (error) {
      return err(wrapError("hooks", error));
    }
  }

  async list(
    options: HookWebhookListOptions = {},
  ): Promise<Result<HookWebhookRecord[]>> {
    if (!this.requireAuth()) {
      return err(authRequiredError("hooks"));
    }

    try {
      const query = new URLSearchParams();
      if (options.space) {
        query.set("space", options.space);
      }
      if (options.service) {
        query.set("service", options.service);
      }
      if (options.pathPrefix) {
        const normalizedPrefix = normalizePathPrefix(options.pathPrefix);
        if (normalizedPrefix) {
          query.set("prefix", normalizedPrefix);
        }
      }

      const response = await this.context.fetch(
        `${this.host}/hooks/webhooks${query.size > 0 ? `?${query.toString()}` : ""}`,
        {
          method: "GET",
          headers: serviceHeadersToRecord(
            this.createHookHeaders(
              "tinycloud.hooks/list",
              options.service
                ? buildScopePath(options.service, options.pathPrefix)
                : "webhooks",
            ),
          ),
        },
      );

      if (!response.ok) {
        return err(
          await responseError("hooks", "failed to list webhooks", response),
        );
      }

      const payload = await response.json();
      const records = normalizeWebhookRecordList(payload);
      if (!records) {
        return err(
          wrapError(
            "hooks",
            new Error("Webhook list response did not include records"),
          ),
        );
      }

      return ok(records);
    } catch (error) {
      return err(wrapError("hooks", error));
    }
  }

  async unregister(
    id: string,
    options: HookWebhookUnregisterOptions = {},
  ): Promise<Result<void>> {
    if (!this.requireAuth()) {
      return err(authRequiredError("hooks"));
    }

    try {
      const response = await this.context.fetch(
        `${this.host}/hooks/webhooks/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: serviceHeadersToRecord(
            this.createHookHeaders(
              "tinycloud.hooks/unregister",
              options.target
                ? buildScopePath(
                    options.target.service,
                    options.target.pathPrefix,
                  )
                : `webhooks/${id}`,
            ),
          ),
        },
      );

      if (!response.ok) {
        return err(
          await responseError(
            "hooks",
            "failed to unregister webhook",
            response,
          ),
        );
      }

      return ok(undefined);
    } catch (error) {
      return err(wrapError("hooks", error));
    }
  }

  /**
   * Called after anything that may change what the supervisor should do:
   * subscribe, unsubscribe, session change, sign-out. Interrupts the running
   * step if the plan moved away from it, and starts the supervisor if none
   * runs. Touches only SDK-owned state, so it never throws into callers such
   * as `ServiceContext.setSession`.
   */
  private wake(): void {
    const phase = this._phase;
    if (phase && phase.key !== this.plan()?.key) {
      phase.interrupt.abort();
    }
    if (this._supervising || this._subscribers.size === 0) {
      return;
    }
    this._supervising = true;
    this.supervise().catch(() => this.collapse());
  }

  /**
   * The only owner of the shared stream. Each iteration is one attempt
   * (mint → open → drain), then a classification and, unless the attempt was
   * superseded or released its subscribers, a backoff. Every await is a
   * `phase` that wake() can interrupt; an interrupted phase yields
   * `undefined`, so a superseded mint can never act. Outside `attempt` and
   * `pause`, which each own one catch, the loop touches only SDK state.
   */
  private async supervise(): Promise<void> {
    let streak = 0;
    for (;;) {
      const plan = this.plan();
      if (!plan) {
        // Same synchronous turn as the emptiness check: a subscribe() that
        // runs after this line starts a fresh supervisor.
        this._supervising = false;
        return;
      }
      const health: StreamHealth = { openedAt: 0, delivered: false };
      const outcome = await this.phase(plan.key, (signal) =>
        this.attempt(plan, signal, health),
      );
      if (
        health.delivered ||
        (health.openedAt > 0 &&
          performance.now() - health.openedAt >= HOOK_STREAM_HEALTHY_MS)
      ) {
        streak = 0;
      }
      if (!outcome) {
        continue;
      }
      if (outcome.kind === "stopped") {
        this.release();
        continue;
      }
      if (outcome.kind === "refused" && outcome.terminal) {
        this.release(outcome.error);
        this.report(outcome.error);
        continue;
      }
      if (outcome.kind !== "ended") {
        this.report(outcome.error);
      }
      streak += 1;
      await this.phase(plan.key, (signal) =>
        this.pause(streak, signal, health.contextSignal),
      );
  }
  }

  /**
   * Run one step under an interrupt that wake() fires when the plan key moves
   * on. An interrupted step's result is discarded. The interrupt is also
   * fired when the step returns, which releases whatever it left open: the
   * request signal and its listeners, an unread response body, a timer.
   */
  private async phase<T>(
    key: string,
    step: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const interrupt = new AbortController();
    this._phase = { key, interrupt };
    try {
      if (this.plan()?.key !== key) {
        // A wake between two phases found nothing to interrupt.
        interrupt.abort();
      }
      const result = await step(interrupt.signal);
      return interrupt.signal.aborted ? undefined : result;
    } finally {
      this._phase = undefined;
      interrupt.abort();
    }
  }

  /**
   * One mint → open → drain. The single catch site for everything the
   * attempt touches that the SDK does not own: context accessors, invoke,
   * fetch, response bodies, the SSE parser. Never rejects.
   */
  private async attempt(
    plan: StreamPlan,
    signal: AbortSignal,
    health: StreamHealth,
  ): Promise<AttemptOutcome> {
    let phase: StreamPhase = "mint";
    let request: RequestSignal | undefined;
    try {
      const context = this.context;
      health.contextSignal = context.abortSignal;
      if (!context.isAuthenticated || health.contextSignal?.aborted) {
        return { kind: "stopped" };
      }
      // Aborts on the interrupt, sign-out, or context abort. Released by the
      // interrupt that `phase` fires when this attempt returns.
      request = this.createRequestSignal(signal, 0);
      const host = this.host;
      const minted = await context.fetch(`${host}/hooks/tickets`, {
        method: "POST",
        headers: {
          ...serviceHeadersToRecord(this.createInvokeHeaders(plan.subscriptions)),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          subscriptions: plan.subscriptions,
          ttlSeconds: plan.ttlSeconds,
        }),
        signal: request.signal,
      });
      if (!minted.ok) {
        // The mint request carries no ticket, so responseError's body is safe.
        const status = minted.status;
        const error = await responseError(
          "hooks",
          "failed to mint hook ticket",
          minted,
        );
        return {
          kind: "refused",
          terminal: isTerminalMintRefusal(status),
          error,
        };
      }
      const body: unknown = await minted.json();
      const ticket =
        body !== null && typeof body === "object" && "ticket" in body
          ? body.ticket
          : undefined;
      if (typeof ticket !== "string" || ticket.length === 0) {
        throw new Error("Hook ticket response did not include a ticket");
      }

      phase = "open";
      // The node reads the ticket only from the query (1.19.2).
      const stream = await context.fetch(
        `${host}/hooks/events?ticket=${encodeURIComponent(ticket)}`,
        {
          method: "GET",
          headers: { accept: "text/event-stream" },
          signal: request.signal,
        },
      );
      if (!stream.ok) {
        // 401/403 here is an expired or rotated ticket: the next attempt re-mints.
        return {
          kind: "refused",
          terminal: false,
          error: hookStreamRefusal(stream.status),
        };
      }

      health.openedAt = performance.now();
      for await (const message of parseSseStream(stream.body, request.signal)) {
        if (!message.data) {
          continue;
        }
        this.dispatch(parseHookEvent(message));
        health.delivered = true;
      }
      return request.signal.aborted ? { kind: "stopped" } : { kind: "ended" };
    } catch (thrown) {
      // An aborted request means the interrupt (discarded by `phase`) or the
      // lifecycle ended; anything else is a failure, described by allow-list.
      return request?.signal.aborted
        ? { kind: "stopped" }
        : { kind: "failed", error: hookStreamFailure(phase, thrown) };
    }
  }

  /**
   * Back off before the next attempt. `config.streamRetry` overrides the
   * delay and the clock; whatever they do, the pause ends by the delay or the
   * interrupt, and then yields one real event-loop turn so an instant clock
   * cannot let a failing stream starve the process.
   */
  private async pause(
    attempt: number,
    signal: AbortSignal,
    contextSignal?: AbortSignal,
  ): Promise<void> {
    const waits: Promise<void>[] = [];
    const aborts: Array<{ promise: Promise<void>; dispose: () => void }> = [];
    try {
      const retry = this._config.streamRetry;
      const delayMs = retry?.delay?.(attempt) ?? hookStreamRetryDelay(attempt);
      waits.push((retry?.wait ?? sleep)(delayMs, attempt, signal));
    } catch {
      // A throwing delay callback or wait counts as an elapsed delay.
      waits.push(Promise.resolve());
    }
    aborts.push(abortPromise(signal));
    if (contextSignal) aborts.push(abortPromise(contextSignal));
    try {
      await Promise.race([...waits, ...aborts.map(({ promise }) => promise)]);
    } catch {
      // A rejecting custom clock counts as an elapsed delay.
    } finally {
      for (const abort of aborts) abort.dispose();
    }
    await new Promise<void>((resolve) => {
      if (typeof setImmediate === "function") {
        setImmediate(resolve);
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /** The stream the current subscribers need, or undefined when none remain. */
  private plan(): StreamPlan | undefined {
    if (this._subscribers.size === 0) {
      return undefined;
    }
    const merged = new Map<string, HookSubscription>();
    let ttlSeconds: number | undefined;
    for (const subscriber of this._subscribers) {
      subscriber.requested.forEach((subscription, index) =>
        merged.set(subscriber.signatures[index], subscription),
      );
      if (typeof subscriber.ttlSeconds === "number") {
        ttlSeconds = Math.min(subscriber.ttlSeconds, ttlSeconds ?? Infinity);
      }
    }
    const signatures = [...merged.keys()].sort();
    return {
      key: JSON.stringify([this._sessionGeneration, signatures, ttlSeconds ?? null]),
      subscriptions: signatures.map((signature) => merged.get(signature)!),
      ttlSeconds,
    };
  }

  private dispatch(event: HookEvent): void {
    for (const subscriber of this._subscribers) {
      if (matchesAnySubscription(event, subscriber.requested)) {
        subscriber.queue.push(event);
      }
    }
  }

  /**
   * Detach every subscriber. With `error`, their iterators throw it after
   * draining buffered events; without, they complete.
   */
  private release(error?: ServiceError): void {
    const subscribers = [...this._subscribers];
    this._subscribers.clear();
    for (const { queue } of subscribers) {
      if (error) {
        queue.fail(error);
      } else {
        queue.close();
      }
    }
  }

  private report(error: ServiceError): void {
    if (error.meta && typeof error.meta === "object") {
      Object.freeze(error.meta);
    }
    Object.freeze(error);
    try {
      this.emitError(error, "stream");
    } catch {
      // Telemetry never steers the stream.
    }
  }

  /**
   * Unreachable by construction. If the loop ever rejects anyway, fail its
   * subscribers visibly instead of stranding them or crashing the process.
   */
  private collapse(): void {
    this._supervising = false;
    this._phase?.interrupt.abort();
    this._phase = undefined;
    const error = serviceError(
      ErrorCodes.NETWORK_ERROR,
      "hook stream supervisor stopped unexpectedly",
      "hooks",
    );
    this.report(error);
    this.release(error);
  }

  override onSessionChange(session: ServiceSession | null): void {
    super.onSessionChange(session);
    // New credentials supersede the running attempt: it re-mints, or stops
    // if the session is gone.
    this._sessionGeneration += 1;
    this.wake();
  }

  override onSignOut(): void {
    super.onSignOut();
    // Sign-out ends every subscription; the empty plan stops the supervisor.
    this.release();
    this.wake();
  }

  private createHookHeaders(action: string, path: string): ServiceHeaders {
    return this.context.invoke(this.session, "hooks", path, action);
  }

  private createInvokeHeaders(
    subscriptions: HookSubscription[],
  ): ServiceHeaders {
    const entries: InvokeAnyEntry[] = subscriptions.map((subscription) => ({
      spaceId: subscription.space,
      service: "hooks",
      path: subscription.pathPrefix
        ? `${subscription.service}/${subscription.pathPrefix}`
        : subscription.service,
      action: "tinycloud.hooks/subscribe",
    }));

    if (this.context.invokeAny) {
      return this.context.invokeAny(this.session, entries);
    }

    if (entries.length === 1) {
      const entry = entries[0];
      return this.context.invoke(
        this.session,
        entry.service,
        entry.path,
        entry.action,
      );
    }

    throw new Error(
      "This SDK runtime does not support multi-scope hook invocations",
    );
  }
}

function buildScopePath(
  service: HookSubscription["service"],
  pathPrefix?: string,
): string {
  const normalized = normalizePathPrefix(pathPrefix);
  return normalized ? `${service}/${normalized}` : service;
}

/**
 * Exponential backoff for the shared hook stream, with equal jitter: each
 * delay lands in [cap/2, cap] where cap doubles per attempt, so retries are
 * never zero-delay and never exceed HOOK_STREAM_RETRY_MAX_DELAY_MS.
 */
function hookStreamRetryDelay(attempt: number): number {
  const cap = Math.min(
    HOOK_STREAM_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    HOOK_STREAM_RETRY_MAX_DELAY_MS,
  );
  return cap / 2 + Math.random() * (cap / 2);
}

/**
 * A 4xx mint refusal is the node saying no for this session and scope set,
 * so retrying cannot help. 408 and 429 mean "not now".
 */
function isTerminalMintRefusal(status: unknown): boolean {
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

/*
 * Stream errors are built from an allow-list, never copied. Past the mint the
 * ticket rides in the request URL, and a mint request carries invocation
 * headers, so any foreign error text (message, cause, stack, meta, a
 * response body) may hold a bearer credential. These builders keep the
 * phase, a numeric HTTP status, and the thrown value's `name`/`code` when
 * they are plain identifiers. Nothing else crosses into telemetry.
 */
function hookStreamRefusal(status: unknown): ServiceError {
  const code = typeof status === "number" ? status : undefined;
  return serviceError(
    ErrorCodes.NETWORK_ERROR,
    `hook stream open refused: ${code ?? "unknown status"}`,
    "hooks",
    { meta: { phase: "open", status: code } },
  );
}

const STREAM_ERROR_NAMES: Record<string, true> = {
  Error: true,
  TypeError: true,
  AbortError: true,
  TimeoutError: true,
  SyntaxError: true,
  RangeError: true,
  NetworkError: true,
};

function hookStreamFailure(phase: StreamPhase, thrown: unknown): ServiceError {
  const candidateName = readProperty(thrown, "name");
  const name =
    typeof candidateName === "string" && STREAM_ERROR_NAMES[candidateName]
      ? candidateName
      : "Error";
  const code =
    identifier(readProperty(thrown, "code")) ??
    identifier(readProperty(readProperty(thrown, "cause"), "code"));
  return serviceError(
    ErrorCodes.NETWORK_ERROR,
    `hook stream ${phase} failed: ${name}${code ? ` (${code})` : ""}`,
    "hooks",
    { meta: { phase, errorName: name, ...(code ? { errorCode: code } : {}) } },
  );
}

/** Accept only errno/undici-style codes, never arbitrary foreign identifiers. */
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,47}$/.test(value)
    ? value
    : undefined;
}

/** Read one property off a value the SDK does not own; a throwing getter or proxy trap reads as absent. */
function readProperty(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

/** The default retry clock: abortable and unref'd, so a parked backoff never keeps the process alive. */
function sleep(delayMs: number, _attempt: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    const stop = (): void => finish();
    if (signal.aborted) {
      finish();
    } else {
      signal.addEventListener("abort", stop, { once: true });
    }
  });
}

function abortPromise(signal: AbortSignal): {
  promise: Promise<void>;
  dispose: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  const onAbort = (): void => resolve();
  if (signal.aborted) {
    resolve();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

function normalizeSubscription(
  subscription: HookSubscription,
): HookSubscription {
  return {
    ...subscription,
    pathPrefix: normalizePathPrefix(subscription.pathPrefix),
    abilities: subscription.abilities ? [...subscription.abilities] : [],
  };
}

function subscriptionSignature(subscription: HookSubscription): string {
  return JSON.stringify({
    space: subscription.space,
    service: subscription.service,
    pathPrefix: subscription.pathPrefix ?? "",
    abilities: [...(subscription.abilities ?? [])].sort(),
  });
}

function matchesAnySubscription(
  event: HookEvent,
  subscriptions: HookSubscription[],
): boolean {
  return subscriptions.some((subscription) =>
    matchesSubscription(event, subscription),
  );
}

function matchesSubscription(
  event: HookEvent,
  subscription: HookSubscription,
): boolean {
  if (event.space !== subscription.space) {
    return false;
  }
  if (event.service !== subscription.service) {
    return false;
  }
  if (subscription.pathPrefix) {
    const prefix = subscription.pathPrefix.endsWith("/")
      ? subscription.pathPrefix
      : `${subscription.pathPrefix}/`;
    if (
      event.path &&
      event.path !== subscription.pathPrefix &&
      !event.path.startsWith(prefix)
    ) {
      return false;
    }
  }
  const abilities = subscription.abilities ?? [];
  if (abilities.length > 0 && !abilities.includes(event.ability)) {
    return false;
  }
  return true;
}

function normalizePathPrefix(pathPrefix?: string): string | undefined {
  if (!pathPrefix) {
    return undefined;
  }
  const trimmed = pathPrefix.replace(/^\/+|\/+$/g, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

function serviceHeadersToRecord(
  headers: ServiceHeaders,
): Record<string, string> {
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

async function responseError(
  service: string,
  message: string,
  response: FetchResponse,
): Promise<ReturnType<typeof wrapError>> {
  let detail = response.statusText;
  try {
    const text = await response.text();
    if (text) {
      detail = text;
    }
  } catch {
    // Ignore secondary body read failure.
  }
  const error = wrapError(
    service,
    new Error(`${message}: ${response.status} ${detail}`),
  );
  // Typed status so callers never have to read it back out of the message.
  return {
    ...error,
    meta: { ...error.meta, status: response.status, statusText: response.statusText },
  };
}

async function* parseSseStream(
  body: unknown,
  signal?: AbortSignal,
): AsyncIterable<HookStreamEvent> {
  if (!body) {
    throw new Error("Hook stream response does not expose a readable body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of readBodyChunks(body, signal)) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const parsed = parseSseEvent(rawEvent);
      if (parsed) {
        yield parsed;
      }
      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  const trailing = parseSseEvent(buffer.trim());
  if (trailing) {
    yield trailing;
  }
}

async function* readBodyChunks(
  body: unknown,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const asyncIterable = body as AsyncIterable<Uint8Array>;
  if (typeof asyncIterable?.[Symbol.asyncIterator] === "function") {
    for await (const chunk of asyncIterable) {
      if (signal?.aborted) {
        break;
      }
      yield chunk;
    }
    return;
  }

  const stream = body as {
    getReader?: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
      releaseLock?: () => void;
      cancel?: () => Promise<void>;
    };
  };

  if (typeof stream.getReader !== "function") {
    throw new Error("Unsupported hook stream body type");
  }

  const reader = stream.getReader();
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        yield value;
      }
    }
  } finally {
    try {
      await reader.cancel?.();
    } catch {
      // Ignore cancellation failures.
    }
    reader.releaseLock?.();
  }
}

function parseSseEvent(rawEvent: string): HookStreamEvent | null {
  if (!rawEvent) {
    return null;
  }

  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of rawEvent.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").replace(/^ /, "");
    switch (field) {
      case "event":
        event = value;
        break;
      case "id":
        id = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      default:
        break;
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    id,
    data: dataLines.join("\n"),
  };
}

function parseHookEvent(message: HookStreamEvent): HookEvent {
  const parsed = JSON.parse(message.data) as Partial<HookEvent>;
  return {
    type: "write",
    id: parsed.id ?? message.id ?? "",
    space: parsed.space ?? "",
    service: parsed.service ?? "",
    ability: parsed.ability ?? "",
    path: parsed.path,
    actor: parsed.actor ?? "",
    epoch: parsed.epoch ?? "",
    eventIndex: parsed.eventIndex ?? 0,
    timestamp: parsed.timestamp ?? "",
  };
}

function normalizeWebhookRecord(data: unknown): HookWebhookRecord | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const record = isRecordContainer(data);
  const candidate =
    pickWebhookRecord(record) ??
    normalizeWebhookRecord(record.webhook) ??
    normalizeWebhookRecord(record.hook) ??
    normalizeWebhookRecord(record.subscription) ??
    normalizeWebhookRecord(record.data);
  return candidate ?? null;
}

function normalizeWebhookRecordList(data: unknown): HookWebhookRecord[] | null {
  if (Array.isArray(data)) {
    const records = data
      .map((entry) => normalizeWebhookRecord(entry))
      .filter((entry): entry is HookWebhookRecord => entry !== null);
    return records;
  }

  if (!data || typeof data !== "object") {
    return null;
  }

  const record = isRecordContainer(data);
  const nested =
    maybeRecordArray(record.webhooks) ??
    maybeRecordArray(record.subscriptions) ??
    maybeRecordArray(record.hooks) ??
    maybeRecordArray(record.data);
  if (nested) {
    return nested;
  }

  const single = pickWebhookRecord(record);
  return single ? [single] : null;
}

function maybeRecordArray(value: unknown): HookWebhookRecord[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const records = value
    .map((entry) => normalizeWebhookRecord(entry))
    .filter((entry): entry is HookWebhookRecord => entry !== null);
  return records;
}

function pickWebhookRecord(
  value: Record<string, unknown>,
): HookWebhookRecord | null {
  const id = stringField(value, "id");
  const space = stringField(value, "space") ?? stringField(value, "spaceId");
  const service = stringField(value, "service");
  const callbackUrl =
    stringField(value, "callbackUrl") ?? stringField(value, "callback_url");
  if (!id || !space || !service || !callbackUrl) {
    return null;
  }

  return {
    id,
    space,
    service: service as HookWebhookRecord["service"],
    pathPrefix:
      optionalStringField(value, "pathPrefix") ??
      optionalStringField(value, "path_prefix"),
    abilities:
      stringArrayField(value, "abilities") ??
      parsedStringArrayField(value, "abilitiesJson") ??
      parsedStringArrayField(value, "abilities_json"),
    callbackUrl,
    active: booleanField(value, "active") ?? true,
    createdAt:
      stringField(value, "createdAt") ??
      stringField(value, "created_at") ??
      new Date().toISOString(),
    subscriberDid:
      optionalStringField(value, "subscriberDid") ??
      optionalStringField(value, "subscriber_did"),
  };
}

function isRecordContainer(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function optionalStringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return stringField(value, key);
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function stringArrayField(
  value: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const field = value[key];
  if (!Array.isArray(field)) {
    return undefined;
  }
  const strings = field.filter(
    (item): item is string => typeof item === "string",
  );
  return strings.length === field.length ? strings : undefined;
}

function parsedStringArrayField(
  value: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const field = value[key];
  if (typeof field !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(field) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const strings = parsed.filter(
      (item): item is string => typeof item === "string",
    );
    return strings.length === parsed.length ? strings : undefined;
  } catch {
    return undefined;
  }
}
