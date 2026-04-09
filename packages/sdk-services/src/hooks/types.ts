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
  secret?: string;
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
}
