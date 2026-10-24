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
 * - Under the reserved first segment `apps`, a key needs at least 3 segments
 *   (`apps/<id>/<name>`) and a prefix at least 2 (`apps/<id>/`); `apps`,
 *   `apps/<id>` as a key and `apps/` as a prefix are refused.
 * - The canonical form is the exact input. Non-canonical input is rejected and
 *   never normalized: wrong case, bad characters, empty segments, a
 *   non-canonical owner (EIP-55 for `did:pkh:eip155`).
 * - Bare networks follow `parseNetworkId` unchanged. When PARSING a key or
 *   prefix the network part must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; builders
 *   take a network id that `parseNetworkId` produced, so emitted names stay strict.
 */

import { pkhDid } from "@tinycloud/bootstrap";
import {
  ENCRYPTION_NETWORK_URN_PREFIX,
  NetworkIdError,
  parseNetworkId,
} from "./networkId";
import { DECRYPT_ACTION } from "./types";

/** Path grammar. This is the only place the key-path charset/limits live. */
const SEGMENT_SOURCE = "[a-z0-9][a-z0-9._-]{0,63}";
const PATH_SOURCE = `${SEGMENT_SOURCE}(?:/${SEGMENT_SOURCE}){0,7}`;
const KEY_PATH_RE = new RegExp(`^${PATH_SOURCE}$`);
/**
 * Network part of a KEY or PREFIX resource: printable ASCII, first character
 * alphanumeric, at most 64 characters. Bare networks are not checked against
 * this; they go through `parseNetworkId` unchanged.
 */
const KEY_NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** `<ownerDid>:<network>` head, then the raw path (prefix keeps its trailing `/`). */
const RESOURCE_RE = /^(did:[a-z0-9]+:[A-Za-z0-9._:-]+):([^:/]+)(?:\/(.*))?$/s;
const MAX_PATH_BYTES = 255;
const PKH_EIP155_PREFIX = "did:pkh:eip155:";
const MAX_U64 = 18446744073709551615n;

/** Ability URNs for named encryption keys. */
export const KEY_CREATE_ABILITY = "tinycloud.encryption/key.create";
export const KEY_BLOCK_ABILITY = "tinycloud.encryption/key.block";
export const KEY_UNBLOCK_ABILITY = "tinycloud.encryption/key.unblock";
export const KEY_DELETE_ABILITY = "tinycloud.encryption/key.delete";

/** Key abilities that may appear in a delegation: decrypt, create, block, unblock. `key.delete` never does. */
export const DELEGABLE_KEY_ABILITIES: readonly string[] = Object.freeze([
  DECRYPT_ACTION,
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

/**
 * Canonical form of an owner DID, matching the node: `did:pkh:eip155:<chain>:<address>`
 * needs a positive u64 decimal chain id and a 20-byte hex address (rendered EIP-55);
 * every other DID that passed the owner grammar is returned as is.
 */
function canonicalOwner(ownerDid: string): string {
  if (!ownerDid.startsWith(PKH_EIP155_PREFIX)) return ownerDid;
  const rest = ownerDid.slice(PKH_EIP155_PREFIX.length);
  const colon = rest.indexOf(":");
  const chain = colon === -1 ? "" : rest.slice(0, colon);
  const address = colon === -1 ? "" : rest.slice(colon + 1);
  if (!/^\d+$/.test(chain) || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new EncryptionResourceError(
      "bad_owner",
      `owner DID is not a valid did:pkh:eip155 (got ${JSON.stringify(ownerDid)})`,
    );
  }
  const chainId = BigInt(chain);
  if (chainId === 0n || chainId > MAX_U64) {
    throw new EncryptionResourceError(
      "bad_owner",
      `did:pkh:eip155 chain id must be a positive u64 (got ${JSON.stringify(chain)})`,
    );
  }
  // Checksum through chain 1 so the chain id is never narrowed to a Number.
  const checksummed = pkhDid(address, 1).slice(PKH_EIP155_PREFIX.length + 2);
  return `${PKH_EIP155_PREFIX}${chainId}:${checksummed}`;
}

function assertCanonicalOwner(ownerDid: string): void {
  const canonical = canonicalOwner(ownerDid);
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
  // Depth rule for the reserved `apps` first segment: a key is
  // `apps/<id>/<name>...` (3 or more segments), a prefix is `apps/<id>/...`
  // (2 or more). `apps`, `apps/<id>` as a key and `apps/` as a prefix are refused.
  const segments = path.split("/");
  if (segments[0] === "apps" && segments.length < (what === "key path" ? 3 : 2)) {
    throw new EncryptionResourceError(
      "bad_path",
      `${what} ${JSON.stringify(path)} under apps/ needs ${what === "key path" ? "apps/<id>/<name>" : "apps/<id>/"}`,
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
  if (rawPath === undefined) {
    // Bare networks are normalized (the node does the same); key ids never are.
    const canonicalOwnerDid = canonicalOwner(ownerDid);
    const bareId = `${ENCRYPTION_NETWORK_URN_PREFIX}${canonicalOwnerDid}:${network}`;
    try {
      parseNetworkId(bareId);
    } catch (error) {
      if (error instanceof NetworkIdError) {
        throw new EncryptionResourceError("bad_network", error.message);
      }
      throw error;
    }
    return { kind: "network", ownerDid: canonicalOwnerDid, network, networkId: bareId };
  }
  if (!KEY_NETWORK_RE.test(network)) {
    throw new EncryptionResourceError(
      "bad_network",
      `network ${JSON.stringify(network)} must match ${KEY_NETWORK_RE.source}`,
    );
  }
  assertCanonicalOwner(ownerDid);
  const networkId = `${ENCRYPTION_NETWORK_URN_PREFIX}${ownerDid}:${network}`;

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

/**
 * Builders re-parse their output so they can never emit a URN the parser
 * would reject (for example an owner outside the owner grammar).
 */
function parseBuilt(resource: string, networkId: string): void {
  if (parseEncryptionResource(resource).networkId !== networkId) {
    throw new EncryptionResourceError(
      "malformed",
      `built resource does not round-trip (got ${JSON.stringify(resource)})`,
    );
  }
}

/** Build the exact canonical URN of a named key. */
export function formatKeyResource(networkId: string, path: string): string {
  const id = canonicalNetworkId(networkId);
  assertPath(path, "key path");
  const resource = `${id}/${path}`;
  parseBuilt(resource, id);
  return resource;
}

/** Build the exact canonical URN of a key prefix grant (one trailing `/`). */
export function formatPrefixResource(networkId: string, prefix: string): string {
  const id = canonicalNetworkId(networkId);
  assertPath(prefix, "prefix");
  const resource = `${id}/${prefix}/`;
  parseBuilt(resource, id);
  return resource;
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
