import { BaseService } from "../base/BaseService";
import type {
  FetchResponse,
  InvokeAnyEntry,
  ServiceHeaders,
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
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  push(value: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
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
      waiter?.({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      const value = this.values.shift()!;
      return Promise.resolve({ value, done: false });
    }

    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }

    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export class HooksService extends BaseService implements IHooksService {
  static readonly serviceName = "hooks";

  declare protected _config: HooksServiceConfig;
  private readonly _subscribers: Set<HookSubscriber> = new Set();
  private _sharedStreamTask?: Promise<void>;
  private _sharedStreamAbort?: AbortController;
  private _refreshChain: Promise<void> = Promise.resolve();
  private _activeSignature = "";

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
    if (!this.requireAuth() || this._subscribers.size === 0) {
      this.abortSharedStream();
      this._activeSignature = "";
      return;
    }

    const state = this.collectSharedStreamState();
    if (state.signature !== this._activeSignature) {
      this._activeSignature = state.signature;
      this.abortSharedStream();
    }

    if (!this._sharedStreamTask) {
      this._sharedStreamTask = this.runSharedStream(state)
        .catch((error: unknown) => {
          if (!isAbortError(error)) {
            throw error;
          }
        })
        .finally(() => {
          this._sharedStreamTask = undefined;
          this._sharedStreamAbort = undefined;
          if (this._subscribers.size > 0) {
            void this.scheduleSharedStreamRefresh();
          }
        });
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

  private async runSharedStream(state: {
    subscriptions: HookSubscription[];
    ttlSeconds?: number;
  }): Promise<void> {
    const abortController = new AbortController();
    this._sharedStreamAbort = abortController;

    try {
      const host = this._config.host ?? this.context.hosts[0];
      const ticketResponse = await this.mintHookTicket(
        state.subscriptions,
        state.ttlSeconds,
        abortController.signal,
      );
      const streamResponse = await this.openHookStream(
        host,
        ticketResponse.ticket,
        abortController.signal,
      );

      for await (const message of parseSseStream(
        streamResponse.body,
        abortController.signal,
      )) {
        if (!message.data) {
          continue;
        }
        const event = parseHookEvent(message);
        for (const subscriber of this._subscribers) {
          if (matchesAnySubscription(event, subscriber.requested)) {
            subscriber.queue.push(event);
          }
        }
      }
    } finally {
      if (this._sharedStreamAbort === abortController) {
        this._sharedStreamAbort = undefined;
      }
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
      throw await responseError(
        "hooks",
        "failed to open hook stream",
        streamResponse,
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
  return wrapError(
    service,
    new Error(`${message}: ${response.status} ${detail}`),
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
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
