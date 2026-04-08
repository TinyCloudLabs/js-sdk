export interface HookSubscription {
  space: string;
  service: "kv" | "sql" | "duckdb";
  pathPrefix?: string;
  abilities?: string[];
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
