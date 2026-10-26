import { createHash } from "node:crypto";

import { decodeJwt } from "jose";

/** What OpenKey's RFC 7662 token introspection says about one access token. */
export type TokenStatus = "active" | "inactive" | "unknown";

export interface TokenStatusConfig {
  /** OpenKey's resource-server introspection endpoint (`TC_MCP_INTROSPECTION_URL`). */
  readonly endpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** How the confidential client authenticates: `client_secret_basic` or `client_secret_post`. */
  readonly authMethod: "basic" | "post";
  readonly timeoutMs?: number;
  /** Test seams. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface TokenStatusChecker {
  /** Ask OpenKey whether `token` is still active. Never throws. */
  readonly tokenStatus: (token: string) => Promise<TokenStatus>;
  /**
   * Whether an `unknown` status may still be accepted for this token: only
   * while the time since OpenKey last answered is shorter than the token's own
   * lifetime (`exp - iat`, 300 s when the token does not carry both), and
   * never while OpenKey is refusing the client credentials.
   */
  readonly toleratesUnknown: (token: string) => boolean;
}

/** What one introspection call concluded; `credentials` and `mismatch` are not answers about the token. */
type Outcome = TokenStatus | "credentials" | "mismatch";

const ACTIVE_CACHE_MS = 30_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 300;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_CACHED_TOKENS = 10_000;

export function createTokenStatusChecker(config: TokenStatusConfig): TokenStatusChecker {
  const doFetch = config.fetch ?? fetch;
  const clock = config.now ?? Date.now;
  const log = config.log ?? ((message: string) => void process.stderr.write(`[tinycloud-mcp-http] ${message}\n`));
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /** token hash -> expiry (ms) of an inactive token; inactive is final. */
  const inactive = new Map<string, number>();
  /** token hash -> end (ms) of the active window. */
  const active = new Map<string, number>();
  const inFlight = new Map<string, Promise<TokenStatus>>();
  let lastAnswerAt: number | undefined;
  /** Set while OpenKey refuses the client credentials; cleared by the next answer about a token. */
  let credentialsRefused = false;

  async function introspect(token: string): Promise<Outcome> {
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
      if (response.status === 401) return "credentials";
      if (response.status !== 200) return "unknown";
      const result: unknown = await response.json();
      if (typeof result !== "object" || result === null || !("active" in result)) return "unknown";
      if (result.active === false) return "inactive";
      if (result.active !== true) return "unknown";
      return answerMatchesToken(Object.fromEntries(Object.entries(result)), token) ? "active" : "mismatch";
    } catch {
      return "unknown";
    }
  }

  async function query(key: string, token: string): Promise<TokenStatus> {
    const outcome = await introspect(token);
    if (outcome === "credentials") {
      if (!credentialsRefused) {
        log("OpenKey token introspection refused the MCP client credentials (401); token checks fail closed until it accepts them.");
      }
      credentialsRefused = true;
      return "unknown";
    }
    if (outcome === "mismatch") return "inactive";
    if (outcome === "unknown") return outcome;
    const now = clock();
    lastAnswerAt = now;
    credentialsRefused = false;
    prune(now);
    if (outcome === "inactive") {
      inactive.set(key, tokenExpiryMs(token, now));
    } else {
      active.set(key, now + ACTIVE_CACHE_MS);
    }
    return outcome;
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
      if (credentialsRefused || lastAnswerAt === undefined) return false;
      return clock() - lastAnswerAt < tokenLifetimeSeconds(token) * 1000;
    },
  };
}

/**
 * An `active` answer must describe the token that was asked about: `sub`,
 * `client_id` and `aud` equal the claims of the already verified JWT.
 */
function answerMatchesToken(answer: Record<string, unknown>, token: string): boolean {
  const jwt = claims(token);
  if (typeof jwt.sub === "string" && answer.sub !== jwt.sub) return false;
  const jwtClient = [jwt.azp, jwt.client_id].find((value) => typeof value === "string" && value.length > 0);
  if (jwtClient !== undefined && answer.client_id !== jwtClient) return false;
  if (jwt.aud !== undefined && audiences(answer.aud) !== audiences(jwt.aud)) return false;
  return true;
}

/** Order-independent form of an `aud` value (string or array); never equal for a missing or malformed one. */
function audiences(value: unknown): string {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) return "\0invalid";
  return JSON.stringify([...new Set<string>(list)].sort());
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

function claims(token: string): ReturnType<typeof decodeJwt> {
  try {
    return decodeJwt(token);
  } catch {
    return {};
  }
}
