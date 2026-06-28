import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, recoverMessageAddress, type Hex } from "viem";

const DEFAULT_NONCE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;

interface NonceEntry {
  address: string;
  createdAt: number;
}

export class ServerAuthError extends Error {}

export class NonceStore {
  private readonly nonces = new Map<string, NonceEntry>();

  constructor(private readonly ttlMs = DEFAULT_NONCE_TTL_MS) {}

  issue(address: string): string {
    this.sweep();
    const normalized = getAddress(address).toLowerCase();
    const nonce = randomBytes(16).toString("hex");
    this.nonces.set(this.key(normalized, nonce), {
      address: normalized,
      createdAt: Date.now(),
    });
    return nonce;
  }

  validate(address: string, nonce: string): boolean {
    const normalized = getAddress(address).toLowerCase();
    const key = this.key(normalized, nonce);
    const entry = this.nonces.get(key);
    if (!entry) return false;
    this.nonces.delete(key);
    return Date.now() - entry.createdAt <= this.ttlMs;
  }

  private key(address: string, nonce: string): string {
    return `${address}:${nonce}`;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.nonces) {
      if (now - entry.createdAt > this.ttlMs) this.nonces.delete(key);
    }
  }
}

export interface VerifiedSiwe {
  address: string;
  nonce: string;
}

export async function verifySiweMessage(
  message: string,
  signature: string,
): Promise<VerifiedSiwe> {
  const lines = message.split("\n");
  let claimed: string;
  try {
    claimed = getAddress((lines[1] ?? "").trim());
  } catch {
    throw new ServerAuthError("SIWE message is missing a valid address on line 2");
  }

  const nonceMatch = message.match(/^Nonce: (.+)$/m);
  if (!nonceMatch || nonceMatch[1] === undefined) {
    throw new ServerAuthError("SIWE message is missing a Nonce line");
  }
  const nonce = nonceMatch[1].trim();

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature: signature as Hex });
  } catch (error) {
    throw new ServerAuthError(
      `SIWE signature recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (getAddress(recovered) !== claimed) {
    throw new ServerAuthError(
      `SIWE signature does not match message address (recovered ${recovered}, expected ${claimed})`,
    );
  }

  return { address: claimed, nonce };
}

export interface SessionToken {
  token: string;
  expiresIn: number;
}

export interface SessionClaims {
  sub: string;
  address: string;
  iat: number;
  exp: number;
}

export function issueSessionToken(
  address: string,
  secret: string,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
): SessionToken {
  const normalized = getAddress(address);
  const now = Math.floor(Date.now() / 1000);
  const claims: SessionClaims = {
    sub: normalized,
    address: normalized,
    iat: now,
    exp: now + ttlSeconds,
  };
  return {
    token: signJwt({ alg: "HS256", typ: "JWT" }, claims, secret),
    expiresIn: ttlSeconds,
  };
}

export function verifySessionToken(token: string, secret: string): { address: string } {
  const claims = verifyJwt(token, secret);
  if (typeof claims.sub !== "string" || claims.sub === "") {
    throw new ServerAuthError("session token missing 'sub' claim");
  }
  return { address: claims.sub };
}

export interface CreateSiweSessionOptions {
  jwtSecret: string;
  nonceStore?: NonceStore;
  sessionTtlSeconds?: number;
}

export function createSiweSession(options: CreateSiweSessionOptions) {
  const nonceStore = options.nonceStore ?? new NonceStore();
  const sessionTtlSeconds = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;

  return {
    issueNonce(address: string): string {
      return nonceStore.issue(address);
    },
    async verify(message: string, signature: string): Promise<SessionToken> {
      const verified = await verifySiweMessage(message, signature);
      if (!nonceStore.validate(verified.address, verified.nonce)) {
        throw new ServerAuthError("nonce is invalid, expired, or already used");
      }
      return issueSessionToken(verified.address, options.jwtSecret, sessionTtlSeconds);
    },
    verifyToken(token: string): { address: string } {
      return verifySessionToken(token, options.jwtSecret);
    },
  };
}

function signJwt(header: object, payload: object, secret: string): string {
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function verifyJwt(token: string, secret: string): SessionClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new ServerAuthError("session token is not a valid JWT");
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  const actual = base64UrlDecode(parts[2]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ServerAuthError("session token signature verification failed");
  }

  const claims = JSON.parse(base64UrlDecode(parts[1]).toString("utf8")) as SessionClaims;
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new ServerAuthError("session token expired");
  }
  return claims;
}

function base64UrlEncode(value: string | Buffer): string {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return buffer.toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
