import { createHash } from "node:crypto";

import { decodeJwt } from "jose";

/** What OpenKey's RFC 7662 token introspection says about one access token. */
export type TokenStatus = "active" | "inactive" | "unknown";

export interface TokenStatusConfig {
  /** OpenKey's `introspection_endpoint` from its OAuth metadata. */
  readonly endpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** How the confidential client authenticates: `client_secret_basic` or `client_secret_post`. */
  readonly authMethod: "basic" | "post";
  readonly timeoutMs?: number;
  /** Test seams. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface TokenStatusChecker {
  /** Ask OpenKey whether `token` is still active. Never throws. */
  readonly tokenStatus: (token: string) => Promise<TokenStatus>;
  /**
   * Whether an `unknown` status may still be accepted for this token: only
   * while the time since OpenKey last answered is shorter than the token's own
   * lifetime (`exp - iat`, 300 s when the token does not carry both).
   */
  readonly toleratesUnknown: (token: string) => boolean;
}

const ACTIVE_CACHE_MS = 5_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 300;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_CACHED_TOKENS = 10_000;

export function createTokenStatusChecker(config: TokenStatusConfig): TokenStatusChecker {
  const doFetch = config.fetch ?? fetch;
  const clock = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /** token hash -> expiry (ms) of an inactive token; inactive is final. */
  const inactive = new Map<string, number>();
  /** token hash -> end (ms) of the short active window. */
  const active = new Map<string, number>();
  const inFlight = new Map<string, Promise<TokenStatus>>();
  let lastAnswerAt: number | undefined;

  async function introspect(token: string): Promise<TokenStatus> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    };
    const body = new URLSearchParams({ token, token_type_hint: "access_token" });
    if (config.authMethod === "basic") {
      const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
      const credentials = `${encode(config.clientId)}:${encode(config.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
    } else {
      body.set("client_id", config.clientId);
      body.set("client_secret", config.clientSecret);
    }
    try {
      const response = await doFetch(config.endpoint, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return "unknown";
      const result: unknown = await response.json();
      const flag = typeof result === "object" && result !== null && "active" in result
        ? result.active
        : undefined;
      if (flag === true) return "active";
      if (flag === false) return "inactive";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  async function query(key: string, token: string): Promise<TokenStatus> {
    const status = await introspect(token);
    if (status === "unknown") return status;
    const now = clock();
    lastAnswerAt = now;
    prune(now);
    if (status === "inactive") {
      inactive.set(key, tokenExpiryMs(token, now));
    } else {
      active.set(key, now + ACTIVE_CACHE_MS);
    }
    return status;
  }

  function prune(now: number): void {
    for (const [key, until] of active) if (until <= now) active.delete(key);
    for (const [key, until] of inactive) if (until <= now) inactive.delete(key);
    // An evicted entry only costs one more introspection for that token.
    for (const cache of [active, inactive]) {
      while (cache.size >= MAX_CACHED_TOKENS) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
  }

  return {
    async tokenStatus(token) {
      const key = createHash("sha256").update(token).digest("hex");
      const now = clock();
      const inactiveUntil = inactive.get(key);
      if (inactiveUntil !== undefined && inactiveUntil > now) return "inactive";
      const activeUntil = active.get(key);
      if (activeUntil !== undefined && activeUntil > now) return "active";
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      const asking = query(key, token).finally(() => inFlight.delete(key));
      inFlight.set(key, asking);
      return asking;
    },
    toleratesUnknown(token) {
      if (lastAnswerAt === undefined) return false;
      return clock() - lastAnswerAt < tokenLifetimeSeconds(token) * 1000;
    },
  };
}

function tokenExpiryMs(token: string, now: number): number {
  const exp = claims(token).exp;
  return typeof exp === "number" ? exp * 1000 : now + DEFAULT_TOKEN_LIFETIME_SECONDS * 1000;
}

function tokenLifetimeSeconds(token: string): number {
  const { exp, iat } = claims(token);
  return typeof exp === "number" && typeof iat === "number" && exp > iat
    ? exp - iat
    : DEFAULT_TOKEN_LIFETIME_SECONDS;
}

function claims(token: string): { exp?: unknown; iat?: unknown } {
  try {
    return decodeJwt(token);
  } catch {
    return {};
  }
}
