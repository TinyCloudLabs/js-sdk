import type { HookEvent, HookSubscription, SubscribeOptions } from "./types";

export interface IHooksService {
  subscribe(
    subscriptions: HookSubscription[],
    options?: SubscribeOptions
  ): AsyncIterable<HookEvent>;
}
