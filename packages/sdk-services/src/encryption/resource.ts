/**
 * Typed encryption resources: bare networks, named keys and key prefixes.
 *
 *   network: urn:tinycloud:encryption:<ownerDid>:<network>
 *   key:     urn:tinycloud:encryption:<ownerDid>:<network>/<path>
 *   prefix:  urn:tinycloud:encryption:<ownerDid>:<network>/<prefix>/
 *
 * Grammar rules:
 * - The owner DID contains no `/`. The string is split at the FIRST `/` into
 *   `<ownerDid>:<network>` and the path; that head splits at its last `:`.
 * - A key path has 1 to 8 segments joined by `/`; each segment is 1 to 64 bytes
 *   of `[a-z0-9._-]` starting with `[a-z0-9]` (so `.` and `..` are impossible);
 *   the whole path is at most 255 bytes.
 * - A prefix is the key form with exactly ONE trailing `/`. The trailing `/` is
 *   significant: `apps/foo/` and `apps/foo` are different resources and
 *   `apps/foo/` does not cover `apps/foobar`.
 * - The canonical form is the exact input. Non-canonical input is rejected and
 *   never normalized: wrong case, bad characters, empty segments, a
 *   non-canonical owner (EIP-55 for `did:pkh:eip155`).
 * - Bare networks follow `parseNetworkId` unchanged. When PARSING a key or
 *   prefix the network name follows the node rule (`[^:/\s]+`); builders take a
 *   network id that `parseNetworkId` produced, so emitted names stay strict.
 */

import { pkhDid } from "@tinycloud/bootstrap";
import {
  ENCRYPTION_NETWORK_URN_PREFIX,
  NetworkIdError,
  parseNetworkId,
} from "./networkId";

/** Path grammar. This is the only place the key-path charset/limits live. */
const SEGMENT_SOURCE = "[a-z0-9][a-z0-9._-]{0,63}";
const PATH_SOURCE = `${SEGMENT_SOURCE}(?:/${SEGMENT_SOURCE}){0,7}`;
const KEY_PATH_RE = new RegExp(`^${PATH_SOURCE}$`);
/** `<ownerDid>:<network>` head, then the raw path (prefix keeps its trailing `/`). */
const RESOURCE_RE = /^(did:[^/\s]+):([^:/\s]+)(?:\/(.*))?$/s;
const MAX_PATH_BYTES = 255;
const PKH_EIP155_DID_RE = /^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/;

/** Ability URNs for named encryption keys. */
export const KEY_CREATE_ABILITY = "tinycloud.encryption/key.create";
export const KEY_BLOCK_ABILITY = "tinycloud.encryption/key.block";
export const KEY_UNBLOCK_ABILITY = "tinycloud.encryption/key.unblock";
export const KEY_DELETE_ABILITY = "tinycloud.encryption/key.delete";

/** Key abilities that may appear in a delegation. `key.delete` never does. */
export const DELEGABLE_KEY_ABILITIES: readonly string[] = Object.freeze([
  KEY_CREATE_ABILITY,
  KEY_BLOCK_ABILITY,
  KEY_UNBLOCK_ABILITY,
]);

/** Node `/info` feature string advertising named-key support. */
export const NAMED_KEYS_FEATURE = "encryption-named-keys-v1";

export type EncryptionResourceErrorCode =
  | "not_encryption_urn"
  | "malformed"
  | "bad_owner"
  | "non_canonical_owner"
  | "bad_network"
  | "empty_path"
  | "bad_path"
  | "path_too_long";

export class EncryptionResourceError extends Error {
  readonly code: EncryptionResourceErrorCode;
  constructor(code: EncryptionResourceErrorCode, message: string) {
    super(message);
    this.name = "EncryptionResourceError";
    this.code = code;
  }
}

export interface ParsedNetworkResource {
  kind: "network";
  ownerDid: string;
  network: string;
  networkId: string;
}

export interface ParsedKeyResource {
  kind: "key";
  ownerDid: string;
  network: string;
  networkId: string;
  path: string;
}

export interface ParsedPrefixResource {
  kind: "prefix";
  ownerDid: string;
  network: string;
  networkId: string;
  /** Path without the trailing `/`. */
  prefix: string;
}

export type ParsedEncryptionResource =
  | ParsedNetworkResource
  | ParsedKeyResource
  | ParsedPrefixResource;

function assertCanonicalOwner(ownerDid: string): void {
  const parts = ownerDid.split(":");
  if (parts.length < 3 || parts.some((p) => p.length === 0)) {
    throw new EncryptionResourceError(
      "bad_owner",
      `owner DID is not well formed (got ${JSON.stringify(ownerDid)})`,
    );
  }
  const pkh = PKH_EIP155_DID_RE.exec(ownerDid);
  if (pkh === null) return;
  const chainId = Number(pkh[1]);
  let canonical: string;
  try {
    canonical = pkhDid(pkh[2]!, chainId);
  } catch {
    throw new EncryptionResourceError(
      "bad_owner",
      `owner DID is not a valid did:pkh:eip155 (got ${JSON.stringify(ownerDid)})`,
    );
  }
  if (canonical !== ownerDid) {
    throw new EncryptionResourceError(
      "non_canonical_owner",
      `owner DID is not canonical (expected ${canonical})`,
    );
  }
}

function assertPath(path: string, what: "key path" | "prefix"): void {
  if (path.length === 0) {
    throw new EncryptionResourceError("empty_path", `${what} must not be empty`);
  }
  if (new TextEncoder().encode(path).length > MAX_PATH_BYTES) {
    throw new EncryptionResourceError(
      "path_too_long",
      `${what} exceeds ${MAX_PATH_BYTES} bytes`,
    );
  }
  if (!KEY_PATH_RE.test(path)) {
    throw new EncryptionResourceError(
      "bad_path",
      `${what} ${JSON.stringify(path)} must match ${KEY_PATH_RE.source}`,
    );
  }
}

/**
 * Parse an encryption resource URN into a bare network, a named key or a key
 * prefix. Throws {@link EncryptionResourceError} on anything that is not
 * already in canonical form.
 */
export function parseEncryptionResource(uri: string): ParsedEncryptionResource {
  if (typeof uri !== "string" || !uri.startsWith(ENCRYPTION_NETWORK_URN_PREFIX)) {
    throw new EncryptionResourceError(
      "not_encryption_urn",
      `resource must start with ${ENCRYPTION_NETWORK_URN_PREFIX}`,
    );
  }
  const body = uri.slice(ENCRYPTION_NETWORK_URN_PREFIX.length);
  const match = RESOURCE_RE.exec(body);
  if (match === null) {
    throw new EncryptionResourceError(
      "malformed",
      `resource is not <ownerDid>:<network>[/<path>] (got ${JSON.stringify(uri)})`,
    );
  }
  const ownerDid = match[1]!;
  const network = match[2]!;
  const rawPath = match[3];
  assertCanonicalOwner(ownerDid);
  const networkId = `${ENCRYPTION_NETWORK_URN_PREFIX}${ownerDid}:${network}`;

  if (rawPath === undefined) {
    try {
      parseNetworkId(networkId);
    } catch (error) {
      if (error instanceof NetworkIdError) {
        throw new EncryptionResourceError("bad_network", error.message);
      }
      throw error;
    }
    return { kind: "network", ownerDid, network, networkId };
  }

  if (rawPath.endsWith("/")) {
    const prefix = rawPath.slice(0, -1);
    assertPath(prefix, "prefix");
    return { kind: "prefix", ownerDid, network, networkId, prefix };
  }
  assertPath(rawPath, "key path");
  return { kind: "key", ownerDid, network, networkId, path: rawPath };
}

function canonicalNetworkId(networkId: string): string {
  let parsed;
  try {
    parsed = parseNetworkId(networkId);
  } catch (error) {
    if (error instanceof NetworkIdError) {
      throw new EncryptionResourceError("bad_network", error.message);
    }
    throw error;
  }
  assertCanonicalOwner(parsed.ownerDid);
  return parsed.networkId;
}

/** Build the exact canonical URN of a named key. */
export function formatKeyResource(networkId: string, path: string): string {
  const id = canonicalNetworkId(networkId);
  assertPath(path, "key path");
  return `${id}/${path}`;
}

/** Build the exact canonical URN of a key prefix grant (one trailing `/`). */
export function formatPrefixResource(networkId: string, prefix: string): string {
  const id = canonicalNetworkId(networkId);
  assertPath(prefix, "prefix");
  return `${id}/${prefix}/`;
}

/**
 * Does the `granted` resource cover the `requested` resource?
 * exact == exact; a prefix covers keys whose path starts with `<prefix>/` and
 * prefixes whose `/`-terminated form starts with the granted one; a bare
 * network covers only the same bare network. Every other pair is false, and
 * so is anything that does not parse.
 */
export function encryptionResourceContains(
  granted: string,
  requested: string,
): boolean {
  let g: ParsedEncryptionResource;
  let r: ParsedEncryptionResource;
  try {
    g = parseEncryptionResource(granted);
    r = parseEncryptionResource(requested);
  } catch {
    return false;
  }
  if (g.networkId !== r.networkId) return false;
  switch (g.kind) {
    case "network":
      return r.kind === "network";
    case "key":
      return r.kind === "key" && r.path === g.path;
    case "prefix":
      if (r.kind === "key") return r.path.startsWith(`${g.prefix}/`);
      if (r.kind === "prefix") return `${r.prefix}/`.startsWith(`${g.prefix}/`);
      return false;
  }
}

/**
 * True only when the node `/info` response lists exactly
 * `"encryption-named-keys-v1"` in `features`.
 */
export function nodeSupportsNamedKeys(
  info: { features?: unknown } | null | undefined,
): boolean {
  const features = info?.features;
  return Array.isArray(features) && features.includes(NAMED_KEYS_FEATURE);
}
