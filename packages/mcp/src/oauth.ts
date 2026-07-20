import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

const OWNER_DIDS_CLAIM = "https://tinycloud.xyz/owner_dids";

export interface OpenKeyOAuthConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;
  readonly requiredScope?: string;
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
        return authInfo(token, payload, config);
      } catch (error) {
        if (error instanceof errors.JOSEError) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, "The OpenKey access token is invalid.");
        }
        throw error;
      }
    },
  };
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
  const ownerDids = Array.isArray(payload[OWNER_DIDS_CLAIM])
    ? payload[OWNER_DIDS_CLAIM].filter((value): value is string => typeof value === "string")
    : [];
  if (ownerDids.length === 0) {
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      "The OpenKey access token has no TinyCloud owner identity.",
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

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}
