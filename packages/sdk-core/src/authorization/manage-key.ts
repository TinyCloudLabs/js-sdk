import {
  canonicalizeAddress,
  makePkhSpaceId,
  pkhDid,
  verifyEip191MessageSignature,
  type CanonicalAddress,
} from "../identity";
import type { CallbackStrategy, SignRequest } from "./strategies";

/** OAuth scope which grants a client access to the canonical TinyCloud key. */
export const TINYCLOUD_MANAGE_KEY_SCOPE = "tinycloud:manage-key" as const;

/** OIDC claim containing the canonical identity selected by OpenKey. */
export const TINYCLOUD_CANONICAL_IDENTITY_CLAIM =
  "https://tinycloud.xyz/canonical_identity" as const;

/**
 * Adds the canonical-key scope to an OAuth authorization request. Supplying
 * this value to the authorization server is the explicit user-consent step;
 * possession of an unrelated OAuth token is never treated as authority to
 * sign for the canonical key.
 */
export function requestTinyCloudManageKeyScope(
  scopes: string | readonly string[] = [],
): string {
  const requested = typeof scopes === "string" ? scopes.split(/\s+/u) : scopes;
  return [
    ...new Set([...requested, TINYCLOUD_MANAGE_KEY_SCOPE].filter(Boolean)),
  ]
    .sort()
    .join(" ");
}

/** True only when an OAuth grant explicitly includes `tinycloud:manage-key`. */
export function hasTinyCloudManageKeyScope(scopes: unknown): boolean {
  const values = Array.isArray(scopes)
    ? scopes
    : typeof scopes === "string"
      ? scopes.split(/\s+/u)
      : [];
  return values.includes(TINYCLOUD_MANAGE_KEY_SCOPE);
}

/** The one canonical identity an OAuth `tinycloud:manage-key` token may use. */
export interface CanonicalTinyCloudIdentity {
  version: "v1";
  keyId: string;
  address: CanonicalAddress;
  chainId: number;
  did: string;
  spaceId: string;
}

export type OpenKeyManageKeyErrorCode =
  | "CONSENT_REQUIRED"
  | "GRANT_DISABLED"
  | "USER_EXCLUSIVE"
  | "TOKEN_EXPIRED"
  | "MESSAGE_REJECTED"
  | "IDENTITY_MISMATCH";

/** A terminal denial from the OAuth canonical-key signing boundary. */
export class OpenKeyManageKeyError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: OpenKeyManageKeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpenKeyManageKeyError";
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejected(message: string): OpenKeyManageKeyError {
  return new OpenKeyManageKeyError("MESSAGE_REJECTED", message);
}

function identityMismatch(message: string): OpenKeyManageKeyError {
  return new OpenKeyManageKeyError("IDENTITY_MISMATCH", message);
}

/**
 * Parse and fail closed on the OpenID canonical identity claim. The DID and
 * space are derived from the checksummed address instead of trusted
 * independently. The identity claim chooses its chain and space name; this
 * shared contract does not impose an application's chain or space.
 */
export function parseCanonicalTinyCloudIdentity(
  value: unknown,
): CanonicalTinyCloudIdentity {
  if (!isRecord(value))
    throw rejected("Canonical TinyCloud identity is missing");

  const expectedKeys = [
    "address",
    "chainId",
    "did",
    "keyId",
    "spaceId",
    "version",
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw rejected("Canonical TinyCloud identity has an invalid shape");
  }
  if (value.version !== "v1")
    throw rejected("Canonical TinyCloud identity version is unsupported");
  if (typeof value.keyId !== "string" || value.keyId.trim() === "") {
    throw rejected("Canonical TinyCloud identity key ID is invalid");
  }
  if (typeof value.address !== "string") {
    throw rejected("Canonical TinyCloud identity address is invalid");
  }

  let address: CanonicalAddress;
  try {
    address = canonicalizeAddress(value.address);
  } catch {
    throw rejected("Canonical TinyCloud identity address is invalid");
  }
  if (address !== value.address) {
    throw rejected(
      "Canonical TinyCloud identity address must use EIP-55 checksum casing",
    );
  }
  if (
    typeof value.chainId !== "number" ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId <= 0
  ) {
    throw rejected("Canonical TinyCloud identity chain ID is invalid");
  }

  const did = pkhDid(address, value.chainId);
  const spacePrefix = `tinycloud:pkh:eip155:${value.chainId}:${address}:`;
  if (typeof value.spaceId !== "string" || !value.spaceId.startsWith(spacePrefix)) {
    throw rejected("Canonical TinyCloud identity space is invalid");
  }
  const spaceName = value.spaceId.slice(spacePrefix.length);
  let spaceId: string;
  try {
    spaceId = makePkhSpaceId(address, value.chainId, spaceName);
  } catch {
    throw rejected("Canonical TinyCloud identity space is invalid");
  }
  if (value.did !== did || value.spaceId !== spaceId) {
    throw rejected("Canonical TinyCloud identity does not match its address");
  }

  return {
    version: "v1",
    keyId: value.keyId,
    address,
    chainId: value.chainId,
    did,
    spaceId,
  };
}

/** Parse the canonical identity directly from an OAuth/OIDC claims object. */
export function parseCanonicalTinyCloudIdentityClaims(
  claims: unknown,
): CanonicalTinyCloudIdentity {
  if (!isRecord(claims)) throw rejected("OAuth claims are missing");
  return parseCanonicalTinyCloudIdentity(
    claims[TINYCLOUD_CANONICAL_IDENTITY_CLAIM],
  );
}

export interface OpenKeyManageKeySigningRequestBody {
  address: string;
  chainId: number;
  message: string;
  type: "siwe";
}

export interface OpenKeyManageKeySigningResponseBody {
  approved?: boolean;
  signature?: string;
  canonicalIdentity?: unknown;
  code?: string;
  reason?: string;
  error?: string;
}

/** Minimal fetch surface used by the manage-key signer. */
export type OpenKeyManageKeyFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export interface OpenKeyManageKeySigningStrategyOptions {
  /** The OpenKey public signer route for a consented OAuth client. */
  endpoint: string;
  /** A bearer token obtained with `tinycloud:manage-key` consent. */
  token: string | (() => string | Promise<string | undefined>);
  /** OAuth grant scopes returned with the bearer token. */
  scopes: string | readonly string[];
  /** Canonical identity parsed from the token's OIDC claims. */
  identity: CanonicalTinyCloudIdentity;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: OpenKeyManageKeyFetch;
}

export interface OpenKeyManageKeyCallbackStrategy extends CallbackStrategy {
  /** Lets the SDK avoid bootstrap paths that require broader signing authority. */
  openKeyAutoSign: true;
}

function identitiesEqual(
  left: CanonicalTinyCloudIdentity,
  right: CanonicalTinyCloudIdentity,
): boolean {
  return (
    left.version === right.version &&
    left.keyId === right.keyId &&
    left.address === right.address &&
    left.chainId === right.chainId &&
    left.did === right.did &&
    left.spaceId === right.spaceId
  );
}

function errorForResponse(
  body: OpenKeyManageKeySigningResponseBody | undefined,
  status: number,
): OpenKeyManageKeyError {
  const message =
    body?.reason ??
    body?.error ??
    `OpenKey manage-key signing failed with HTTP ${status}`;
  // OpenKey's signer boundary may put a machine-readable denial in either
  // field. Keep this mapping intentionally small and terminal: callers must
  // restart OAuth or show the policy result, not retry a rejected SIWE.
  switch (body?.code ?? body?.error) {
    case "missing_scope":
    case "consent_required":
      return new OpenKeyManageKeyError("CONSENT_REQUIRED", message);
    case "client_disabled":
    case "signing_disabled":
    case "grant_disabled":
      return new OpenKeyManageKeyError("GRANT_DISABLED", message);
    case "user_exclusive":
      return new OpenKeyManageKeyError("USER_EXCLUSIVE", message);
    case "token_expired":
    case "token_too_old":
    case "invalid_token":
    case "expired_token":
      return new OpenKeyManageKeyError("TOKEN_EXPIRED", message);
    default:
      return new OpenKeyManageKeyError(
        status === 401 ? "TOKEN_EXPIRED" : "MESSAGE_REJECTED",
        message,
      );
  }
}

async function resolveToken(
  token: OpenKeyManageKeySigningStrategyOptions["token"],
): Promise<string> {
  const value = typeof token === "function" ? await token() : token;
  if (typeof value !== "string" || value.trim() === "") {
    throw new OpenKeyManageKeyError(
      "CONSENT_REQUIRED",
      "A manage-key OAuth bearer token is required",
    );
  }
  return value;
}

function normalizeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw rejected("OpenKey manage-key signing endpoint must be an absolute URL");
  }
  const rawHttpAuthority = value.match(/^http:\/\/([^/?#]*)/iu)?.[1];
  const loopback = rawHttpAuthority !== undefined &&
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/u.test(rawHttpAuthority);
  if (
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw rejected("OpenKey manage-key signing endpoint must use HTTPS or exact loopback HTTP");
  }
  return endpoint.href;
}

function assertSignInRequest(
  request: SignRequest,
  identity: CanonicalTinyCloudIdentity,
): asserts request is SignRequest & OpenKeyManageKeySigningRequestBody {
  if (
    request.type !== "siwe" ||
    request.purpose !== "sign-in" ||
    request.chainId !== identity.chainId ||
    request.address !== identity.address ||
    typeof request.message !== "string" ||
    request.message.length === 0
  ) {
    throw rejected(
      "Manage-key signing only permits the canonical sign-in SIWE request",
    );
  }
}

/**
 * Create a client-bound signer for an OAuth token consented for
 * `tinycloud:manage-key`. It sends exactly one bearer-authenticated, cookie-
 * free request for the original SIWE string and accepts only the claimed
 * canonical identity's EIP-191 signature.
 */
export function createOpenKeyManageKeySigningStrategy(
  options: OpenKeyManageKeySigningStrategyOptions,
): OpenKeyManageKeyCallbackStrategy {
  const identity = parseCanonicalTinyCloudIdentity(options.identity);
  const endpoint = normalizeEndpoint(options.endpoint);
  return {
    type: "callback",
    openKeyAutoSign: true,
    handler: async (request) => {
      assertSignInRequest(request, identity);
      const fetchImpl = options.fetch ?? globalThis.fetch;
      if (!fetchImpl)
        throw rejected("OpenKey manage-key signing requires fetch");
      if (!hasTinyCloudManageKeyScope(options.scopes)) {
        throw new OpenKeyManageKeyError(
          "CONSENT_REQUIRED",
          "The OAuth bearer token was not granted tinycloud:manage-key",
        );
      }

      const token = await resolveToken(options.token);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        credentials: "omit",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          address: request.address,
          chainId: request.chainId,
          message: request.message,
          type: "siwe",
        } satisfies OpenKeyManageKeySigningRequestBody),
      });

      let body: OpenKeyManageKeySigningResponseBody | undefined;
      try {
        const value: unknown = await response.json();
        body = isRecord(value)
          ? (value as OpenKeyManageKeySigningResponseBody)
          : undefined;
      } catch {
        body = undefined;
      }
      if (!response.ok || body?.approved !== true)
        throw errorForResponse(body, response.status);
      if (typeof body.signature !== "string")
        throw rejected("OpenKey manage-key signer did not return a signature");

      const responseIdentity = parseCanonicalTinyCloudIdentity(
        body.canonicalIdentity,
      );
      if (!identitiesEqual(identity, responseIdentity)) {
        throw identityMismatch(
          "OpenKey manage-key signer returned a different canonical identity",
        );
      }
      if (
        !(await verifyEip191MessageSignature(
          request.message,
          body.signature,
          identity.address,
        ))
      ) {
        throw rejected(
          "OpenKey manage-key signer returned an invalid signature",
        );
      }
      return { approved: true, signature: body.signature };
    },
  };
}
