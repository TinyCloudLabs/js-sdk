import { BaseService } from "../base/BaseService";
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

interface HookTicketResponse {
  ticket: string;
  expiresAt: string;
}

interface HookSubscriber {
  requested: HookSubscription[];
  ttlSeconds?: number;
  queue: AsyncQueue<HookEvent>;
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

/**
 * Marks a failure that came from minting the hook ticket, so the detached
 * stream task can distinguish mint refusals (terminal for this subscription
 * set when the node answers 4xx) from stream-open failures (recoverable by
 * re-minting). Never logged; the wrapped error is surfaced to subscribers.
 */
class HookTicketMintError extends Error {
  constructor(readonly cause: unknown) {
    super("failed to mint hook ticket");
    this.name = "HookTicketMintError";
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
  private _sharedStreamTask?: Promise<void>;
  private _sharedStreamAbort?: AbortController;
  private _refreshChain: Promise<void> = Promise.resolve();
  private _activeSignature = "";
  /** Retry attempt for the shared stream; reset once a stream proves healthy. */
  private _streamRetryAttempt = 0;
  /** Bumped whenever the session changes; scopes terminal failures. */
  private _sessionGeneration = 0;
  /** Set on sign-out; cleared when a new session arrives. */
  private _serviceStopped = false;
  /**
   * The last terminal failure, keyed by the subscription signature and
   * session generation it came from. While a signature is terminal for the
   * current generation, refreshes for it stop and every subscriber whose
   * requested set matches it is failed with this error. Cleared when the
   * subscriber set empties, on session change, and on sign-out — a fresh
   * subscription after any of those mints again.
   */
  private _terminalStreamError?: {
    signature: string;
    generation: number;
    error: unknown;
  };
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

    const normalized = subscriptions.map(normalizeSubscription);
    const subscriber: HookSubscriber = {
      requested: normalized,
      ttlSeconds: options.ttlSeconds,
      queue: new AsyncQueue<HookEvent>(),
    };

    this._subscribers.add(subscriber);
    const abortHandler = () => {
      this._subscribers.delete(subscriber);
      subscriber.queue.close();
      void this.scheduleSharedStreamRefresh();
    };

    if (options.signal) {
      if (options.signal.aborted) {
        abortHandler();
      } else {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    void this.scheduleSharedStreamRefresh();

    try {
      for await (const event of subscriber.queue) {
        yield event;
      }
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      abortHandler();
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

  private async scheduleSharedStreamRefresh(): Promise<void> {
    this._refreshChain = this._refreshChain
      .then(() => this.refreshSharedStream())
      .catch(() => undefined);
    await this._refreshChain;
  }

  private async refreshSharedStream(): Promise<void> {
    if (
      !this.requireAuth() ||
      this.lifecycleAborted ||
      this._subscribers.size === 0
    ) {
      this.abortSharedStream();
      this._activeSignature = "";
      if (this._subscribers.size === 0) {
        // Once every subscriber that saw the terminal failure is gone, the
        // next subscription mints fresh.
        this._terminalStreamError = undefined;
      }
      return;
    }

    const state = this.collectSharedStreamState();
    if (state.signature !== this._activeSignature) {
      this._activeSignature = state.signature;
      this.abortSharedStream();
    }

    const terminal = this._terminalStreamError;
    if (
      terminal &&
      terminal.signature === state.signature &&
      terminal.generation === this._sessionGeneration
    ) {
      // Retrying this exact subscription set already failed in a way
      // retrying cannot fix (the node refused the ticket mint). Surface the
      // failure to subscribers instead of minting again.
      this.failSubscribers(terminal.error);
      return;
    }

    if (!this._sharedStreamTask) {
      const abortController = new AbortController();
      this._sharedStreamAbort = abortController;
      // The request signal lives for the whole task — including the backoff
      // wait — so sign-out and context aborts cancel the backoff too.
      const request = this.createRequestSignal(abortController.signal, 0);
      this._sharedStreamTask = this.runSharedStream(state, request.signal)
        .then(
          () => this.settleSharedStreamRun(state.signature, request.signal),
          (error: unknown) =>
            this.settleSharedStreamRun(
              state.signature,
              request.signal,
              error,
            ),
        )
        .finally(() => {
          request.dispose();
          this._sharedStreamTask = undefined;
          this._sharedStreamAbort = undefined;
          if (this._subscribers.size > 0 && !this.lifecycleAborted) {
            void this.scheduleSharedStreamRefresh();
          }
        })
        // Terminal rejection boundary: nothing awaits this task, so every
        // stray throw — in settlement, cleanup, or a reschedule — dies here
        // instead of becoming an unhandled rejection that kills the
        // consumer's process.
        .then(undefined, () => undefined);
    }
  }

  /**
   * Settle one shared-stream run without ever rejecting: nothing awaits the
   * detached task, so a rethrow would surface as an unhandled rejection and,
   * under Node's default --unhandled-rejections=throw, kill the process.
   *
   * Three outcomes:
   * - aborted or superseded → discard the result; the .finally reschedule
   *   acts on the newer signature (or stays quiet with no subscribers).
   * - terminal mint refusal → record it and fail subscribers with the
   *   mint's ServiceError.
   * - recoverable — an error, or a stream that simply ended — → back off,
   *   then let the .finally reschedule re-mint and reopen.
   */
  private async settleSharedStreamRun(
    signature: string,
    signal: AbortSignal,
    error?: unknown,
  ): Promise<void> {
    const mintError =
      error instanceof HookTicketMintError ? error.cause : undefined;
    if (signal.aborted || isAbortError(mintError ?? error)) {
      return;
    }

    if (mintError !== undefined) {
      const status = readErrorStatus(mintError);
      const refused =
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429;
      // Only a refusal from the run that is still the active subscription
      // set is terminal. A stale or cancelled mint — the signature changed,
      // or the abort raced the refusal — is discarded, never broadcast.
      if (refused && signature === this._activeSignature) {
        // The mint was refused rather than lost: 401/403 means the session
        // lacks hooks authority, and any other 4xx means the node rejected
        // the request itself — none heal by retrying (408/429 and 5xx stay
        // recoverable).
        this._terminalStreamError = {
          signature,
          generation: this._sessionGeneration,
          error: mintError,
        };
        this.emitStreamError(mintError);
        this.failSubscribers(mintError);
        return;
      }
    }

    // Recoverable: a network error, a 5xx, a 401/403 stream-open refusal
    // (expired or rotated ticket — the next attempt re-mints), or a stream
    // that ended on its own (a server-side EOF is worth retrying, not
    // hot-looping). Back off before resolving so the .finally reschedule
    // paces the reopen through the existing refresh chain.
    if (error !== undefined) {
      this.emitStreamError(mintError ?? error);
    }
    this._streamRetryAttempt += 1;
    try {
      await this.waitForHookStreamRetry(this._streamRetryAttempt, signal);
    } catch {
      // A custom `streamRetry.wait` may reject on abort; treat that
      // like a completed wait so the task still resolves cleanly.
    }
  }

  private collectSharedStreamState(): {
    subscriptions: HookSubscription[];
    ttlSeconds?: number;
    signature: string;
  } {
    const merged = new Map<string, HookSubscription>();
    const ttlCandidates: number[] = [];

    for (const subscriber of this._subscribers) {
      if (typeof subscriber.ttlSeconds === "number") {
        ttlCandidates.push(subscriber.ttlSeconds);
      }
      for (const subscription of subscriber.requested) {
        merged.set(subscriptionSignature(subscription), subscription);
      }
    }

    const subscriptions = [...merged.values()].sort((left, right) =>
      subscriptionSignature(left).localeCompare(subscriptionSignature(right)),
    );
    const ttlSeconds =
      ttlCandidates.length > 0 ? Math.min(...ttlCandidates) : undefined;
    const signature = JSON.stringify({
      subscriptions: subscriptions.map(subscriptionSignature),
      ttlSeconds,
    });

    return {
      subscriptions,
      ttlSeconds,
      signature,
    };
  }

  private async runSharedStream(
    state: {
      subscriptions: HookSubscription[];
      ttlSeconds?: number;
    },
    signal: AbortSignal,
  ): Promise<void> {
    let openedAt: number | undefined;
    let delivered = false;
    const noteHealth = (): void => {
      // A stream that delivered an event, or survived past the healthy
      // window, proved the current setup works: the next failure retries
      // from the base delay. An empty or instantly-dropped stream earns
      // nothing and keeps backing off.
      if (
        delivered ||
        (openedAt !== undefined &&
          Date.now() - openedAt >= HOOK_STREAM_HEALTHY_MS)
      ) {
        this._streamRetryAttempt = 0;
      }
    };

    try {
      const host = this._config.host ?? this.context.hosts[0];
      let ticketResponse: HookTicketResponse;
      try {
        ticketResponse = await this.mintHookTicket(
          state.subscriptions,
          state.ttlSeconds,
          signal,
        );
      } catch (error) {
        throw new HookTicketMintError(error);
      }
      try {
        const streamResponse = await this.openHookStream(
          host,
          ticketResponse.ticket,
          signal,
        );
        openedAt = Date.now();

        for await (const message of parseSseStream(
          streamResponse.body,
          signal,
        )) {
          if (!message.data) {
            continue;
          }
          const event = parseHookEvent(message);
          delivered = true;
          for (const subscriber of this._subscribers) {
            if (matchesAnySubscription(event, subscriber.requested)) {
              subscriber.queue.push(event);
            }
          }
        }

        noteHealth();
      } catch (error) {
        // The ticket rides in the request URL, so a transport rejection or
        // a mid-stream read error can carry it. Everything that leaves the
        // run past the mint is sanitized — raw, percent-encoded and
        // form-encoded forms, in message, cause and stack.
        throw sanitizeStreamError(error, ticketResponse.ticket);
      }
    } finally {
      // Health applies whether the stream ended cleanly or errored while
      // open; a failure before the open leaves the backoff streak intact.
      noteHealth();
    }
  }

  /**
   * Wait out the backoff before the shared stream's next attempt.
   * `config.streamRetry.wait` overrides the sleep (the injected clock in
   * tests); the default is an abortable, unref'd `setTimeout` — the backoff
   * never keeps a process alive. Either way, resolving or aborting just
   * lets the task end so the refresh chain reschedules — there is no
   * second scheduler.
   */
  private async waitForHookStreamRetry(
    attempt: number,
    signal: AbortSignal,
  ): Promise<void> {
    const retry = this._config.streamRetry;
    const delayMs = retry?.delay?.(attempt) ?? hookStreamRetryDelay(attempt);
    if (retry?.wait) {
      const wait = retry.wait;
      try {
        // Promise.resolve().then(...) so a synchronous throw in a custom
        // wait still lands here as a rejection rather than skipping the
        // yield below.
        await Promise.resolve().then(() => wait(delayMs, attempt, signal));
      } finally {
        // Whether the custom wait fulfilled, rejected or threw, it may have
        // returned instantly (an injected clock), so yield one real
        // event-loop turn — otherwise a persistently failing stream
        // hot-loops on microtasks and starves every timer in the process.
        // setImmediate shares the check phase with other pending work, so
        // it yields fairly; fall back to a 0ms timer where it is absent.
        const queueTurn = globalThis.setImmediate as
          | ((callback: () => void) => unknown)
          | undefined;
        await new Promise<void>((resolve) => {
          if (queueTurn) {
            queueTurn(resolve);
          } else {
            setTimeout(resolve, 0);
          }
        });
      }
      return;
    }
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      // A parked backoff must never keep the consumer's process alive.
      timer.unref?.();
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Emit a stream failure as telemetry so repeated retries are visible
   * without logging ticket material. A non-ServiceError failure is wrapped
   * first; emitter failures can never break the retry path.
   */
  private emitStreamError(error: unknown): void {
    try {
      this.emitError(
        isServiceError(error) ? error : wrapError("hooks", error),
        "stream",
      );
    } catch {
      // Telemetry must never take down the stream.
    }
  }

  /**
   * True when the service lifecycle ended: the context aborted, or the SDK
   * signed out and no new session has arrived. Lifecycle aborts stop the
   * stream entirely; they are not retried.
   */
  private get lifecycleAborted(): boolean {
    return (
      this._serviceStopped || (this.context?.abortSignal?.aborted ?? false)
    );
  }

  override onSessionChange(session: ServiceSession | null): void {
    super.onSessionChange(session);
    // New credentials: a new mint can succeed where the last refused, and
    // the stream must reopen under the new session anyway.
    this._sessionGeneration += 1;
    this._serviceStopped = false;
    this._terminalStreamError = undefined;
    this.abortSharedStream();
    void this.scheduleSharedStreamRefresh();
  }

  override onSignOut(): void {
    super.onSignOut();
    this._serviceStopped = true;
    this._terminalStreamError = undefined;
    this.abortSharedStream();
  }

  /**
   * Fail every subscriber's queue with `error`. `for await` consumers then
   * see `subscribe()`'s iterator throw; their `finally` unsubscribes, which
   * stops the retry chain once no subscribers remain.
   */
  private failSubscribers(error: unknown): void {
    for (const subscriber of this._subscribers) {
      subscriber.queue.fail(error);
    }
  }

  private abortSharedStream(): void {
    this._sharedStreamAbort?.abort();
  }

  private createHookHeaders(action: string, path: string): ServiceHeaders {
    return this.context.invoke(this.session, "hooks", path, action);
  }

  private async mintHookTicket(
    subscriptions: HookSubscription[],
    ttlSeconds: number | undefined,
    signal?: AbortSignal,
  ): Promise<HookTicketResponse> {
    const host = this._config.host ?? this.context.hosts[0];
    const headers = this.createInvokeHeaders(subscriptions);
    const ticketResponse = await this.context.fetch(`${host}/hooks/tickets`, {
      method: "POST",
      headers: {
        ...serviceHeadersToRecord(headers),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subscriptions,
        ttlSeconds,
      }),
      signal,
    });

    if (!ticketResponse.ok) {
      throw await responseError(
        "hooks",
        "failed to mint hook ticket",
        ticketResponse,
      );
    }

    const ticketJson = (await ticketResponse.json()) as HookTicketResponse;
    if (!ticketJson?.ticket) {
      throw new Error("Hook ticket response did not include a ticket");
    }

    return ticketJson;
  }

  private async openHookStream(
    host: string,
    ticket: string,
    signal?: AbortSignal,
  ): Promise<FetchResponse> {
    const streamResponse = await this.context.fetch(
      `${host}/hooks/events?ticket=${encodeURIComponent(ticket)}`,
      {
        method: "GET",
        headers: { accept: "text/event-stream" },
        signal,
      },
    );

    if (!streamResponse.ok) {
      throw redactTicketFromStreamError(
        await responseError(
          "hooks",
          "failed to open hook stream",
          streamResponse,
        ),
        ticket,
      );
    }

    return streamResponse;
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
 * Read a property off a possibly-hostile error object; a throwing accessor
 * must never take the settlement path down with it.
 */
function readErrorProp(value: unknown, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Best-effort HTTP status extraction for mint-refusal classification. A
 * throwing `meta`/`status` getter simply makes the error non-terminal —
 * recoverable is always the safer classification than a throw inside
 * settlement.
 */
function readErrorStatus(error: unknown): number | undefined {
  try {
    const meta = isServiceError(error) ? error.meta : undefined;
    const status = meta?.status;
    return typeof status === "number" ? status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every textual form the ticket can appear in when it leaks through a
 * request URL: raw, percent-encoded, and `URLSearchParams` form encoding
 * (`+` for spaces).
 */
function ticketForms(ticket: string): string[] {
  return [
    ticket,
    encodeURIComponent(ticket),
    new URLSearchParams({ ticket }).toString().slice("ticket=".length),
  ];
}

function redactTicketForms(text: string, ticket: string): string {
  let out = text;
  for (const form of ticketForms(ticket)) {
    if (form) {
      out = out.split(form).join("[redacted]");
    }
  }
  return out;
}

/**
 * Copy a cause chain, sanitizing ticket material at every level without
 * mutating the (possibly third-party) originals. Depth-bounded so a cyclic
 * or pathological cause graph cannot recurse forever.
 */
function sanitizeErrorCause(
  cause: unknown,
  ticket: string,
  depth = 0,
): unknown {
  if (!ticket || depth > 4) {
    return cause;
  }
  if (typeof cause === "string") {
    return redactTicketForms(cause, ticket);
  }
  if (cause === null || typeof cause !== "object") {
    return cause;
  }
  if (isServiceError(cause)) {
    return redactTicketFromStreamError(cause, ticket);
  }
  if (cause instanceof Error) {
    const message = readErrorProp(cause, "message");
    const cloned = new Error(
      typeof message === "string" ? redactTicketForms(message, ticket) : "",
    );
    const name = readErrorProp(cause, "name");
    if (typeof name === "string") {
      cloned.name = name;
    }
    const stack = readErrorProp(cause, "stack");
    if (typeof stack === "string") {
      cloned.stack = redactTicketForms(stack, ticket);
    }
    const inner = readErrorProp(cause, "cause");
    if (inner !== undefined) {
      cloned.cause = sanitizeErrorCause(inner, ticket, depth + 1);
    }
    return cloned;
  }
  // Any other object: shallow copy and sanitize the textual fields that can
  // carry a URL.
  const copy: Record<string, unknown> = { ...cause };
  for (const key of ["message", "stack", "url", "href"]) {
    if (typeof copy[key] === "string") {
      copy[key] = redactTicketForms(copy[key] as string, ticket);
    }
  }
  const inner = readErrorProp(cause, "cause");
  if (inner !== undefined) {
    copy.cause = sanitizeErrorCause(inner, ticket, depth + 1);
  }
  return copy;
}

function sanitizeMetaValues(
  meta: Record<string, unknown>,
  ticket: string,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === "string") {
      clean[key] = redactTicketForms(value, ticket);
      continue;
    }
    try {
      const serialized = JSON.stringify(value);
      clean[key] =
        serialized !== undefined &&
        redactTicketForms(serialized, ticket) !== serialized
          ? "[redacted]"
          : value;
    } catch {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * A refused `/hooks/events` response body may echo the request — including
 * the ticket query parameter — and so can a transport rejection
 * (`request to <URL>?ticket=… failed`). Ticket material is a bearer
 * credential, so every form it can appear in — raw, percent-encoded, or
 * form-encoded — is redacted from the message, the whole cause chain, the
 * stack, and meta. Returns a fresh ServiceError; the input is never
 * mutated.
 */
function redactTicketFromStreamError(
  error: ServiceError,
  ticket: string,
): ServiceError {
  if (!ticket) {
    return error;
  }
  const redacted: ServiceError = {
    ...error,
    message: redactTicketForms(error.message, ticket),
  };
  const cause = readErrorProp(error, "cause");
  if (cause !== undefined) {
    Object.assign(redacted, {
      cause: sanitizeErrorCause(cause, ticket),
    });
  }
  if (error.meta) {
    redacted.meta = sanitizeMetaValues(error.meta, ticket);
  }
  const stack = readErrorProp(error, "stack");
  if (typeof stack === "string") {
    Object.assign(redacted, { stack: redactTicketForms(stack, ticket) });
  }
  return redacted;
}

/**
 * Wrap whatever left the stream run — a transport rejection, an SSE read
 * failure, an arbitrary throw — as a ServiceError with the ticket scrubbed
 * from every reachable string. A hostile input that defeats even wrapError
 * degrades to a bare service error rather than leaking.
 */
function sanitizeStreamError(error: unknown, ticket: string): ServiceError {
  let base: ServiceError;
  try {
    base = isServiceError(error) ? error : wrapError("hooks", error);
  } catch {
    base = serviceError(
      ErrorCodes.NETWORK_ERROR,
      "hook stream failed",
      "hooks",
    );
  }
  return redactTicketFromStreamError(base, ticket);
}

/** Shape check for the errors services produce (typed `meta` accessible). */
function isServiceError(error: unknown): error is ServiceError {
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      "message" in error &&
      typeof error.message === "string" &&
      "service" in error &&
      typeof error.service === "string"
    );
  } catch {
    return false;
  }
}

function normalizeSubscription(
  subscription: HookSubscription,
): HookSubscription {
  return {
    ...subscription,
    pathPrefix: normalizePathPrefix(subscription.pathPrefix),
    abilities: subscription.abilities ?? [],
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

function isAbortError(error: unknown): boolean {
  try {
    return (
      (error instanceof DOMException || error instanceof Error) &&
      error.name === "AbortError"
    );
  } catch {
    // A hostile error object whose `name` accessor throws is not an abort.
    return false;
  }
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
