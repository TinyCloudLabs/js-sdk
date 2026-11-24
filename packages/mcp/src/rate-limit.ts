/**
 * Rate limiting for the hosted connector. Off unless `HostedMcpConfig.rateLimit` is set.
 *
 * State is one in-process token bucket per (bucket, key). The hosted connector is a single
 * instance with a local state volume, so a counter shared across instances is not needed
 * today; `RateLimiter` is the seam for one if the deploy ever runs more than one.
 */

export type RateLimitClass = "connect" | "read" | "write";

/** `perMinute` is the sustained rate; `burst` (default `perMinute`) is how many calls may arrive at once. */
export interface RateRule {
  readonly perMinute: number;
  readonly burst?: number;
}

export interface RateLimitConfig {
  /** Tool calls per OpenKey subject, by tool class. One person has one budget across every surface. */
  readonly tools: Readonly<Record<RateLimitClass, RateRule>>;
  /** All authenticated MCP requests per OpenKey subject: a flood ceiling above any tool class. */
  readonly subjectRequests: RateRule;
  /**
   * All authenticated MCP requests per OAuth client id. ChatGPT registers one client that every ChatGPT
   * user shares, so this is an aggregate cap for that client, not a fairness limit between its users.
   */
  readonly client: RateRule;
  /** Per client address: the `/connect` approval route, and bearer tokens the server has to reject. */
  readonly ip: RateRule;
  /**
   * Trusted reverse proxies in front of the server: set it to their exact count. The client address is the Nth
   * entry from the right of `X-Forwarded-For`. 0 (the default) turns address limits off entirely, with no
   * per-address or shared bucket: without a trusted proxy the header is client-controlled, and behind a TLS
   * pass-through ingress the server sees no client address at all.
   */
  readonly trustedProxyHops: number;
  /** Cap on tracked keys; the oldest key is dropped first. */
  readonly maxKeys?: number;
  /** Clock in ms; tests inject one. */
  readonly now?: () => number;
}

export type RateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  /** Spend one call from the bucket, or say how long until one is free. */
  take(bucket: string, key: string, rule: RateRule): RateDecision;
  /** Give back one call a caller spent with `take`, never past the bucket's capacity. */
  refund(bucket: string, key: string, rule: RateRule): void;
}

export const DEFAULT_RATE_LIMITS: Omit<RateLimitConfig, "now"> = {
  tools: {
    connect: { perMinute: 6, burst: 3 },
    read: { perMinute: 60, burst: 20 },
    write: { perMinute: 30, burst: 10 },
  },
  subjectRequests: { perMinute: 240, burst: 60 },
  client: { perMinute: 6000, burst: 600 },
  ip: { perMinute: 60, burst: 20 },
  trustedProxyHops: 0,
  maxKeys: 10_000,
};

interface Bucket {
  tokens: number;
  at: number;
}

export function createRateLimiter(config: Pick<RateLimitConfig, "maxKeys" | "now">): RateLimiter {
  const now = config.now ?? Date.now;
  const maxKeys = config.maxKeys ?? DEFAULT_RATE_LIMITS.maxKeys!;
  const buckets = new Map<string, Bucket>();

  const refilled = (id: string, rule: RateRule): Bucket => {
    const capacity = rule.burst ?? rule.perMinute;
    const at = now();
    const held = buckets.get(id);
    if (held === undefined) return { tokens: capacity, at };
    return { tokens: Math.min(capacity, held.tokens + ((at - held.at) * rule.perMinute) / 60_000), at };
  };
  const decide = (bucket: Bucket, rule: RateRule): RateDecision =>
    bucket.tokens >= 1
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((1 - bucket.tokens) * 60) / rule.perMinute)) };

  return {
    refund(bucket, key, rule) {
      const id = `${bucket}\0${key}`;
      if (!buckets.has(id)) return;
      const state = refilled(id, rule);
      state.tokens = Math.min(rule.burst ?? rule.perMinute, state.tokens + 1);
      buckets.set(id, state);
    },
    take(bucket, key, rule) {
      const id = `${bucket}\0${key}`;
      const state = refilled(id, rule);
      const decision = decide(state, rule);
      if (decision.allowed) state.tokens -= 1;
      // Re-insert so Map order is least recently used first.
      buckets.delete(id);
      if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value!);
      buckets.set(id, state);
      return decision;
    },
  };
}

/**
 * The client address: the Nth entry from the right of `X-Forwarded-For`, N being the trusted proxy count.
 * `undefined` when address limits are off; "unknown" when the header is missing or too short, so such
 * requests share one bucket instead of escaping the limit.
 */
export function clientAddress(request: Request, trustedProxyHops: number): string | undefined {
  if (trustedProxyHops <= 0) return undefined;
  const hops = (request.headers.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops[hops.length - trustedProxyHops] ?? "unknown";
}

/** A refused HTTP request. Not a tool call, so a client sees a plain 429 with the standard header. */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "rate_limited", retryAfterSeconds }), {
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(retryAfterSeconds),
      "cache-control": "no-store",
    },
  });
}

export interface RateRefusal {
  readonly limitClass: RateLimitClass;
  readonly retryAfterSeconds: number;
}

/**
 * A refused tool call. `isError` is the MCP signal a model sees as a failed tool call, and it exempts the
 * result from the tool's output schema, so no tool schema or operation error code changes.
 */
export function rateLimitedToolResult(refusal: RateRefusal, operation: Record<string, unknown> = {}) {
  const message = `TinyCloud is limiting how fast this connection can make requests. Wait ${refusal.retryAfterSeconds} seconds, then try again.`;
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }] as [{ type: "text"; text: string }],
    structuredContent: {
      status: "error" as const,
      operation,
      context: {},
      error: {
        code: "RATE_LIMITED",
        message,
        retryable: true,
        details: { reason: "rate_limited", limitClass: refusal.limitClass, retryAfterSeconds: refusal.retryAfterSeconds },
      },
    },
  };
}

/** The tool class a call is charged to: the connect tool, a record or storage change, or anything else. */
export function toolClass(name: string, destructive: boolean): RateLimitClass {
  if (name === "tinycloud_connect") return "connect";
  return destructive ? "write" : "read";
}

export interface RateLimits {
  readonly config: RateLimitConfig;
  readonly limiter: RateLimiter;
}

export function createRateLimits(config: RateLimitConfig): RateLimits {
  return { config, limiter: createRateLimiter(config) };
}

/** Charge one tool call to its subject's class bucket. */
export function refuseTool(limits: RateLimits, subject: string, name: string, destructive: boolean): RateRefusal | undefined {
  const limitClass = toolClass(name, destructive);
  const decision = limits.limiter.take(`tool:${limitClass}`, subject, limits.config.tools[limitClass]);
  return decision.allowed ? undefined : { limitClass, retryAfterSeconds: decision.retryAfterSeconds };
}

/** 429 when the request's address is over `bucket`'s limit; otherwise spends one call. No-op when address limits are off. */
export function refuseAddress(limits: RateLimits, request: Request, bucket: string): Response | undefined {
  const address = clientAddress(request, limits.config.trustedProxyHops);
  if (address === undefined) return undefined;
  const decision = limits.limiter.take(bucket, address, limits.config.ip);
  return decision.allowed ? undefined : rateLimitedResponse(decision.retryAfterSeconds);
}

/** Give back a call `refuseAddress` spent, once the request turns out not to deserve the charge. */
export function refundAddress(limits: RateLimits, request: Request, bucket: string): void {
  const address = clientAddress(request, limits.config.trustedProxyHops);
  if (address !== undefined) limits.limiter.refund(bucket, address, limits.config.ip);
}

/**
 * 429 when an authenticated request is over its OAuth client's or its subject's request ceiling. A request its
 * subject refuses gives its client charge back, so one subject's flood does not spend the client's shared cap.
 */
export function refuseAuthenticated(limits: RateLimits, clientId: string, subject: unknown): Response | undefined {
  const byClient = limits.limiter.take("client", clientId, limits.config.client);
  if (!byClient.allowed) return rateLimitedResponse(byClient.retryAfterSeconds);
  if (typeof subject !== "string" || subject.length === 0) return undefined;
  const bySubject = limits.limiter.take("subject", subject, limits.config.subjectRequests);
  if (bySubject.allowed) return undefined;
  limits.limiter.refund("client", clientId, limits.config.client);
  return rateLimitedResponse(bySubject.retryAfterSeconds);
}

const ON_VALUES = ["1", "true", "on", "yes"];
const OFF_VALUES = ["", "0", "false", "off", "no"];

/**
 * The burst never exceeds the rate. Otherwise the default burst holds, except for the address limit
 * (`raisesBurst`): a rate above the default raises its burst in proportion, because the address burst is
 * also how many presented-token requests one shared egress address may have in flight at once.
 */
function limitFromEnv(value: string | undefined, name: string, fallback: RateRule, raisesBurst = false): RateRule {
  if (value === undefined || value.trim() === "") return fallback;
  const perMinute = Number(value);
  if (!Number.isInteger(perMinute) || perMinute <= 0) throw new Error(`${name} must be a positive integer.`);
  const burst = fallback.burst ?? fallback.perMinute;
  if (raisesBurst && perMinute > fallback.perMinute) {
    return { perMinute, burst: Math.floor((perMinute * burst) / fallback.perMinute) };
  }
  return { perMinute, burst: Math.min(perMinute, burst) };
}

/**
 * Rate limits from the environment. Off unless `TC_MCP_RATE_LIMIT` is 1/true/on/yes; when on, the defaults apply
 * except where a `TC_MCP_RATE_LIMIT_<NAME>_PER_MINUTE` (CONNECT, READ, WRITE, SUBJECT, CLIENT, IP) or
 * `TC_MCP_TRUSTED_PROXY_HOPS` overrides one. Address limits stay off unless `TC_MCP_TRUSTED_PROXY_HOPS` is at least 1.
 */
export function rateLimitFromEnv(env: Readonly<Record<string, string | undefined>>): RateLimitConfig | undefined {
  const flag = (env.TC_MCP_RATE_LIMIT ?? "").trim().toLowerCase();
  if (OFF_VALUES.includes(flag)) return undefined;
  if (!ON_VALUES.includes(flag)) throw new Error("TC_MCP_RATE_LIMIT must be on or off.");
  const defaults = DEFAULT_RATE_LIMITS;
  const hopsText = env.TC_MCP_TRUSTED_PROXY_HOPS;
  const hops = hopsText === undefined || hopsText.trim() === "" ? defaults.trustedProxyHops : Number(hopsText);
  if (!Number.isInteger(hops) || hops < 0) throw new Error("TC_MCP_TRUSTED_PROXY_HOPS must be a non-negative integer.");
  const rule = (name: string, fallback: RateRule, raisesBurst = false) => limitFromEnv(env[`TC_MCP_RATE_LIMIT_${name}_PER_MINUTE`], `TC_MCP_RATE_LIMIT_${name}_PER_MINUTE`, fallback, raisesBurst);
  return {
    tools: {
      connect: rule("CONNECT", defaults.tools.connect),
      read: rule("READ", defaults.tools.read),
      write: rule("WRITE", defaults.tools.write),
    },
    subjectRequests: rule("SUBJECT", defaults.subjectRequests),
    client: rule("CLIENT", defaults.client),
    ip: rule("IP", defaults.ip, true),
    trustedProxyHops: hops,
    ...(defaults.maxKeys === undefined ? {} : { maxKeys: defaults.maxKeys }),
  };
}
