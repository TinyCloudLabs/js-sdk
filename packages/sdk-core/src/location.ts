/**
 * TinyCloud location registry helpers.
 *
 * The registry maps a DID to one or more multiaddrs. Registry records are
 * signed by the DID subject; centralized storage is only a discovery cache.
 */

import { multiaddr } from "@multiformats/multiaddr";
import { multiaddrToUri } from "@multiformats/multiaddr-to-uri";
import { uriToMultiaddr } from "@multiformats/uri-to-multiaddr";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { verifyMessage } from "viem";

import { pkhDid } from "./identity";

export interface LocationRecordPayload {
  version: 1;
  subject: string;
  multiaddrs: string[];
  updated_at: string;
  sequence: number;
}

export interface LocationRecord extends LocationRecordPayload {
  signature: string;
}

export interface LocationRecordV2Payload {
  version: 2;
  subject: string;
  nodes: Array<{ did: string; url: string }>;
  spaces: Array<{
    space: string;
    nodes: Array<{ did: string; mode: "read-write" | "read-only" }>;
  }>;
  encryptionNode: string | null;
  updated_at: string;
  sequence: number;
}

export interface LocationRecordV2 extends LocationRecordV2Payload {
  signature: string;
}

export interface VerifyOwnerNodeBindingOptions {
  /** Registry that serves the owner's signed location record. */
  registryUrl: string;
  /** Owner DID that signed both the location record and share policy. */
  ownerDid: string;
  /** Exact node origin carried by the share target. */
  nodeOrigin: string;
  /** Exact node DID carried by the node-attested share target. */
  nodeDid: string;
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Total registry + Node identity lookup budget. Defaults to 5 seconds. */
  timeoutMs?: number;
}

export interface VerifiedOwnerNodeBinding {
  readonly record: LocationRecord;
  readonly nodeOrigin: string;
  readonly nodeDid: string;
}

export interface PublishLocationRecordOptions {
  /** Public registry that stores the signed discovery record. */
  registryUrl: string;
  /** DID that owns the active TinyCloud session. */
  subject: string;
  /** Exact active TinyCloud node origin to publish. */
  nodeOrigin: string;
  /** Signer for `subject`; the registry never receives private key material. */
  signer: LocationRecordSigner;
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Where a resolved TinyCloud host came from, ordered highest to lowest
 * priority. `local-loopback` and `local-link` are probed + identity-verified
 * (see {@link discoverLocalTinyCloudNode}); the rest are resolved the same
 * way they always have been (no liveness probing). New local-discovery
 * sources (e.g. a future `tunnel` or `mdns` source) slot in next to
 * `local-link` without touching the unprobed sources below them.
 */
export type LocationSource =
  | "explicit"
  | "local-loopback"
  | "local-link"
  | "blockchain"
  | "centralized"
  | "fallback";

export const DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL =
  "https://registry.tinycloud.xyz";
export const DEFAULT_TINYCLOUD_FALLBACK_HOST = "https://node.tinycloud.xyz";

/** Conventional local loopback node URL. Probed only when explicitly configured. */
export const DEFAULT_LOCAL_NODE_URL = "http://127.0.0.1:8000";
/** Probe timeout for the local loopback candidate. No retries. */
export const LOCAL_LOOPBACK_PROBE_TIMEOUT_MS = 250;
/** Probe timeout for local.tinycloud.link candidates. No retries. */
export const LOCAL_LINK_PROBE_TIMEOUT_MS = 750;
/** Hostname suffix identifying a local-link tunnel candidate. */
export const LOCAL_LINK_HOST_SUFFIX = ".local.tinycloud.link";
/** Total network budget for an owner registry record plus live Node identity. */
export const OWNER_NODE_BINDING_TIMEOUT_MS = 5_000;

export interface LocationCandidate {
  source: LocationSource;
  multiaddrs: string[];
  record?: LocationRecord;
}

export interface LocationResolutionAttempt {
  source: LocationSource;
  candidate?: LocationCandidate;
  error?: Error;
}

export interface ResolvedCloudLocation {
  subject: string;
  source: LocationSource;
  multiaddrs: string[];
  record?: LocationRecord;
  attempts: LocationResolutionAttempt[];
  resolvedAt: string;
}

export interface ResolveCloudLocationOptions {
  /** Highest-priority location supplied directly by the caller. */
  explicitMultiaddrs?: string[];
  /** Optional blockchain resolver adapter. */
  blockchain?: (
    subject: string,
  ) => Promise<LocationCandidateInput | null | undefined>;
  /** Centralized location registry base URL, e.g. https://registry.tinycloud.xyz. */
  centralizedRegistryUrl?: string;
  /** Lowest-priority fallback location. */
  fallbackMultiaddrs?: string[];
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Verify centralized/blockchain record signatures. Default true. */
  verifyRecords?: boolean;
}

export interface ResolvedTinyCloudHosts {
  hosts: string[];
  location: ResolvedCloudLocation;
}

/**
 * Trust-on-first-use pin store for locally-discovered node identities, keyed
 * by candidate URL. The first successful `/info` check for a URL with no
 * existing pin adopts and pins that node's DID; every later check for the
 * same URL must match the pin. Implementations: CLI (profile store), web
 * (localStorage), node-sdk (config-provided callback, else in-memory).
 */
export interface LocalNodeIdentityStore {
  get(url: string): string | undefined | Promise<string | undefined>;
  set(url: string, nodeDid: string): void | Promise<void>;
}

/** In-memory {@link LocalNodeIdentityStore}. Does not persist across process restarts. */
export function createInMemoryLocalNodeIdentityStore(): LocalNodeIdentityStore {
  const pins = new Map<string, string>();
  return {
    get: (url) => pins.get(url),
    set: (url, nodeDid) => {
      pins.set(url, nodeDid);
    },
  };
}

/**
 * Minimal subset of the DOM `Storage` interface. Declared locally so
 * sdk-core (no DOM lib) doesn't need to depend on browser types.
 */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Default namespaced key {@link createLocalStorageLocalNodeIdentityStore} stores its pins under. */
export const DEFAULT_LOCAL_NODE_PIN_STORAGE_KEY = "tinycloud.localNodePins.v1";

/** `globalThis.localStorage`, or undefined where it is missing or throws on access. */
export function defaultWebStorage(): WebStorageLike | undefined {
  try {
    return (globalThis as unknown as { localStorage?: WebStorageLike }).localStorage;
  } catch {
    // Some sandboxed environments (e.g. private-browsing Safari, locked-down
    // iframes) throw on access instead of leaving it undefined.
    return undefined;
  }
}

/**
 * `localStorage`-backed {@link LocalNodeIdentityStore}, namespaced under a
 * single JSON blob (default key {@link DEFAULT_LOCAL_NODE_PIN_STORAGE_KEY}).
 * Falls back to an in-memory store when `localStorage` is unavailable (SSR,
 * Node.js, sandboxed contexts that throw on access, etc.), so callers never
 * have to branch on environment. Corrupt stored JSON is reset rather than
 * thrown.
 */
export function createLocalStorageLocalNodeIdentityStore(
  storage?: WebStorageLike,
  storageKey: string = DEFAULT_LOCAL_NODE_PIN_STORAGE_KEY,
): LocalNodeIdentityStore {
  const backing = storage ?? defaultWebStorage();
  if (!backing) {
    return createInMemoryLocalNodeIdentityStore();
  }

  const readPins = (): Record<string, string> => {
    const raw = backing.getItem(storageKey);
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      // Corrupt JSON below: reset rather than crash.
    }
    backing.removeItem(storageKey);
    return {};
  };

  return {
    get: (url) => readPins()[url],
    set: (url, nodeDid) => {
      const pins = readPins();
      pins[url] = nodeDid;
      backing.setItem(storageKey, JSON.stringify(pins));
    },
  };
}

export interface DiscoverLocalTinyCloudNodeOptions {
  /**
   * Subject DID used to look up the registry LocationRecord for
   * `*.local.tinycloud.link` multiaddrs (source `local-link`). Omit to skip
   * that lookup — the local-loopback and `localLinkName` candidates don't
   * need it.
   */
  subject?: string;
  /** Enable local-node auto-discovery. Default true. */
  autoDiscoverLocalNode?: boolean;
  /** Local loopback node URL to probe. Omit to avoid probing loopback. */
  localNodeUrl?: string;
  /** Known `*.local.tinycloud.link` subdomain name, probed directly. */
  localLinkName?: string;
  /** Centralized location registry URL, used for the `local-link` registry lookup. Default https://registry.tinycloud.xyz. */
  registryUrl?: string | null;
  /** Expected local node DID. Wins over any pinned value; a mismatch rejects the candidate. */
  expectedNodeDid?: string;
  /** Pin store for trust-on-first-use identity verification. Defaults to an in-memory store. */
  identityStore?: LocalNodeIdentityStore;
  /** Verify the registry LocationRecord signature before trusting its `local-link` multiaddrs. Default true. */
  verifyRecords?: boolean;
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

export interface DiscoveredLocalTinyCloudNode {
  source: Extract<LocationSource, "local-loopback" | "local-link">;
  url: string;
  nodeDid: string;
}

export interface ResolveTinyCloudHostsOptions {
  /** Highest-priority TinyCloud HTTP host URLs or multiaddrs supplied directly. */
  explicitHosts?: string[];
  /** Optional blockchain resolver adapter. */
  blockchain?: ResolveCloudLocationOptions["blockchain"];
  /** Centralized location registry URL. Default https://registry.tinycloud.xyz. */
  registryUrl?: string | null;
  /** Lowest-priority fallback HTTP host URLs or multiaddrs. Default hosted TinyCloud node. */
  fallbackHosts?: string[] | null;
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Verify centralized/blockchain record signatures. Default true. */
  verifyRecords?: boolean;
  /**
   * Probe configured and registered local TinyCloud node endpoints before
   * falling back to registry/hosted resolution. Default true. The loopback
   * URL is probed only when `localNodeUrl` is explicitly configured.
   */
  autoDiscoverLocalNode?: boolean;
  /** Local loopback node URL to probe. Omit to avoid probing loopback. */
  localNodeUrl?: string;
  /** Known `*.local.tinycloud.link` subdomain name, probed directly. */
  localLinkName?: string;
  /** Expected local node DID. Wins over any pinned value; a mismatch rejects the candidate. */
  expectedNodeDid?: string;
  /** Pin store for trust-on-first-use local node identity verification. Defaults to an in-memory store. */
  localNodeIdentityStore?: LocalNodeIdentityStore;
}

export type LocationCandidateInput =
  | string[]
  | LocationRecord
  | {
      multiaddrs: string[];
      record?: LocationRecord;
    };

export type LocationRecordSigner =
  | {
      type: "did:pkh";
      signMessage(message: string): Promise<string>;
    }
  | {
      type: "did:key";
      signBytes(bytes: Uint8Array): Promise<Uint8Array>;
    };

export class LocationRecordValidationError extends Error {
  constructor(message: string) {
    super(`Location record validation failed: ${message}`);
    this.name = "LocationRecordValidationError";
  }
}

/** The location registry answered with a non-success HTTP status. */
export class LocationRegistryHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LocationRegistryHttpError";
  }
}

export class CloudLocationResolutionError extends Error {
  public readonly attempts: LocationResolutionAttempt[];
  public readonly cause?: Error;

  constructor(subject: string, attempts: LocationResolutionAttempt[]) {
    super(`Unable to resolve TinyCloud location for ${subject}`);
    this.name = "CloudLocationResolutionError";
    this.attempts = attempts;
    // A lone failed source has an unambiguous cause; multiple independent
    // failures remain in attempts rather than inventing one HTTP verdict.
    let failure: Error | undefined;
    for (const attempt of attempts) {
      if (attempt.error === undefined) continue;
      if (failure !== undefined) {
        failure = undefined;
        break;
      }
      failure = attempt.error;
    }
    this.cause = failure;
  }
}

export function locationPayloadForRecord(
  record: LocationRecord,
): LocationRecordPayload {
  return {
    version: record.version,
    subject: record.subject,
    multiaddrs: [...record.multiaddrs],
    updated_at: record.updated_at,
    sequence: record.sequence,
  };
}

export function canonicalLocationPayload(
  payload: LocationRecordPayload,
): string {
  return JSON.stringify({
    version: payload.version,
    subject: payload.subject,
    multiaddrs: payload.multiaddrs,
    updated_at: payload.updated_at,
    sequence: payload.sequence,
  });
}

export async function signLocationRecord(
  payload: LocationRecordPayload,
  signer: LocationRecordSigner,
): Promise<LocationRecord> {
  validateLocationRecordPayload(payload);
  const message = canonicalLocationPayload(payload);
  const signature =
    signer.type === "did:pkh"
      ? await signer.signMessage(message)
      : base64UrlEncode(
          await signer.signBytes(new TextEncoder().encode(message)),
        );
  return { ...payload, signature };
}

export function validateLocationRecordPayload(
  input: unknown,
): LocationRecordPayload {
  if (input === null || typeof input !== "object") {
    throw new LocationRecordValidationError("payload must be an object");
  }

  const payload = input as Partial<LocationRecordPayload>;
  if (payload.version !== 1) {
    throw new LocationRecordValidationError("version must be 1");
  }
  validateSubject(payload.subject);
  validateMultiaddrs(payload.multiaddrs);
  if (
    typeof payload.updated_at !== "string" ||
    Number.isNaN(Date.parse(payload.updated_at))
  ) {
    throw new LocationRecordValidationError(
      "updated_at must be an ISO timestamp",
    );
  }
  if (
    typeof payload.sequence !== "number" ||
    !Number.isSafeInteger(payload.sequence) ||
    payload.sequence < 0
  ) {
    throw new LocationRecordValidationError(
      "sequence must be a non-negative safe integer",
    );
  }

  return {
    version: 1,
    subject: payload.subject,
    multiaddrs: [...payload.multiaddrs],
    updated_at: payload.updated_at,
    sequence: payload.sequence,
  };
}

export function validateLocationRecord(input: unknown): LocationRecord {
  const payload = validateLocationRecordPayload(input);
  const signature = (input as Partial<LocationRecord>).signature;
  if (typeof signature !== "string" || signature.length === 0) {
    throw new LocationRecordValidationError(
      "signature must be a non-empty string",
    );
  }
  return { ...payload, signature };
}

export async function verifyLocationRecord(
  input: LocationRecord,
): Promise<boolean> {
  const record = validateLocationRecord(input);
  const payload = canonicalLocationPayload(locationPayloadForRecord(record));

  if (record.subject.startsWith("did:pkh:")) {
    return verifyPkhSignature(record.subject, payload, record.signature);
  }
  if (record.subject.startsWith("did:key:")) {
    return verifyDidKeySignature(record.subject, payload, record.signature);
  }
  return false;
}

export function canonicalLocationPayloadV2(
  payload: LocationRecordV2Payload,
): string {
  return JSON.stringify({
    version: payload.version,
    subject: payload.subject,
    nodes: payload.nodes
      .map(({ did, url }) => ({ did, url }))
      .sort((left, right) => compareAscii(left.did, right.did)),
    spaces: payload.spaces
      .map(({ space, nodes }) => ({
        space,
        nodes: nodes
          .map(({ did, mode }) => ({ did, mode }))
          .sort((left, right) => compareAscii(left.did, right.did)),
      }))
      .sort((left, right) => compareAscii(left.space, right.space)),
    encryptionNode: payload.encryptionNode,
    updated_at: payload.updated_at,
    sequence: payload.sequence,
  });
}

export function validateLocationRecordV2Payload(
  input: unknown,
): LocationRecordV2Payload {
  const payload = exactV2Object(
    input,
    ["version", "subject", "nodes", "spaces", "encryptionNode", "updated_at", "sequence"],
    "payload",
  );
  if (payload.version !== 2) {
    throw new LocationRecordValidationError("version must be 2");
  }
  validateV2OwnerSubject(payload.subject);

  if (!Array.isArray(payload.nodes)) {
    throw new LocationRecordValidationError("nodes must be an array");
  }
  const nodeDids = new Set<string>();
  const origins = new Set<string>();
  const nodes: LocationRecordV2Payload["nodes"] = [];
  for (const item of payload.nodes) {
    const node = exactV2Object(item, ["did", "url"], "node");
    if (typeof node.did !== "string") {
      throw new LocationRecordValidationError("node.did must be a string");
    }
    validateV2DidKey(node.did, "node.did");
    if (typeof node.url !== "string") {
      throw new LocationRecordValidationError("node.url must be a string");
    }
    const origin = validateV2Origin(node.url);
    if (nodeDids.has(node.did) || origins.has(origin)) {
      throw new LocationRecordValidationError("node DIDs and origins must be unique");
    }
    nodeDids.add(node.did);
    origins.add(origin);
    nodes.push({ did: node.did, url: origin });
  }

  if (!Array.isArray(payload.spaces)) {
    throw new LocationRecordValidationError("spaces must be an array");
  }
  const spaceKeys = new Set<string>();
  const spaces: LocationRecordV2Payload["spaces"] = [];
  for (const item of payload.spaces) {
    const space = exactV2Object(item, ["space", "nodes"], "space");
    if (typeof space.space !== "string" || !isAsciiNonEmpty(space.space)) {
      throw new LocationRecordValidationError("space.space must be a non-empty ASCII URI");
    }
    const identity = validateV2SpaceOwner(space.space, payload.subject as string);
    if (spaceKeys.has(identity)) {
      throw new LocationRecordValidationError("spaces must be unique");
    }
    spaceKeys.add(identity);
    if (!Array.isArray(space.nodes)) {
      throw new LocationRecordValidationError("space.nodes must be an array");
    }
    const membershipDids = new Set<string>();
    const memberships: LocationRecordV2Payload["spaces"][number]["nodes"] = [];
    for (const item of space.nodes) {
      const membership = exactV2Object(item, ["did", "mode"], "space membership");
      if (typeof membership.did !== "string") {
        throw new LocationRecordValidationError("membership.did must be a string");
      }
      validateV2DidKey(membership.did, "membership.did");
      if (!nodeDids.has(membership.did)) {
        throw new LocationRecordValidationError("space membership must reference a listed node");
      }
      if (membershipDids.has(membership.did)) {
        throw new LocationRecordValidationError("space membership DIDs must be unique");
      }
      if (membership.mode !== "read-write" && membership.mode !== "read-only") {
        throw new LocationRecordValidationError("membership.mode must be read-write or read-only");
      }
      membershipDids.add(membership.did);
      memberships.push({ did: membership.did, mode: membership.mode });
    }
    spaces.push({ space: space.space, nodes: memberships });
  }

  if (payload.encryptionNode !== null) {
    if (typeof payload.encryptionNode !== "string") {
      throw new LocationRecordValidationError("encryptionNode must be a DID or null");
    }
    validateV2DidKey(payload.encryptionNode, "encryptionNode");
    if (!nodeDids.has(payload.encryptionNode)) {
      throw new LocationRecordValidationError("encryptionNode must reference a listed node");
    }
  }
  if (typeof payload.updated_at !== "string" || !isV2UtcTimestamp(payload.updated_at)) {
    throw new LocationRecordValidationError("updated_at must be a valid UTC RFC 3339 timestamp with milliseconds");
  }
  if (
    typeof payload.sequence !== "number" ||
    !Number.isSafeInteger(payload.sequence) ||
    payload.sequence < 0
  ) {
    throw new LocationRecordValidationError("sequence must be a non-negative safe integer");
  }

  return {
    version: 2,
    subject: payload.subject as string,
    nodes,
    spaces,
    encryptionNode: payload.encryptionNode as string | null,
    updated_at: payload.updated_at,
    sequence: payload.sequence,
  };
}

export function validateLocationRecordV2(input: unknown): LocationRecordV2 {
  const record = exactV2Object(
    input,
    ["version", "subject", "nodes", "spaces", "encryptionNode", "updated_at", "sequence", "signature"],
    "record",
  );
  const payload = validateLocationRecordV2Payload({
    version: record.version,
    subject: record.subject,
    nodes: record.nodes,
    spaces: record.spaces,
    encryptionNode: record.encryptionNode,
    updated_at: record.updated_at,
    sequence: record.sequence,
  });
  if (typeof record.signature !== "string" || !isCanonicalV2Signature(payload.subject, record.signature)) {
    throw new LocationRecordValidationError("signature is not in canonical owner-signature format");
  }
  return { ...payload, signature: record.signature };
}

export async function verifyLocationRecordV2(
  input: LocationRecordV2,
): Promise<boolean> {
  const record = validateLocationRecordV2(input);
  const payload = canonicalLocationPayloadV2(record);
  if (record.subject.startsWith("did:pkh:")) {
    const address = record.subject.slice(record.subject.lastIndexOf(":") + 1);
    try {
      return await verifyMessage({
        address: address as `0x${string}`,
        message: payload,
        signature: record.signature as `0x${string}`,
      });
    } catch {
      return false;
    }
  }

  try {
    return ed25519.verify(
      decodeBase64Url(record.signature),
      new TextEncoder().encode(payload),
      canonicalV2DidKey(record.subject),
      { zip215: false },
    );
  } catch {
    return false;
  }
}

export async function signLocationRecordV2(
  payload: LocationRecordV2Payload,
  signer: LocationRecordSigner,
): Promise<LocationRecordV2> {
  const validated = validateLocationRecordV2Payload(payload);
  const message = canonicalLocationPayloadV2(validated);
  const isPkh = validated.subject.startsWith("did:pkh:");
  if ((signer.type === "did:pkh") !== isPkh) {
    throw new LocationRecordValidationError("signer type does not match owner subject");
  }
  const signature = signer.type === "did:pkh"
    ? await signer.signMessage(message)
    : base64UrlEncode(await signer.signBytes(new TextEncoder().encode(message)));
  const record = validateLocationRecordV2({ ...validated, signature });
  if (!(await verifyLocationRecordV2(record))) {
    throw new LocationRecordValidationError("signature does not verify for owner subject");
  }
  return record;
}

function exactV2Object(
  input: unknown,
  expected: readonly string[],
  label: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new LocationRecordValidationError(`${label} must be an object`);
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) {
    throw new LocationRecordValidationError(`${label} has missing or unknown fields`);
  }
  return input as Record<string, unknown>;
}

function validateV2OwnerSubject(subject: unknown): asserts subject is string {
  if (typeof subject !== "string" || !isAsciiNonEmpty(subject)) {
    throw new LocationRecordValidationError("subject must be a canonical owner DID");
  }
  const pkh = /^did:pkh:eip155:([1-9][0-9]*):(0x[a-fA-F0-9]{40})$/.exec(subject);
  if (pkh !== null) {
    const chainId = Number(pkh[1]);
    try {
      if (Number.isSafeInteger(chainId) && chainId > 0 && pkhDid(pkh[2], chainId) === subject) return;
    } catch {
      // Report one stable validation error below.
    }
    throw new LocationRecordValidationError("subject must use a positive safe chain ID and EIP-55 address");
  }
  validateV2DidKey(subject, "subject");
}

function validateV2DidKey(value: string, label: string): void {
  try {
    canonicalV2DidKey(value);
  } catch {
    throw new LocationRecordValidationError(`${label} must be a canonical Ed25519 did:key`);
  }
}

function canonicalV2DidKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) {
    throw new LocationRecordValidationError("DID must be an Ed25519 did:key");
  }
  const identifier = did.slice("did:key:".length);
  const bytes = bases.base58btc.decode(identifier);
  if (
    bytes.length !== 34 ||
    bytes[0] !== 0xed ||
    bytes[1] !== 0x01 ||
    bases.base58btc.encode(bytes) !== identifier
  ) {
    throw new LocationRecordValidationError("DID must use the canonical Ed25519 multicodec");
  }
  return bytes.slice(2);
}

function validateV2Origin(input: string): string {
  if (!isAsciiNonEmpty(input)) {
    throw new LocationRecordValidationError("node.url must be an ASCII HTTP(S) origin");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new LocationRecordValidationError("node.url must be an absolute HTTP(S) origin");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== input
  ) {
    throw new LocationRecordValidationError("node.url must be an exact origin without path, query, fragment, or credentials");
  }
  if (url.protocol === "http:" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new LocationRecordValidationError("HTTP node URLs are allowed only for IPv4 or IPv6 loopback");
  }
  return url.origin;
}

function validateV2SpaceOwner(space: string, subject: string): string {
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/.test(space)) {
    throw new LocationRecordValidationError("space must be a complete normalized TinyCloud space URI");
  }
  for (let index = space.indexOf("%"); index !== -1; index = space.indexOf("%", index + 3)) {
    const octet = space.slice(index + 1, index + 3);
    if (
      !/^[0-9A-F]{2}$/.test(octet) ||
      /^[A-Za-z0-9._~-]$/.test(String.fromCharCode(Number.parseInt(octet, 16)))
    ) {
      throw new LocationRecordValidationError("space URI percent encoding must be normalized");
    }
  }
  if (subject.startsWith("did:key:")) {
    const prefix = `tinycloud:${subject.slice("did:".length)}:`;
    if (!space.startsWith(prefix) || space.length === prefix.length || space.slice(prefix.length).includes(":")) {
      throw new LocationRecordValidationError("space owner must match the did:key subject");
    }
    return space;
  }
  const parts = /^tinycloud:pkh:eip155:([1-9][0-9]*):(0x[a-fA-F0-9]{40}):([^:]+)$/.exec(space);
  const ownerAddress = subject.slice(subject.lastIndexOf(":") + 1);
  if (
    parts === null ||
    !Number.isSafeInteger(Number(parts[1])) ||
    Number(parts[1]) <= 0 ||
    parts[2]!.toLowerCase() !== ownerAddress.toLowerCase()
  ) {
    throw new LocationRecordValidationError("space owner address must match the did:pkh subject");
  }
  return `tinycloud:pkh:eip155:${parts[1]}:${parts[2]!.toLowerCase()}:${parts[3]}`;
}

function isV2UtcTimestamp(value: string): boolean {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z$/.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return (
    year > 0 &&
    daysInMonth !== undefined &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

function isCanonicalV2Signature(subject: string, signature: string): boolean {
  if (subject.startsWith("did:pkh:")) {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
    const r = BigInt(`0x${signature.slice(2, 66)}`);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = Number.parseInt(signature.slice(130), 16);
    const curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    return r > 0n && r < curveOrder && s > 0n && s <= curveOrder / 2n && (v === 27 || v === 28);
  }
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    const bytes = decodeBase64Url(signature);
    return bytes.length === 64 && base64UrlEncode(bytes) === signature;
  } catch {
    return false;
  }
}

function isAsciiNonEmpty(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function fetchLocationRecord(
  registryUrl: string,
  subject: string,
  fetchFn: typeof fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<LocationRecord | null> {
  const url = `${registryUrl.replace(/\/$/, "")}/v1/locations/${encodeURIComponent(subject)}`;
  const response = await fetchFn(url, {
    redirect: "error",
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new LocationRegistryHttpError(`location registry returned HTTP ${response.status}`, response.status);
  }
  const text = await boundedResponseText(response, "location registry", 64 * 1024);
  let body: { record?: unknown };
  try {
    body = JSON.parse(text) as { record?: unknown };
  } catch {
    throw new LocationRecordValidationError("registry response is not JSON");
  }
  if (body.record === undefined) {
    throw new LocationRecordValidationError("registry response missing record");
  }
  return validateLocationRecord(body.record);
}

/**
 * Publish the active owner node as a subject-signed discovery record.
 *
 * Existing signed multiaddrs are preserved and the exact active origin is
 * added once. A matching live record is returned without another signature.
 * This makes registry publication idempotent for application sign-in/share
 * flows while keeping the registry a cache, never an authority.
 */
export async function publishLocationRecord(
  options: PublishLocationRecordOptions,
): Promise<LocationRecord> {
  validateSubject(options.subject);
  const registryUrl = exactHttpOrigin(options.registryUrl, "registry URL");
  const nodeOrigin = exactHttpOrigin(options.nodeOrigin, "node origin");
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const current = await fetchLocationRecord(registryUrl, options.subject, fetchFn);
  if (current !== null) {
    if (current.subject !== options.subject || !(await verifyLocationRecord(current))) {
      throw new LocationRecordValidationError("existing location record signature is invalid");
    }
    if (publishedHttpOrigins(current).includes(nodeOrigin)) {
      return current;
    }
  }

  const record = await signLocationRecord({
    version: 1,
    subject: options.subject,
    multiaddrs: [...(current?.multiaddrs ?? []), httpUrlToMultiaddr(nodeOrigin)],
    updated_at: (options.now?.() ?? new Date()).toISOString(),
    sequence: (current?.sequence ?? -1) + 1,
  }, options.signer);
  const response = await fetchFn(
    `${registryUrl}/v1/locations/${encodeURIComponent(options.subject)}`,
    {
      method: "PUT",
      redirect: "error",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(record),
    },
  );
  if (!response.ok) {
    throw new LocationRegistryHttpError(`location registry publish returned HTTP ${response.status}`, response.status);
  }
  const text = await boundedResponseText(response, "location registry", 64 * 1024);
  let body: { record?: unknown };
  try {
    body = JSON.parse(text) as { record?: unknown };
  } catch {
    throw new LocationRecordValidationError("registry publish response is not JSON");
  }
  if (body.record === undefined) {
    throw new LocationRecordValidationError("registry publish response missing record");
  }
  const published = validateLocationRecord(body.record);
  if (canonicalLocationPayload(locationPayloadForRecord(published)) !== canonicalLocationPayload(locationPayloadForRecord(record))
    || published.signature !== record.signature
    || !(await verifyLocationRecord(published))) {
    throw new LocationRecordValidationError("registry publish response does not match the signed record");
  }
  return published;
}

export async function resolveCloudLocation(
  subject: string,
  options: ResolveCloudLocationOptions = {},
): Promise<ResolvedCloudLocation> {
  validateSubject(subject);
  const verifyRecords = options.verifyRecords ?? true;
  const attempts = await Promise.all([
    resolveExplicit(subject, options.explicitMultiaddrs),
    resolveBlockchain(subject, options.blockchain, verifyRecords),
    resolveCentralized(subject, options, verifyRecords),
    resolveFallback(subject, options.fallbackMultiaddrs),
  ]);

  const winner = attempts.find((attempt) => attempt.candidate)?.candidate;
  if (!winner) {
    throw new CloudLocationResolutionError(subject, attempts);
  }

  return {
    subject,
    source: winner.source,
    multiaddrs: [...winner.multiaddrs],
    ...(winner.record ? { record: winner.record } : {}),
    attempts,
    resolvedAt: new Date().toISOString(),
  };
}

export async function resolveTinyCloudHosts(
  subject: string,
  options: ResolveTinyCloudHostsOptions = {},
): Promise<ResolvedTinyCloudHosts> {
  const hasExplicitHosts =
    options.explicitHosts !== undefined && options.explicitHosts.length > 0;

  // Shared for the lifetime of this single resolve call only (no cross-call
  // caching): local discovery's registry lookup and the centralized
  // resolution below can both request the same subject's LocationRecord from
  // the same registry URL, so memoizing here avoids firing that request twice.
  const fetchFn = memoizeFetch(options.fetch ?? globalThis.fetch);

  // Explicit config wins outright — same as before TC-106, no local probe.
  if (!hasExplicitHosts && (options.autoDiscoverLocalNode ?? true)) {
    const local = await discoverLocalTinyCloudNode({
      subject,
      autoDiscoverLocalNode: true,
      localNodeUrl: options.localNodeUrl,
      localLinkName: options.localLinkName,
      registryUrl: options.registryUrl,
      expectedNodeDid: options.expectedNodeDid,
      identityStore: options.localNodeIdentityStore,
      verifyRecords: options.verifyRecords,
      fetch: fetchFn,
    });
    if (local) {
      const multiaddrs = [httpUrlToMultiaddr(local.url)];
      const candidate: LocationCandidate = { source: local.source, multiaddrs };
      const location: ResolvedCloudLocation = {
        subject,
        source: local.source,
        multiaddrs,
        attempts: [{ source: local.source, candidate }],
        resolvedAt: new Date().toISOString(),
      };
      return { hosts: [local.url], location };
    }
  }

  const location = await resolveCloudLocation(subject, {
    explicitMultiaddrs: hostsToMultiaddrs(options.explicitHosts),
    blockchain: options.blockchain,
    centralizedRegistryUrl:
      options.registryUrl === null
        ? undefined
        : (options.registryUrl ?? DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL),
    fallbackMultiaddrs: hostsToMultiaddrs(
      options.fallbackHosts === null
        ? undefined
        : (options.fallbackHosts ?? [DEFAULT_TINYCLOUD_FALLBACK_HOST]),
    ),
    fetch: fetchFn,
    verifyRecords: options.verifyRecords,
  });

  const hosts = location.multiaddrs.map((addr) => multiaddrToHttpUrl(addr));
  // The fallback stays the default; warn once per process when it is taken.
  if (location.source === "fallback" && !fallbackDeprecationWarned) {
    fallbackDeprecationWarned = true;
    console.warn(
      `[tinycloud:location] Deprecated: no registry host for this account, using fallback ${hosts[0]}. ` +
        'The silent fallback will be removed in a future major; opt in to registryPolicy "fail-closed" now.',
    );
  }
  return { hosts, location };
}

let fallbackDeprecationWarned = false;

/**
 * Wrap a fetch implementation so identical (same-URL) requests within its
 * lifetime share one in-flight/completed response instead of firing twice.
 * Scoped to the caller — a fresh wrapper is created per {@link
 * resolveTinyCloudHosts} call, so nothing is cached across calls. Each
 * request's `Response` body is cloned on the way out so every caller gets an
 * independently readable body regardless of read order.
 */
function memoizeFetch(fetchFn: typeof fetch): typeof fetch {
  const cache = new Map<string, Promise<Response>>();
  return (async (input, init) => {
    const key = String(input);
    let cached = cache.get(key);
    if (!cached) {
      cached = fetchFn(input, init);
      cache.set(key, cached);
    }
    const response = await cached;
    return response.clone();
  }) as typeof fetch;
}

/**
 * Probe for a locally-running TinyCloud node and verify its identity before
 * trusting it. Tries, in order: the local loopback URL, the explicit
 * `localLinkName` candidate (if given), then any `*.local.tinycloud.link`
 * multiaddr found in the subject's registry LocationRecord (if `subject` and
 * a registry are given). Each candidate is probed with `GET {url}/healthz`
 * (short timeout, no retries) — any failure (refused, timeout, NXDOMAIN,
 * offline) silently skips to the next candidate, no error, no log above
 * debug level. A candidate that answers healthy is then identity-checked via
 * `GET {url}/info`: if an expected DID is known (explicit or previously
 * pinned), the node's `nodeId` DID must match or the candidate is rejected;
 * if no expectation exists yet, the DID is trusted and pinned (TOFU).
 *
 * Returns `null` (never throws) when no local node is found or verified —
 * callers fall through to their normal remote resolution.
 */
export async function discoverLocalTinyCloudNode(
  options: DiscoverLocalTinyCloudNodeOptions = {},
): Promise<DiscoveredLocalTinyCloudNode | null> {
  if ((options.autoDiscoverLocalNode ?? true) === false) {
    return null;
  }

  const fetchFn = options.fetch ?? globalThis.fetch;
  const identityStore =
    options.identityStore ?? defaultLocalNodeIdentityStore;

  // Explicit static candidates first — no network round trip beyond their
  // probes. Loopback is intentionally opt-in: silently fetching 127.0.0.1
  // from a web SDK can trigger a browser local-network permission prompt.
  // Registry-discovered *.local.tinycloud.link candidates remain enabled.
  const staticCandidates: LocalNodeCandidate[] = [];
  if (options.localNodeUrl) {
    staticCandidates.push({
      source: "local-loopback",
      url: options.localNodeUrl,
      timeoutMs: LOCAL_LOOPBACK_PROBE_TIMEOUT_MS,
    });
  }
  if (options.localLinkName) {
    if (isValidDnsLabel(options.localLinkName)) {
      staticCandidates.push({
        source: "local-link",
        url: `https://${options.localLinkName}${LOCAL_LINK_HOST_SUFFIX}`,
        timeoutMs: LOCAL_LINK_PROBE_TIMEOUT_MS,
      });
    } else {
      debugLog(
        `localLinkName "${options.localLinkName}" is not a valid DNS label; skipping`,
      );
    }
  }

  for (const candidate of staticCandidates) {
    const adopted = await probeAndVerifyLocalCandidate(
      candidate,
      fetchFn,
      identityStore,
      options.expectedNodeDid,
    );
    if (adopted) {
      return adopted;
    }
  }

  const registryCandidates = await fetchRegistryLocalLinkCandidates(
    options,
    fetchFn,
    staticCandidates,
  );
  for (const candidate of registryCandidates) {
    const adopted = await probeAndVerifyLocalCandidate(
      candidate,
      fetchFn,
      identityStore,
      options.expectedNodeDid,
    );
    if (adopted) {
      return adopted;
    }
  }

  return null;
}

const defaultLocalNodeIdentityStore = createInMemoryLocalNodeIdentityStore();

function debugLog(message: string): void {
  console.debug(`[tinycloud:location] ${message}`);
}

interface LocalNodeCandidate {
  source: Extract<LocationSource, "local-loopback" | "local-link">;
  url: string;
  timeoutMs: number;
}

async function probeAndVerifyLocalCandidate(
  candidate: LocalNodeCandidate,
  fetchFn: typeof fetch,
  identityStore: LocalNodeIdentityStore,
  expectedNodeDid: string | undefined,
): Promise<DiscoveredLocalTinyCloudNode | null> {
  const healthy = await probeHealthz(candidate.url, candidate.timeoutMs, fetchFn);
  if (!healthy) {
    return null;
  }

  const info = await fetchLocalNodeInfo(candidate.url, candidate.timeoutMs, fetchFn);
  if (!info?.nodeDid) {
    debugLog(`local node at ${candidate.url} did not report a nodeId DID; skipping`);
    return null;
  }

  const pinnedNodeDid = await identityStore.get(candidate.url);
  const expected = expectedNodeDid ?? pinnedNodeDid;
  if (expected !== undefined && expected !== info.nodeDid) {
    debugLog(
      `local node DID mismatch at ${candidate.url}: expected ${expected}, got ${info.nodeDid}`,
    );
    return null;
  }
  if (pinnedNodeDid === undefined || expectedNodeDid !== undefined) {
    // TOFU pin (no prior pin), or an explicit `expectedNodeDid` just
    // confirmed the match — refresh the stored pin so a later call that
    // omits `expectedNodeDid` doesn't fall back to a stale pinned DID.
    await identityStore.set(candidate.url, info.nodeDid);
  }

  return { source: candidate.source, url: candidate.url, nodeDid: info.nodeDid };
}

/**
 * Look up the subject's registry LocationRecord and extract any
 * `*.local.tinycloud.link` multiaddrs as additional local-link candidates.
 * Only called once the cheap static candidates have failed. Never throws —
 * registry failures here are opportunistic and fall through to the
 * unchanged remote resolution that runs when local discovery finds nothing.
 */
async function fetchRegistryLocalLinkCandidates(
  options: DiscoverLocalTinyCloudNodeOptions,
  fetchFn: typeof fetch,
  existingCandidates: LocalNodeCandidate[],
): Promise<LocalNodeCandidate[]> {
  if (!options.subject || options.registryUrl === null) {
    return [];
  }

  const registryUrl = options.registryUrl ?? DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL;
  try {
    const record = await fetchLocationRecord(registryUrl, options.subject, fetchFn);
    if (!record) {
      return [];
    }

    const shouldVerify = options.verifyRecords ?? true;
    if (shouldVerify && !(await verifyLocationRecord(record))) {
      debugLog(
        `registry record signature invalid for ${options.subject}; skipping local-link lookup`,
      );
      return [];
    }

    return extractLocalLinkUrls(record)
      .filter((url) => !existingCandidates.some((c) => c.url === url))
      .map((url) => ({
        source: "local-link" as const,
        url,
        timeoutMs: LOCAL_LINK_PROBE_TIMEOUT_MS,
      }));
  } catch {
    return [];
  }
}

/** Extract `https://*.local.tinycloud.link` URLs from a LocationRecord's multiaddrs. */
function extractLocalLinkUrls(record: LocationRecord | null): string[] {
  if (!record) {
    return [];
  }
  const urls: string[] = [];
  for (const addr of record.multiaddrs) {
    let url: string;
    try {
      url = multiaddrToHttpUrl(addr);
    } catch {
      continue;
    }
    if (isLocalLinkUrl(url)) {
      urls.push(url);
    }
  }
  return urls;
}

/** Single DNS label: lowercase alphanumeric, optional interior hyphens, 2-32 chars. */
const DNS_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/;

function isValidDnsLabel(value: string): boolean {
  return DNS_LABEL_REGEX.test(value);
}

function isLocalLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" && parsed.hostname.endsWith(LOCAL_LINK_HOST_SUFFIX)
    );
  } catch {
    return false;
  }
}

async function probeHealthz(
  url: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetchFn(`${url.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchLocalNodeInfo(
  url: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<{ nodeDid?: string } | null> {
  try {
    const response = await fetchFn(`${url.replace(/\/$/, "")}/info`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { nodeId?: string };
    return { nodeDid: body.nodeId };
  } catch {
    return null;
  }
}

export function multiaddrToHttpUrl(input: string): string {
  const uri = multiaddrToUri(multiaddr(input));
  if (!uri.startsWith("http://") && !uri.startsWith("https://")) {
    throw new LocationRecordValidationError(
      `multiaddr does not resolve to http/https: ${input}`,
    );
  }
  return uri;
}

export function exactHttpOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocationRecordValidationError(`${label} must be an absolute URL origin`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new LocationRecordValidationError(`${label} must use HTTPS (or loopback HTTP)`);
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new LocationRecordValidationError(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

function publishedHttpOrigins(record: LocationRecord): string[] {
  const origins: string[] = [];
  for (const address of record.multiaddrs) {
    try {
      origins.push(exactHttpOrigin(multiaddrToHttpUrl(address), "published node URL"));
    } catch {
      // Location records may also advertise non-HTTP transports. They are not
      // browser targets, but must not invalidate a valid HTTPS entry beside them.
    }
  }
  return origins;
}

async function boundedResponseText(
  response: Response,
  label: string,
  maxBytes: number,
): Promise<string> {
  const bytes = await boundedResponseBytes(response, maxBytes);
  if (bytes === null) {
    throw new LocationRecordValidationError(`${label} response is too large`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * The response body, or `null` when its declared or streamed length exceeds
 * `maxBytes` (or the declared length is not a number). Reading stops there.
 */
export async function boundedResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    return null;
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function boundedSignal(parent: AbortSignal | undefined, timeoutMs: number): { readonly signal: AbortSignal; dispose(): void } {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new LocationRecordValidationError("owner-node binding timeout must be positive");
  }
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("owner-node binding timed out", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

/**
 * Proves that an addressed-share target is the owner's published TinyCloud.
 *
 * The share envelope alone can only prove that its keys agree with each
 * other. This adds the external discovery anchor: the owner must have signed
 * a registry record naming the exact target origin, and that origin must
 * answer `/info` with the exact node DID attested in the share.
 */
export async function verifyOwnerNodeBinding(
  options: VerifyOwnerNodeBindingOptions,
): Promise<VerifiedOwnerNodeBinding> {
  validateSubject(options.ownerDid);
  validateSubject(options.nodeDid);
  const registryUrl = exactHttpOrigin(options.registryUrl, "registry URL");
  const nodeOrigin = exactHttpOrigin(options.nodeOrigin, "node origin");
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const lookup = boundedSignal(options.signal, options.timeoutMs ?? OWNER_NODE_BINDING_TIMEOUT_MS);
  try {
    const record = await fetchLocationRecord(registryUrl, options.ownerDid, fetchFn, lookup.signal);
    if (record === null) {
      throw new LocationRecordValidationError("owner has no published location record");
    }
    if (record.subject !== options.ownerDid || !(await verifyLocationRecord(record))) {
      throw new LocationRecordValidationError("owner location record signature is invalid");
    }
    const publishedOrigins = publishedHttpOrigins(record);
    if (!publishedOrigins.includes(nodeOrigin)) {
      throw new LocationRecordValidationError("share target is not in the owner's signed location record");
    }

    const response = await fetchFn(new URL("/info", nodeOrigin), {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: lookup.signal,
    });
    if (!response.ok) {
      const failure = new LocationRecordValidationError(`target node /info returned HTTP ${response.status}`);
      Object.assign(failure, { status: response.status });
      throw failure;
    }
    const text = await boundedResponseText(response, "target node /info", 16 * 1024);
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new LocationRecordValidationError("target node /info response is not JSON");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)
      || (body as { nodeId?: unknown }).nodeId !== options.nodeDid) {
      throw new LocationRecordValidationError("target node identity does not match the share attestation");
    }
    return Object.freeze({ record, nodeOrigin, nodeDid: options.nodeDid });
  } finally {
    lookup.dispose();
  }
}

export function httpUrlToMultiaddr(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LocationRecordValidationError("URL must use http or https");
  }
  return uriToMultiaddr(url.toString()).toString();
}

function hostsToMultiaddrs(hosts: string[] | undefined): string[] | undefined {
  if (hosts === undefined || hosts.length === 0) {
    return undefined;
  }
  return hosts.map((host) =>
    host.startsWith("/") ? host : httpUrlToMultiaddr(host),
  );
}

async function resolveExplicit(
  subject: string,
  multiaddrs: string[] | undefined,
): Promise<LocationResolutionAttempt> {
  return resolveAttempt("explicit", async () => {
    if (multiaddrs === undefined || multiaddrs.length === 0) {
      return null;
    }
    return toCandidate(subject, "explicit", multiaddrs, false);
  });
}

async function resolveBlockchain(
  subject: string,
  resolver: ResolveCloudLocationOptions["blockchain"],
  verifyRecords: boolean,
): Promise<LocationResolutionAttempt> {
  return resolveAttempt("blockchain", async () => {
    if (!resolver) {
      return null;
    }
    return toCandidate(
      subject,
      "blockchain",
      await resolver(subject),
      verifyRecords,
    );
  });
}

async function resolveCentralized(
  subject: string,
  options: ResolveCloudLocationOptions,
  verifyRecords: boolean,
): Promise<LocationResolutionAttempt> {
  return resolveAttempt("centralized", async () => {
    if (!options.centralizedRegistryUrl) {
      return null;
    }
    const record = await fetchLocationRecord(
      options.centralizedRegistryUrl,
      subject,
      options.fetch,
    );
    return toCandidate(subject, "centralized", record, verifyRecords);
  });
}

async function resolveFallback(
  subject: string,
  multiaddrs: string[] | undefined,
): Promise<LocationResolutionAttempt> {
  return resolveAttempt("fallback", async () => {
    if (multiaddrs === undefined || multiaddrs.length === 0) {
      return null;
    }
    return toCandidate(subject, "fallback", multiaddrs, false);
  });
}

async function resolveAttempt(
  source: LocationSource,
  resolve: () => Promise<LocationCandidate | null>,
): Promise<LocationResolutionAttempt> {
  try {
    const candidate = await resolve();
    return candidate ? { source, candidate } : { source };
  } catch (error) {
    return {
      source,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function toCandidate(
  subject: string,
  source: LocationSource,
  input: LocationCandidateInput | null | undefined,
  verifyRecord: boolean,
): Promise<LocationCandidate | null> {
  if (input === null || input === undefined) {
    return null;
  }

  if (Array.isArray(input)) {
    validateMultiaddrs(input);
    return { source, multiaddrs: [...input] };
  }

  const maybeRecord = input as Partial<LocationRecord>;
  if (maybeRecord.version === 1 && maybeRecord.signature !== undefined) {
    const record = validateLocationRecord(input);
    if (record.subject !== subject) {
      throw new LocationRecordValidationError(
        "location record subject does not match requested subject",
      );
    }
    if (verifyRecord && !(await verifyLocationRecord(record))) {
      throw new LocationRecordValidationError(
        "location record signature is invalid",
      );
    }
    return { source, multiaddrs: [...record.multiaddrs], record };
  }

  const candidateInput = input as { multiaddrs?: unknown; record?: unknown };
  if (!Array.isArray(candidateInput.multiaddrs)) {
    throw new LocationRecordValidationError(
      "candidate multiaddrs must be an array",
    );
  }
  validateMultiaddrs(candidateInput.multiaddrs);
  if (candidateInput.record !== undefined) {
    const record = validateLocationRecord(candidateInput.record);
    if (record.subject !== subject) {
      throw new LocationRecordValidationError(
        "location record subject does not match requested subject",
      );
    }
    if (verifyRecord && !(await verifyLocationRecord(record))) {
      throw new LocationRecordValidationError(
        "location record signature is invalid",
      );
    }
    return { source, multiaddrs: [...candidateInput.multiaddrs], record };
  }
  return { source, multiaddrs: [...candidateInput.multiaddrs] };
}

function validateSubject(subject: unknown): asserts subject is string {
  if (typeof subject !== "string" || subject.length === 0) {
    throw new LocationRecordValidationError(
      "subject must be a non-empty string",
    );
  }
  if (!subject.startsWith("did:pkh:") && !subject.startsWith("did:key:")) {
    throw new LocationRecordValidationError(
      "subject must be did:pkh or did:key",
    );
  }
}

function validateMultiaddrs(input: unknown): asserts input is string[] {
  if (!Array.isArray(input)) {
    throw new LocationRecordValidationError("multiaddrs must be an array");
  }
  for (const addr of input) {
    if (typeof addr !== "string" || addr.length === 0) {
      throw new LocationRecordValidationError(
        "multiaddr entries must be non-empty strings",
      );
    }
    try {
      multiaddr(addr);
    } catch {
      throw new LocationRecordValidationError(`invalid multiaddr: ${addr}`);
    }
  }
}

async function verifyPkhSignature(
  did: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const address = did.split(":").at(-1);
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new LocationRecordValidationError(
      "did:pkh subject must end with an EVM address",
    );
  }
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new LocationRecordValidationError("did:pkh signature must be hex");
  }

  return verifyMessage({
    address: address as `0x${string}`,
    message: payload,
    signature: signature as `0x${string}`,
  });
}

function verifyDidKeySignature(
  did: string,
  payload: string,
  signature: string,
): boolean {
  const publicKey = ed25519PublicKeyFromDidKey(did);
  const signatureBytes = decodeBase64Url(signature);
  if (signatureBytes.length !== 64) {
    throw new LocationRecordValidationError(
      "did:key signature must be a base64url Ed25519 signature",
    );
  }
  return ed25519.verify(
    signatureBytes,
    new TextEncoder().encode(payload),
    publicKey,
  );
}

export function verifyDidKeyEd25519Signature(
  did: string,
  payload: Uint8Array,
  signature: Uint8Array,
): boolean {
  const publicKey = ed25519PublicKeyFromDidKey(did);
  return ed25519.verify(signature, payload, publicKey);
}

function ed25519PublicKeyFromDidKey(did: string): Uint8Array {
  const identifier = did.slice("did:key:".length);
  if (!identifier.startsWith("z")) {
    throw new LocationRecordValidationError(
      "did:key must use base58btc multibase",
    );
  }

  const bytes = bases.base58btc.decode(identifier);
  if (bytes.length === 34 && bytes[0] === 0xed && bytes[1] === 0x01) {
    return bytes.slice(2);
  }
  if (bytes.length === 33 && bytes[0] === 0xed) {
    return bytes.slice(1);
  }
  throw new LocationRecordValidationError(
    "did:key must be an Ed25519 public key",
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triplet = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);

    output += alphabet[(triplet >> 18) & 63];
    output += alphabet[(triplet >> 12) & 63];
    if (i + 1 < bytes.length) {
      output += alphabet[(triplet >> 6) & 63];
    }
    if (i + 2 < bytes.length) {
      output += alphabet[triplet & 63];
    }
  }

  return output;
}

function decodeBase64Url(value: string): Uint8Array {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of value) {
    const index = alphabet.indexOf(char);
    if (index < 0) {
      throw new LocationRecordValidationError(
        "did:key signature must be base64url",
      );
    }

    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return Uint8Array.from(bytes);
}
