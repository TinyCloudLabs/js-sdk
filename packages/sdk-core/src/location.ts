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

export type LocationSource =
  | "explicit"
  | "blockchain"
  | "centralized"
  | "fallback";

export const DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL =
  "https://registry.tinycloud.xyz";
export const DEFAULT_TINYCLOUD_FALLBACK_HOST = "https://node.tinycloud.xyz";

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

export class CloudLocationResolutionError extends Error {
  public readonly attempts: LocationResolutionAttempt[];

  constructor(subject: string, attempts: LocationResolutionAttempt[]) {
    super(`Unable to resolve TinyCloud location for ${subject}`);
    this.name = "CloudLocationResolutionError";
    this.attempts = attempts;
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

export async function fetchLocationRecord(
  registryUrl: string,
  subject: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<LocationRecord | null> {
  const url = `${registryUrl.replace(/\/$/, "")}/v1/locations/${encodeURIComponent(subject)}`;
  const response = await fetchFn(url);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`location registry returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { record?: unknown };
  if (body.record === undefined) {
    throw new LocationRecordValidationError("registry response missing record");
  }
  return validateLocationRecord(body.record);
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
    fetch: options.fetch,
    verifyRecords: options.verifyRecords,
  });

  return {
    hosts: location.multiaddrs.map((addr) => multiaddrToHttpUrl(addr)),
    location,
  };
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

function ed25519PublicKeyFromDidKey(did: string): Uint8Array {
  const identifier = did.slice("did:key:".length);
  if (!identifier.startsWith("z")) {
    throw new LocationRecordValidationError(
      "did:key must use base58btc multibase",
    );
  }

  const bytes = bases.base58btc.decode(identifier);
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new LocationRecordValidationError(
      "did:key must be an Ed25519 public key",
    );
  }

  return bytes.slice(2);
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
