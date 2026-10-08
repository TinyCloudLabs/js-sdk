export type HookServiceName = "kv" | "sql" | "duckdb";

export interface HookSubscription {
  space: string;
  service: HookServiceName;
  pathPrefix?: string;
  abilities?: string[];
}

export interface HookWebhookScope {
  space: string;
  service: HookServiceName;
  pathPrefix?: string;
  abilities?: string[];
}

export interface HookWebhookRegistration extends HookWebhookScope {
  callbackUrl: string;
  secret: string;
}

export interface HookWebhookRecord extends HookWebhookScope {
  id: string;
  subscriberDid?: string;
  callbackUrl: string;
  active: boolean;
  createdAt: string;
}

export interface HookWebhookListOptions {
  space?: string;
  service?: HookServiceName;
  pathPrefix?: string;
}

export interface HookWebhookUnregisterOptions {
  target?: HookWebhookScope;
}

export interface HookEvent {
  type: "write";
  id: string;
  space: string;
  service: string;
  ability: string;
  path?: string;
  actor: string;
  epoch: string;
  eventIndex: number;
  timestamp: string;
}

export interface HookStreamEvent {
  event: string;
  data: string;
  id?: string;
}

export interface SubscribeOptions {
  ttlSeconds?: number;
  signal?: AbortSignal;
}

export interface HooksServiceConfig extends Record<string, unknown> {
  host?: string;
  /** Shared-stream retry tuning; see {@link HookStreamRetryConfig}. */
  streamRetry?: HookStreamRetryConfig;
}

/**
 * Retry policy for the shared `/hooks/events` stream. When the stream fails
 * (network error, 5xx, or an expired/rotated ticket rejected with 401/403)
 * it is re-opened with exponential backoff: `HOOK_STREAM_RETRY_BASE_DELAY_MS`
 * (~250 ms) doubling to `HOOK_STREAM_RETRY_MAX_DELAY_MS` (~30 s) with jitter,
 * reset once a stream opens. Retries stop when no subscribers remain, when
 * the service is aborted, or when minting the hook ticket is refused
 * (the iterator throws that error instead).
 */
export interface HookStreamRetryConfig {
  /**
   * Delay before retry attempt `attempt` (1-based). Defaults to the jittered
   * exponential backoff described above. Must return milliseconds.
   */
  delay?: (attempt: number) => number;
  /**
   * How a retry delay is awaited — the injectable clock. `delayMs` is the
   * resolved delay for `attempt`; `signal` aborts the wait early when the
   * subscription set changes or the service stops. Rejecting or throwing is
   * treated like a completed wait. After a custom wait returns — whether it
   * fulfilled, rejected or threw — the service still yields one event-loop
   * turn so a persistently failing stream can never starve the process.
   * Defaults to an abortable, unref'd `setTimeout`.
   */
  wait?: (delayMs: number, attempt: number, signal: AbortSignal) => Promise<void>;
}

