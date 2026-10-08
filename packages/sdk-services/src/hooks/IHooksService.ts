import type {
  HookEvent,
  HookSubscription,
  SubscribeOptions,
  HookWebhookListOptions,
  HookWebhookRecord,
  HookWebhookRegistration,
  HookWebhookUnregisterOptions,
} from "./types";
import type { Result } from "../types";

export interface IHooksService {
  /**
   * Stream hook events until `options.signal` aborts, the SDK signs out or
   * the session ends, or the consumer stops iterating. Transient stream
   * failures — network errors, 5xx, and an expired or rotated ticket rejected
   * by `/hooks/events` (401/403) — are retried internally with backoff and
   * never reach the iterator.
   *
   * The iterator throws when minting the hook ticket is refused. The thrown
   * plain `ServiceError` carries `meta.status` with the refusing HTTP status,
   * so `for await` consumers can branch on it. Stream diagnostics contain only
   * SDK allow-listed identifiers; foreign error messages and causes are not
   * copied.
   */
  subscribe(
    subscriptions: HookSubscription[],
    options?: SubscribeOptions,
  ): AsyncIterable<HookEvent>;
  register(
    webhook: HookWebhookRegistration,
  ): Promise<Result<HookWebhookRecord>>;
  list(options?: HookWebhookListOptions): Promise<Result<HookWebhookRecord[]>>;
  unregister(
    id: string,
    options?: HookWebhookUnregisterOptions,
  ): Promise<Result<void>>;
}
