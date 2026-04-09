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
