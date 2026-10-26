import { createHash } from "node:crypto";

import { decodeJwt } from "jose";

/** What OpenKey's RFC 7662 token introspection says about one access token. */
export type TokenStatus = "active" | "inactive" | "unknown";

export interface TokenStatusConfig {
  /** OpenKey's resource-server introspection endpoint (`TC_MCP_INTROSPECTION_URL`). */
  readonly endpoint: string;
  /** The resource URL (JWT audience) this checker serves; an active answer must name it. */
  readonly resourceUrl: string;
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
   * Whether an `unknown` status may still be accepted for this token: only a
   * token that OpenKey itself answered active to this process, and only while
   * the time since that answer is shorter than the token's own lifetime
   * (`exp - iat`, 300 s when the token does not carry both). A token never
   * confirmed active, or one answered inactive, is refused, and nothing is
   * tolerated while OpenKey is refusing the client credentials.
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
  /** token hash -> when OpenKey last answered this token active, and the token's expiry (ms). */
  const confirmedActive = new Map<string, { at: number; expiresAt: number }>();
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
      return answerMatchesToken(Object.fromEntries(Object.entries(result)), token, config.resourceUrl)
        ? "active"
        : "mismatch";
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
    if (outcome === "unknown") return outcome;
    const now = clock();
    prune(now);
    if (outcome === "mismatch") {
      // The answer describes some other token: refused like an inactive one, but it
      // is not an answer about this token and confirms nothing.
      inactive.set(key, tokenExpiryMs(token, now));
      confirmedActive.delete(key);
      return "inactive";
    }
    credentialsRefused = false;
    if (outcome === "inactive") {
      inactive.set(key, tokenExpiryMs(token, now));
      confirmedActive.delete(key);
    } else {
      active.set(key, now + ACTIVE_CACHE_MS);
      // Delete first so a re-confirmed token moves to the newest slot of the map.
      confirmedActive.delete(key);
      confirmedActive.set(key, { at: now, expiresAt: tokenExpiryMs(token, now) });
    }
    return outcome;
  }

  function prune(now: number): void {
    for (const [key, until] of active) if (until <= now) active.delete(key);
    for (const [key, until] of inactive) if (until <= now) inactive.delete(key);
    for (const [key, entry] of confirmedActive) if (entry.expiresAt <= now) confirmedActive.delete(key);
    // An evicted entry costs one more introspection for that token; an evicted
    // confirmation means that token is refused while OpenKey cannot answer.
    for (const cache of [active, inactive, confirmedActive]) {
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
      if (credentialsRefused) return false;
      const confirmed = confirmedActive.get(createHash("sha256").update(token).digest("hex"));
      if (confirmed === undefined) return false;
      const now = clock();
      return confirmed.expiresAt > now && now - confirmed.at < tokenLifetimeSeconds(token) * 1000;
    },
  };
}

/**
 * An `active` answer must describe the token that was asked about: `sub` and
 * `client_id` equal the claims of the already verified JWT, and `aud` is a
 * non-empty subset of the JWT's audiences that includes `resourceUrl` (OpenKey
 * answers only with the audiences the resource server may know, while the JWT
 * can carry more, e.g. its userinfo endpoint).
 */
function answerMatchesToken(answer: Record<string, unknown>, token: string, resourceUrl: string): boolean {
  const jwt = claims(token);
  if (typeof jwt.sub === "string" && answer.sub !== jwt.sub) return false;
  const jwtClient = [jwt.azp, jwt.client_id].find((value) => typeof value === "string" && value.length > 0);
  if (jwtClient !== undefined && answer.client_id !== jwtClient) return false;
  if (jwt.aud === undefined) return true;
  const answered = audienceList(answer.aud);
  const signed = audienceList(jwt.aud);
  return answered.length > 0 && answered.includes(resourceUrl) && answered.every((entry) => signed.includes(entry));
}

/** An `aud` value (string or array) as a list; a missing or malformed one is empty. */
function audienceList(value: unknown): string[] {
  const list = typeof value === "string" ? [value] : value;
  return Array.isArray(list) && list.every((entry) => typeof entry === "string") ? list : [];
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
