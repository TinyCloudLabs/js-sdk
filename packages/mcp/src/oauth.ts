import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { pkhDid } from "@tinycloud/node-sdk";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

import type { TokenStatusChecker } from "./token-status.js";

const OWNER_DIDS_CLAIM = "https://tinycloud.xyz/owner_dids";

export interface OpenKeyOAuthConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;
  readonly requiredScope?: string;
  /**
   * OpenKey token status check run after the signature check on every call.
   * Hosted deployments always set it; a verifier built without one checks the
   * signed claims only.
   */
  readonly tokenStatus?: TokenStatusChecker;
}

export function createOpenKeyTokenVerifier(config: OpenKeyOAuthConfig): OAuthTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUri));
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.issuer,
          audience: config.audience,
        });
        const info = authInfo(token, payload, config);
        if (config.tokenStatus !== undefined) await requireUsableStatus(config.tokenStatus, token);
        return info;
      } catch (error) {
        if (error instanceof errors.JOSEError) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "The OpenKey access token is invalid.");
        }
        throw error;
      }
    },
  };
}

/**
 * `inactive` is a 401 invalid_token. `unknown` (OpenKey unreachable, 4xx/5xx,
 * timeout, unreadable answer) is accepted only while `toleratesUnknown` holds;
 * after that it is refused as a 500 server_error, the transport's answer for a
 * fault that is not the token's: a 401 would send clients into re-authorisation
 * that cannot succeed while OpenKey is unavailable.
 */
async function requireUsableStatus(checker: TokenStatusChecker, token: string): Promise<void> {
  const status = await checker.tokenStatus(token);
  if (status === "active") return;
  if (status === "inactive") {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "The OpenKey access token is no longer active.");
  }
  if (!checker.toleratesUnknown(token)) {
    throw new OAuthError(OAuthErrorCode.ServerError, "The OpenKey access token status is unavailable.");
  }
}

export async function loadOAuthMetadata(metadataUrl: URL): Promise<OAuthMetadata> {
  const response = await fetch(metadataUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("OpenKey OAuth discovery failed.");
  const metadata = await response.json() as OAuthMetadata;
  if (typeof metadata.issuer !== "string" || typeof metadata.jwks_uri !== "string") {
    throw new Error("OpenKey OAuth metadata is incomplete.");
  }
  return metadata;
}

function authInfo(
  token: string,
  payload: JWTPayload,
  config: OpenKeyOAuthConfig,
): AuthInfo {
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "The OpenKey access token does not identify a subject.");
  }
  if (typeof payload.exp !== "number") {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "The OpenKey access token has no expiry.");
  }
  const scopes = typeof payload.scope === "string"
    ? payload.scope.split(/\s+/).filter(Boolean)
    : [];
  if (config.requiredScope !== undefined && !scopes.includes(config.requiredScope)) {
    throw new OAuthError(
      OAuthErrorCode.InsufficientScope,
      "The OpenKey access token is missing the TinyCloud MCP scope.",
    );
  }
  const clientId = firstString(payload.azp, payload.client_id) ?? "unknown";
  const ownerDids = canonicalOwnerDids(payload[OWNER_DIDS_CLAIM]);
  if (ownerDids === undefined) {
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      "The OpenKey access token has no valid TinyCloud owner identity.",
    );
  }
  return {
    token,
    clientId,
    scopes,
    expiresAt: payload.exp,
    resource: new URL(config.audience),
    extra: {
      subject: payload.sub,
      ownerDids,
    },
  };
}

/**
 * OpenKey issues owner DIDs as `did:pkh:eip155:<chain>:<address>`. Only that
 * exact syntax is accepted, canonicalised, and passed on to owner comparison
 * and the approval text. One malformed value refuses the whole claim rather
 * than being skipped.
 */
const OWNER_DID = /^did:pkh:eip155:([1-9][0-9]{0,15}):(0x[0-9a-fA-F]{40})$/;

function canonicalOwnerDids(claim: unknown): string[] | undefined {
  if (!Array.isArray(claim) || claim.length === 0) return undefined;
  const ownerDids: string[] = [];
  for (const value of claim) {
    const match = typeof value === "string" ? OWNER_DID.exec(value) : null;
    if (match === null) return undefined;
    try {
      ownerDids.push(pkhDid(match[2]!, Number(match[1])));
    } catch {
      return undefined;
    }
  }
  return [...new Set(ownerDids)];
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}
