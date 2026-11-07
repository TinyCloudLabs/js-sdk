/**
 * Signed-v2 registry policy for host resolution and space creation (TC-2481).
 * Every routing decision awaits a bounded refresh. A reverified cache younger
 * than one hour can serve transport/timeouts or HTTP 502/503/504 only.
 * Only verified absence permits onboarding; an outage without saved settings refuses.
 *
 * V2 owner keys are chain-independent: EOA records use the exact EIP-55
 * address and did:key records use the exact DID. V1 probes distinguish
 * legacy-only owners, never supply routing hosts.
 */

import {
  verifyRegistryCacheEntry,
  type RegistryCacheEntry,
  type RegistryCacheStore,
} from "./registry-cache";
import { pkhDid } from "./identity";
import {
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL,
  boundedResponseBytes,
  canonicalLocationPayloadV2,
  defaultWebStorage,
  discoverLocalTinyCloudNode,
  exactHttpOrigin,
  type LocalNodeIdentityStore,
  type WebStorageLike,
} from "./location";
import {
  REGISTRY_LOOKUP_MAX_BODY_BYTES,
  RegistryLookupInputError,
  classifyRegistryLookup,
  isCanonicalSubject,
  registryOwnerKeyV2,
  type RegisteredRegistryVerdict,
  type RegistryHost,
  type RegistryLookupResponse,
  type RegistryVerdict,
  type UnavailableRegistryVerdict,
  type UnregisteredRegistryVerdict,
} from "./registry-verdict";

export type RegistryPolicy = "fail-closed";

/** Chain of the v1 registry subject when none is configured. */
export const DEFAULT_REGISTRY_OWNER_CHAIN_ID = 1;
/** Host for `unregistered` owners under `fail-closed` when none is configured. */
export const DEFAULT_NEW_USER_HOST = DEFAULT_TINYCLOUD_FALLBACK_HOST;
/** Budget for one registry lookup, covering the request and the body. */
export const DEFAULT_REGISTRY_LOOKUP_TIMEOUT_MS = 3_000;
/** Default key {@link createLocalStorageRegistrySequenceStore} stores its sequences under. */
export const DEFAULT_REGISTRY_SEQUENCE_STORAGE_KEY = "tinycloud.registrySequences.v2";
/** Strict maximum age for cached routing during an eligible registry outage. */
export const REGISTRY_CACHE_MAX_AGE_MS = 3_600_000;

export type RegistryFallbackReason = "using_default_node" | "using_cached_settings";

/** `did:pkh:eip155:` + a 16-digit safe-integer chain ID + `:` + a 42-character address. */
const MAX_SUBJECT_LENGTH = 74;

/**
 * The v1 registry subject for an owner: `did:pkh:eip155:<registryChainId>:<EIP-55 address>`.
 *
 * Built from the signer address and a configured chain, never from the
 * session chain, so switching wallet chains never changes the lookup. Registry
 * v2 will key on the EIP-55 address alone.
 */
export function registryOwnerSubjectV1(
  address: string,
  registryChainId: number = DEFAULT_REGISTRY_OWNER_CHAIN_ID,
): string {
  return pkhDid(address, registryChainId);
}

/**
 * The highest registry record sequence accepted per subject. A remembered
 * sequence marks the subject as registered: a later not-found or an older
 * record is `unavailable`, never `unregistered`.
 *
 * Ordinary accepted-record `set` calls advance the remembered sequence; a
 * failure is logged once and the accepted verdict stands. A `get` failure
 * fails the lookup closed. Authoritative cache invalidation may restate the
 * current maximum and requires that marker write to succeed before deletion.
 */
export interface RegistrySequenceStore {
  get(subject: string): number | undefined | Promise<number | undefined>;
  set(subject: string, sequence: number): void | Promise<void>;
}

/** In-memory {@link RegistrySequenceStore}. Does not persist across process restarts. */
export function createInMemoryRegistrySequenceStore(): RegistrySequenceStore {
  const sequences = new Map<string, number>();
  return {
    get: (subject) => sequences.get(subject),
    set: (subject, sequence) => {
      if ((sequences.get(subject) ?? -1) < sequence) sequences.set(subject, sequence);
    },
  };
}

/**
 * `localStorage`-backed {@link RegistrySequenceStore}, one JSON object under
 * `storageKey`. Falls back to an in-memory store when `localStorage` is
 * unavailable. Sequences are also kept in memory, so a failed write (full or
 * read-only storage) is still remembered for this page. A storage read that
 * throws, or a corrupt stored value, throws instead of being reset:
 * forgetting a sequence would let a registry not-found read as
 * `unregistered`. Persistent merges require a storage-key Web Lock; write
 * failures still retain per-page memory and the resolver's best-effort policy.
 * Remove `storageKey` to reset persisted history.
 */
export function createLocalStorageRegistrySequenceStore(
  storage?: WebStorageLike,
  storageKey: string = DEFAULT_REGISTRY_SEQUENCE_STORAGE_KEY,
): RegistrySequenceStore {
  const backing = storage ?? defaultWebStorage();
  const memory = createInMemoryRegistrySequenceStore();
  if (!backing) {
    return memory;
  }

  const read = (): Map<string, number> => {
    const sequences = new Map<string, number>();
    const raw = backing.getItem(storageKey);
    if (raw === null) return sequences;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [subject, sequence] of Object.entries(parsed)) {
        if (!isSequence(sequence)) break;
        sequences.set(subject, sequence);
      }
      if (sequences.size === Object.keys(parsed).length) return sequences;
    }
    throw new Error(`Corrupt registry sequence store "${storageKey}"`);
  };

  return {
    get: async (subject) => {
      const sequence = Math.max(read().get(subject) ?? -1, (await memory.get(subject)) ?? -1);
      return sequence < 0 ? undefined : sequence;
    },
    set: async (subject, sequence) => {
      await memory.set(subject, sequence);
      // All owners share one JSON object, so its entire merge needs one lock.
      // Cache-entry locks are separate and are never acquired from this callback.
      const navigator = globalThis.navigator as unknown as {
        locks?: { request<T>(name: string, action: () => Promise<T>): Promise<T> };
      } | undefined;
      const locks = navigator?.locks;
      if (!locks) throw new Error("Persistent registry sequence store requires Web Locks");
      await locks.request(storageKey, async () => {
        const remembered = await memory.get(subject);
        const sequences = read();
        const previous = sequences.get(subject);
        const highest = Math.max(previous ?? -1, remembered ?? -1, sequence);
        await memory.set(subject, highest);
        if (previous !== undefined && previous >= highest) return;
        sequences.set(subject, highest);
        backing.setItem(storageKey, JSON.stringify(Object.fromEntries(sequences)));
      });
    },
  };
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export interface ResolveOwnerHostsOptions {
  /** Location registry base URL. Default https://registry.tinycloud.xyz. */
  registryUrl?: string;
  /** Remembered v2 sequences keyed by EIP-55 address or exact did:key. */
  sequenceStore?: RegistrySequenceStore;
  /** Exact signed-v2 responses; verified on every read. */
  cacheStore?: RegistryCacheStore;
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Lookup budget in milliseconds. Default {@link DEFAULT_REGISTRY_LOOKUP_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** V1 format-probe chain for EOA owners. V2 lookup is chain-independent. */
  registryChainId?: number;
}

function assertRegistrySubject(subject: string): void {
  if (typeof subject !== "string" || subject.length > MAX_SUBJECT_LENGTH || !isCanonicalSubject(subject)) {
    throw new RegistryLookupInputError(
      "invalid-subject",
      "subject must be did:pkh:eip155:<chainId>:<EIP-55 address> or an Ed25519 did:key",
    );
  }
}

/**
 * Read and reverify cached signed-v2 state before starting network refresh.
 * Cold lookups probe v1 after v2 absence (or a cold registry outage) so
 * recognized legacy records cannot authorize fallback. Sequence memory and
 * signed cache entries use the chain-independent v2 owner key.
 */
export async function resolveOwnerHosts(
  subject: string,
  options: ResolveOwnerHostsOptions = {},
): Promise<RegistryVerdict> {
  assertRegistrySubject(subject);
  const ownerKey = registryOwnerKeyV2(subject);
  const store = options.sequenceStore;
  const remembered = store === undefined ? undefined : await store.get(ownerKey);
  const cache = options.cacheStore;
  const authority = cache ? cacheAuthority(cache, ownerKey) : undefined;
  const highWater = Math.max(remembered ?? -1, authority?.sequence ?? -1);
  if (cache) {
    const cached = await cache.get(ownerKey);
    if (cached !== undefined) {
      const verdict = await verifyRegistryCacheEntry(subject, ownerKey, cached, highWater < 0 ? undefined : highWater);
      authority!.sequence = Math.max(highWater, verdict.sequence);
      await rememberAcceptedSequence(store, ownerKey, remembered, verdict);
    }
    return refreshCachedOwnerRegistry(subject, options, cache, ownerKey, Math.max(highWater, authority!.sequence) < 0
      ? undefined : Math.max(highWater, authority!.sequence));
  }
  return (await fetchOwnerRegistry(subject, options, remembered)).verdict;
}

interface OwnerRegistryResult {
  verdict: RegistryVerdict;
  allowCached?: boolean;
  revision?: number;
  invalidationAttempt?: number;
}

const cacheAuthorities = new WeakMap<RegistryCacheStore, Map<string, { sequence: number; invalidated: boolean; invalidationAttempt: number }>>();
// The accepted decision's origin generation authorizes any later route-denial drop.
const verdictRevisions = new WeakMap<RegistryVerdict, number>();
function cacheAuthority(cache: RegistryCacheStore, key: string) {
  let owners = cacheAuthorities.get(cache);
  if (!owners) cacheAuthorities.set(cache, owners = new Map());
  let authority = owners.get(key);
  if (!authority) owners.set(key, authority = { sequence: -1, invalidated: false, invalidationAttempt: 0 });
  return authority;
}

const refreshes = new WeakMap<RegistryCacheStore, Map<string, Promise<OwnerRegistryResult>>>();

/** Coalesce overlapping refreshes only; every later decision starts a new lookup. */
export async function refreshOwnerRegistry(subject: string, options: ResolveOwnerHostsOptions): Promise<RegistryVerdict> {
  return resolveOwnerHosts(subject, options);
}

async function refreshCachedOwnerRegistry(
  subject: string,
  options: ResolveOwnerHostsOptions,
  cache: RegistryCacheStore,
  key: string,
  remembered: number | undefined,
): Promise<RegistryVerdict> {
  let active = refreshes.get(cache);
  if (!active) refreshes.set(cache, active = new Map());
  let next = active.get(key);
  if (!next) {
    next = (async () => {
      // Refuse corrupt storage even if the network could replace it.
      const current = await cache.get(key);
      if (current !== undefined) {
        const verified = await verifyRegistryCacheEntry(subject, key, current, remembered);
        await rememberAcceptedSequence(options.sequenceStore, key, remembered, verified);
      }
      const highWater = Math.max(remembered ?? -1, current?.sequence ?? -1);
      return fetchOwnerRegistry(subject, options, highWater < 0 ? undefined : highWater, current);
    })();
    active.set(key, next);
    void next.finally(() => active!.delete(key)).catch(() => undefined);
  }
  const { verdict, allowCached, revision, invalidationAttempt } = await next;
  if (verdict.status === "unavailable" && !allowCached) return verdict;
  // Routing authority is caller-specific, even when cache identity is shared.
  // Recheck at the end of shared I/O and retain evidence observed before joining.
  const current = await cache.get(key);
  const latest = await options.sequenceStore?.get(key);
  const authority = cacheAuthority(cache, key);
  const highWater = Math.max(remembered ?? -1, latest ?? -1, authority.sequence);
  assertRegistryRevision(subject, await cache.getRevision(key), revision!);
  assertInvalidationAttempt(subject, authority.invalidationAttempt, invalidationAttempt!);
  if (current !== undefined) {
    const verified = await verifyRegistryCacheEntry(subject, key, current, highWater < 0 ? undefined : highWater);
    authority.sequence = Math.max(highWater, verified.sequence);
    await rememberAcceptedSequence(options.sequenceStore, key, latest, verified);
    assertRegistryRevision(subject, await cache.getRevision(key), revision!);
    assertInvalidationAttempt(subject, authority.invalidationAttempt, invalidationAttempt!);
    if (verdict.status === "unavailable") {
      const age = Date.now() - current.fetchedAt;
      if (!allowCached || authority.invalidated || age < 0 || age >= REGISTRY_CACHE_MAX_AGE_MS) return verdict;
      const fallback: RegisteredRegistryVerdict = { ...verified, offline: true };
      verdictRevisions.set(fallback, revision!);
      return fallback;
    }
    verdictRevisions.set(verified, revision!);
    return verified;
  }
  if (verdict.status === "unavailable") return verdict;
  if (verdict.status === "registered") {
    // The cache may disappear after I/O; the verified result still needs this caller's bound.
    if (verdict.sequence < highWater) return {
      status: "unavailable", subject, source: "offchain", reason: "rollback",
      message: `registry refresh sequence ${verdict.sequence} is below remembered sequence ${highWater}`, hosts: [],
    };
    await rememberAcceptedSequence(options.sequenceStore, key, latest, verdict);
    assertRegistryRevision(subject, await cache.getRevision(key), revision!);
    assertInvalidationAttempt(subject, authority.invalidationAttempt, invalidationAttempt!);
    verdictRevisions.set(verdict, revision!);
    return verdict;
  }
  if (highWater >= 0) return {
    status: "unavailable", subject, source: "offchain", reason: "not-found-after-registered",
    message: "owner registration was remembered before registry absence could authorize onboarding", hosts: [],
  };
  return verdict;
}

function assertRegistryRevision(subject: string, actual: number, expected: number): void {
  if (!isSequence(actual) || actual !== expected) {
    throw new RegistryUnavailableError(subject, undefined, {
      message: "owner routing was invalidated while the registry lookup was in flight",
    });
  }
}

function assertInvalidationAttempt(subject: string, actual: number, expected: number): void {
  if (!isSequence(actual) || actual !== expected) {
    throw new RegistryUnavailableError(subject, undefined, {
      message: "owner routing invalidation was attempted while the registry lookup was in flight",
    });
  }
}

async function fetchOwnerRegistry(
  subject: string,
  options: ResolveOwnerHostsOptions,
  remembered?: number,
  cached?: RegistryCacheEntry,
): Promise<OwnerRegistryResult> {
  const ownerKey = registryOwnerKeyV2(subject);
  const store = options.sequenceStore;
  const registryUrl = options.registryUrl ?? DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL;
  const baseUrl = registryUrl.replace(/\/$/, "");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_LOOKUP_TIMEOUT_MS;
  const authority = options.cacheStore ? cacheAuthority(options.cacheStore, ownerKey) : undefined;
  const invalidationAttempt = authority?.invalidationAttempt;
  // Capture before network I/O. A positive generation is independent known-owner
  // evidence even when a sequence adapter is absent or has forgotten its marker.
  const revision = options.cacheStore ? await options.cacheStore.getRevision(ownerKey) : undefined;
  if (options.cacheStore && !isSequence(revision)) throw new RegistryUnavailableError(subject, undefined, {
    message: "invalid registry cache revision",
  });
  if (revision !== undefined && revision > 0) remembered = Math.max(remembered ?? -1, 0);
  if (authority) assertInvalidationAttempt(subject, authority.invalidationAttempt, invalidationAttempt!);

  const observation = await observeRegistry(`${baseUrl}/v2/locations/${encodeURIComponent(ownerKey)}`, fetchFn, timeoutMs);
  const v2 = await classifyObservation(subject, observation, 2, remembered ?? null);
  if (v2.status === "registered" && options.cacheStore && observation.kind === "http") {
    const candidate: RegistryCacheEntry = { ownerKey, responseBody: observation.body, fetchedAt: Date.now(), sequence: v2.sequence };
    let accepted: RegistryCacheEntry;
    let equalSequenceConflict = false;
    try {
      accepted = await options.cacheStore.update(ownerKey, async (current, currentRevision) => {
        assertRegistryRevision(subject, currentRevision, revision!);
        assertInvalidationAttempt(subject, authority!.invalidationAttempt, invalidationAttempt!);
        const highest = Math.max((await store?.get(ownerKey)) ?? -1, authority!.sequence);
        const highWater = highest < 0 ? undefined : highest;
        if (current !== undefined) {
          const previous = await verifyRegistryCacheEntry(subject, ownerKey, current, highWater);
          assertInvalidationAttempt(subject, authority!.invalidationAttempt, invalidationAttempt!);
          if (v2.sequence < previous.sequence) return current;
          if (v2.sequence === previous.sequence) {
            // Both records passed the canonical verifier; only signed meaning
            // must match, not response formatting or signature bytes.
            if (canonicalLocationPayloadV2(v2.record!) !== canonicalLocationPayloadV2(previous.record!)) {
              equalSequenceConflict = true;
              throw new RegistryUnavailableError(subject, undefined, {
                message: "equal-sequence registry response changes the accepted signed payload",
              });
            }
            return { ...current, fetchedAt: candidate.fetchedAt };
          }
        }
        await verifyRegistryCacheEntry(subject, ownerKey, candidate, highWater);
        assertInvalidationAttempt(subject, authority!.invalidationAttempt, invalidationAttempt!);
        return candidate;
      });
    } catch (error) {
      // Invalidate outside update: persistent adapters use a non-reentrant queue.
      if (equalSequenceConflict) await dropOwnerRegistryCache(subject, options.cacheStore, store, ownerKey, v2.sequence, revision!);
      throw error;
    }
    const verdict = await verifyRegistryCacheEntry(subject, ownerKey, accepted);
    assertInvalidationAttempt(subject, authority!.invalidationAttempt, invalidationAttempt!);
    authority!.sequence = Math.max(authority!.sequence, verdict.sequence);
    authority!.invalidated = false;
    await rememberAcceptedSequence(store, ownerKey, remembered, verdict);
    return { verdict, revision, invalidationAttempt };
  }
  if (options.cacheStore && (cached !== undefined || remembered !== undefined) &&
      observation.kind === "http" && observation.status >= 400 && observation.status < 500) {
    await dropOwnerRegistryCache(subject, options.cacheStore, store, ownerKey, Math.max(remembered ?? 0, cached?.sequence ?? 0), revision!);
  }
  const fresh = cached === undefined && remembered === undefined;
  const coldOffline = fresh && v2.status === "unavailable" && registryOutage(observation);
  if (v2.status !== "unregistered" && !coldOffline) {
    await rememberAcceptedSequence(store, ownerKey, remembered, v2);
    const allowCached = v2.status === "unavailable" && (
      observation.kind === "network-error" || observation.kind === "timeout" ||
      (observation.kind === "http" && [502, 503, 504].includes(observation.status))
    );
    return { verdict: v2, allowCached, revision, invalidationAttempt };
  }

  const v1Subject = legacyRegistrySubject(subject, options.registryChainId);
  const v1Observation = await observeRegistry(`${baseUrl}/v1/locations/${encodeURIComponent(v1Subject)}`, fetchFn, timeoutMs);
  const v1 = await classifyObservation(v1Subject, v1Observation, 1, null);
  if (v1.status === "registered") {
    // Legacy registration is evidence, not v2 sequence authority. Zero marks
    // known registration without preventing a future first v2 sequence of zero.
    await store?.set(ownerKey, Math.max(remembered ?? 0, 0));
    return { verdict: {
      status: "unavailable",
      subject,
      source: "offchain",
      reason: "unsupported-format",
      message: "owner has a v1 location record but no signed-v2 routing record",
      hosts: [],
    }, revision, invalidationAttempt };
  }
  const legacyOffline = fresh && v1.status === "unavailable" && registryOutage(v1Observation);
  if (v1.status === "unavailable" && !legacyOffline) return { verdict: { ...v1, subject }, revision, invalidationAttempt };
  return { verdict: { status: "unregistered", subject, source: "offchain", hosts: [], ...(coldOffline || legacyOffline ? { offline: true } : {}) }, revision, invalidationAttempt };
}

async function dropOwnerRegistryCache(
  subject: string,
  cache: RegistryCacheStore,
  store: RegistrySequenceStore | undefined,
  key: string,
  sequence: number,
  expectedRevision: number,
): Promise<void> {
  if (!isSequence(expectedRevision)) throw new RegistryUnavailableError(subject, undefined, {
    message: "registry invalidation has no accepted origin revision",
  });
  const authority = cacheAuthority(cache, key);
  authority.sequence = Math.max(authority.sequence, sequence);
  authority.invalidated = true;
  // Persisted revision may not advance when storage fails. Fence older local
  // continuations before either the marker write or cache deletion can await.
  authority.invalidationAttempt++;
  // Deletion cannot forget known registration. Unlike ordinary accepted-record
  // writes, this marker must persist before the signed cache is removed.
  try {
    if (store) await store.set(key, Math.max(authority.sequence, (await store.get(key)) ?? -1));
    await cache.delete(key, expectedRevision, sequence);
  } catch (cause) {
    throw new RegistryUnavailableError(subject, undefined, { message: "cached storage settings could not be invalidated", cause });
  }
}

let sequenceWriteWarned = false;

type RegistryObservation =
  | RegistryLookupResponse
  | { readonly kind: "oversize" }
  | { readonly kind: "invalid-utf8" };

function registryOutage(observation: RegistryObservation): boolean {
  return observation.kind === "network-error" || observation.kind === "timeout" ||
    (observation.kind === "http" && observation.status >= 500 && observation.status < 600);
}

const fallbackWarnings = new WeakMap<RegistryCacheStore, Set<string>>();

/** Report only an actual cold default-node selection, never a background lookup. */
export function warnRegistryDefaultNode(
  verdict: RegistryVerdict,
  cacheStore?: RegistryCacheStore,
  onRegistryFallback?: (reason: string, code?: RegistryFallbackReason) => void,
): void {
  if (verdict.status !== "unregistered" || !verdict.offline) return;
  warnRegistryFallback(verdict.subject, "using_default_node", cacheStore, onRegistryFallback);
}

function warnRegistryCachedSettings(verdict: RegistryVerdict, options: LookupOwnerRegistryVerdictOptions): void {
  if (verdict.status === "registered" && verdict.offline) {
    warnRegistryFallback(verdict.subject, "using_cached_settings", options.cacheStore, options.onRegistryFallback);
  }
}

function warnRegistryFallback(
  subject: string,
  code: RegistryFallbackReason,
  cacheStore?: RegistryCacheStore,
  onRegistryFallback?: (reason: string, code?: RegistryFallbackReason) => void,
): void {
  if (cacheStore) {
    const key = `${code}:${registryOwnerKeyV2(subject)}`;
    let warned = fallbackWarnings.get(cacheStore);
    if (!warned) fallbackWarnings.set(cacheStore, warned = new Set());
    if (warned.has(key)) return;
    warned.add(key);
  }
  const reason = code === "using_default_node" ? "Couldn't check your storage settings."
    : "Storage settings are unreachable; using cached settings checked less than 1 hour ago.";
  if (onRegistryFallback) onRegistryFallback(reason, code);
  else console.warn(reason);
}

async function classifyObservation(
  subject: string,
  observed: RegistryObservation,
  recordVersion: 1 | 2,
  rememberedSequence: number | null,
): Promise<RegistryVerdict> {
  if (observed.kind === "oversize" || observed.kind === "invalid-utf8") {
    const oversize = observed.kind === "oversize";
    return {
      status: "unavailable",
      subject,
      source: "offchain",
      reason: oversize ? "oversize-response" : "malformed-response",
      message: oversize
        ? "location registry response is too large"
        : "location registry response is not UTF-8",
      hosts: [],
    };
  }
  return classifyRegistryLookup(subject, observed, { rememberedSequence, recordVersion });
}

async function rememberAcceptedSequence(
  store: RegistrySequenceStore | undefined,
  ownerKey: string,
  remembered: number | undefined,
  verdict: RegistryVerdict,
): Promise<void> {
  if (
    store === undefined ||
    verdict.status !== "registered" ||
    (remembered !== undefined && verdict.sequence <= remembered)
  ) return;
  try {
    await store.set(ownerKey, verdict.sequence);
  } catch (error) {
    if (!sequenceWriteWarned) {
      sequenceWriteWarned = true;
      console.warn("[tinycloud:registry] could not remember the registry sequence:", error);
    }
  }
}


function legacyRegistrySubject(subject: string, registryChainId?: number): string {
  if (subject.startsWith("did:key:")) return subject;
  return registryOwnerSubjectV1(subject.slice(subject.lastIndexOf(":") + 1), registryChainId);
}

async function observeRegistry(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<RegistryObservation> {
  const controller = new AbortController();
  let cancelTimer = (): void => undefined;
  // Raced rather than relying on the signal alone: a shared (memoized) fetch
  // may have started the request without this signal.
  const timedOut = new Promise<RegistryObservation>((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
    cancelTimer = () => clearTimeout(timer);
  });
  try {
    return await Promise.race([readRegistry(url, fetchFn, controller.signal), timedOut]);
  } finally {
    cancelTimer();
  }
}

async function readRegistry(
  url: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<RegistryObservation> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      redirect: "error",
      // A browser-cached HTTP 200 must not renew signed-cache freshness.
      cache: "no-store",
      headers: { accept: "application/json" },
      signal,
    });
  } catch {
    return { kind: "network-error" };
  }
  if (response.status !== 200 && response.status !== 404) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "http", status: response.status, body: "" };
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await boundedResponseBytes(response, REGISTRY_LOOKUP_MAX_BODY_BYTES);
  } catch {
    return { kind: "network-error" };
  }
  if (bytes === null) return { kind: "oversize" };
  try {
    return {
      kind: "http",
      status: response.status,
      body: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  } catch {
    return { kind: "invalid-utf8" };
  }
}

/** Sign-in found no usable host for a registered owner, or none for an unregistered owner when `newUserHost` is null. */
export class NodeNotFoundError extends Error {
  readonly code = "node_not_found" as const;

  constructor(
    readonly subject: string,
    readonly verdict: RegisteredRegistryVerdict | UnregisteredRegistryVerdict,
  ) {
    super(
      verdict.status === "registered"
        ? `No usable TinyCloud host is registered for ${subject}`
        : `${subject} is not registered and newUserHost is null`,
    );
    this.name = "NodeNotFoundError";
  }
}

/**
 * The registry could not give a verdict: unreachable, timed out, an invalid
 * or rolled-back answer, no registry configured, or a lookup that threw
 * (`cause`). Never treated as "unregistered".
 */
export class RegistryUnavailableError extends Error {
  readonly code = "registry_unavailable" as const;
  readonly cause?: unknown;

  constructor(
    readonly subject: string,
    readonly verdict: UnavailableRegistryVerdict | undefined,
    detail: { message?: string; cause?: unknown } = {},
  ) {
    super(`Location registry unavailable for ${subject}: ${detail.message ?? verdict?.message}`);
    this.name = "RegistryUnavailableError";
    if (detail.cause !== undefined) this.cause = detail.cause;
  }
}

/** Space creation was refused: the owner's registry record does not list this host. */
export class NodeRegistryEntryExistsError extends Error {
  readonly code = "node_registry_entry_exists" as const;
  /** HTTPS or loopback origins the owner's record lists, in record order. */
  readonly registeredHosts: string[];

  constructor(
    readonly subject: string,
    readonly host: string,
    readonly verdict: RegisteredRegistryVerdict,
  ) {
    super(`The registry entry for ${subject} does not list ${host}`);
    this.name = "NodeRegistryEntryExistsError";
    this.registeredHosts = secureRecordHosts(verdict);
  }
}

export interface LookupOwnerRegistryVerdictOptions {
  /** Location registry base URL. `null` means none, which is unavailable. */
  registryUrl?: string | null;
  sequenceStore?: RegistrySequenceStore;
  cacheStore?: RegistryCacheStore;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** V1 format-probe chain for EOA owners. V2 lookup is chain-independent. */
  registryChainId?: number;
  /** Value-free warning only after a fallback route is selected. */
  onRegistryFallback?: (reason: string, code?: RegistryFallbackReason) => void;
}

/**
 * {@link resolveOwnerHosts} for policy decisions: a lookup that throws, no
 * configured registry, or cold outage without saved settings becomes
 * {@link RegistryUnavailableError}. Other `unavailable` verdicts remain verdicts.
 */
export async function lookupOwnerRegistryVerdict(
  subject: string,
  options: LookupOwnerRegistryVerdictOptions = {},
): Promise<RegistryVerdict> {
  if (options.registryUrl === null) {
    throw new RegistryUnavailableError(subject, undefined, {
      message: "no location registry is configured",
    });
  }
  let verdict: RegistryVerdict;
  try {
    verdict = await resolveOwnerHosts(subject, {
      registryUrl: options.registryUrl,
      sequenceStore: options.sequenceStore,
      cacheStore: options.cacheStore,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      registryChainId: options.registryChainId,
    });
  } catch (error) {
    throw new RegistryUnavailableError(subject, undefined, {
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
  if (verdict.status === "unregistered" && verdict.offline) {
    // Unreachable is not verified absence: no host hint may authorize routing.
    throw Object.assign(new RegistryUnavailableError(subject, undefined, {
      message: "Couldn't reach your storage settings, and none are saved on this computer yet, so this didn't run. Try again in a few minutes.",
    }), { meta: { reason: "no-saved-settings" } });
  }
  return verdict;
}

/**
 * Resolve one resource exclusively from a verified v2 owner record. A genuine
 * no-entry verdict returns no hosts for existing onboarding; a registered
 * resource with no authorized destination throws instead of falling back.
 */
export async function resolveRegistryResource(
  subject: string,
  resource: string,
  access: "read" | "write" | "host" | "encryption",
  options: LookupOwnerRegistryVerdictOptions,
): Promise<{ verdict: RegistryVerdict; hosts: RegistryHost[] }> {
  const verdict = await lookupOwnerRegistryVerdict(subject, options);
  if (verdict.status === "unregistered") return { verdict, hosts: [] };
  if (verdict.status === "unavailable") throw new RegistryUnavailableError(subject, verdict);
  const record = verdict.record;
  if (record === undefined) {
    throw new RegistryUnavailableError(subject, undefined, {
      message: "registered owner has no verified v2 routing record",
    });
  }
  const denyRoute = async (): Promise<never> => {
    if (options.cacheStore) {
      await dropOwnerRegistryCache(subject, options.cacheStore, options.sequenceStore, registryOwnerKeyV2(subject), verdict.sequence, verdictRevisions.get(verdict)!);
    }
    throw new NodeNotFoundError(subject, verdict);
  };

  let targetDids: string[];
  if (access === "encryption") {
    if (record.encryptionNode === null) return denyRoute();
    targetDids = [record.encryptionNode];
  } else {
    const space = record.spaces.find(({ space: signedSpace }) => sameSpaceIdentifier(signedSpace, resource));
    if (space === undefined) return denyRoute();
    targetDids = space.nodes
      .filter(({ mode }) => access !== "write" || mode === "read-write")
      .map(({ did }) => did);
  }

  const nodeByDid = new Map(record.nodes.map((node) => [node.did, node.url]));
  const hosts = targetDids.map((nodeDid) => {
    const url = nodeByDid.get(nodeDid);
    if (url === undefined) {
      throw new RegistryUnavailableError(subject, undefined, {
        message: "verified membership references a missing node",
      });
    }
    return { nodeDid, urls: [url], source: "offchain" as const };
  });
  if (hosts.length === 0) return denyRoute();
  warnRegistryCachedSettings(verdict, options);
  return { verdict, hosts };
}

function sameSpaceIdentifier(signedSpace: string, requestedSpace: string): boolean {
  const signed = /^tinycloud:pkh:eip155:([1-9][0-9]*):(0x[a-fA-F0-9]{40}):([^/?#\s]+)$/.exec(signedSpace);
  const requested = /^tinycloud:pkh:eip155:([1-9][0-9]*):(0x[a-fA-F0-9]{40}):([^/?#\s]+)$/.exec(requestedSpace);
  if (signed === null || requested === null) return signedSpace === requestedSpace;
  return signed[1] === requested[1] &&
    signed[2]!.toLowerCase() === requested[2]!.toLowerCase() &&
    signed[3] === requested[3];
}

export interface NodeNotFoundContext {
  readonly error: NodeNotFoundError | RegistryUnavailableError;
  /** 1 for the first failure, incremented after each `retry`. */
  readonly attempt: number;
}

export type NodeNotFoundDecision =
  | { readonly action: "retry" }
  | { readonly action: "use-host"; readonly host: string }
  | { readonly action: "abort" };

/**
 * Decides what sign-in does when no host can be resolved under `fail-closed`.
 * A callback may retry or abort for any error; `use-host` is accepted only
 * for a genuine unregistered verdict with no configured host.
 */
export type OnNodeNotFound = (
  context: NodeNotFoundContext,
) => NodeNotFoundDecision | Promise<NodeNotFoundDecision>;

export interface FailClosedHostOptions extends LookupOwnerRegistryVerdictOptions {
  /**
   * Host for owners the registry reports as `unregistered`, and only them.
   * Default {@link DEFAULT_NEW_USER_HOST}. `null`: unregistered owners get
   * {@link NodeNotFoundError}.
   */
  newUserHost?: string | null;
  /** Without a callback, resolution throws the error. */
  onNodeNotFound?: OnNodeNotFound;
  /**
   * Probe configured local candidates only after genuine unregistration.
   * Discovery never overrides a registered or unavailable verdict.
   */
  autoDiscoverLocalNode?: boolean;
  localNodeUrl?: string;
  localLinkName?: string;
  expectedNodeDid?: string;
  localNodeIdentityStore?: LocalNodeIdentityStore;
}

export interface FailClosedHosts {
  hosts: string[];
  /** The registry verdict behind `hosts`. */
  verdict?: RegistryVerdict;
}

/**
 * Resolve the hosts for `address` under the `fail-closed` policy. A
 * registered v2 verdict routes only to its signed nodes; `unregistered`
 * routes to `newUserHost` or a configured verified local node. An unavailable
 * verdict or registered record without a usable host throws unless the
 * callback retries or aborts.
 */
export async function resolveFailClosedTinyCloudHosts(
  address: string,
  options: FailClosedHostOptions = {},
): Promise<FailClosedHosts> {
  const newUserHost =
    options.newUserHost === null
      ? null
      : exactHttpOrigin(options.newUserHost ?? DEFAULT_NEW_USER_HOST, "newUserHost");
  const subject = registryOwnerSubjectV1(address, options.registryChainId);

  const resolve = async (): Promise<FailClosedHosts> => {
    const verdict = await lookupOwnerRegistryVerdict(subject, options);
    if (verdict.status === "unregistered" && (options.autoDiscoverLocalNode ?? true)) {
      const local = await discoverLocalTinyCloudNode({
        localNodeUrl: options.localNodeUrl,
        localLinkName: options.localLinkName,
        expectedNodeDid: options.expectedNodeDid,
        identityStore: options.localNodeIdentityStore,
        fetch: options.fetch,
      });
      if (local) {
        warnRegistryDefaultNode(verdict, options.cacheStore, options.onRegistryFallback);
        return { hosts: [local.url], verdict };
      }
    }
    let hosts: string[];
    try {
      hosts = hostsForVerdict(verdict, newUserHost);
    } catch (error) {
      if (error instanceof NodeNotFoundError && error.verdict.status === "registered" && options.cacheStore) {
        await dropOwnerRegistryCache(subject, options.cacheStore, options.sequenceStore, registryOwnerKeyV2(subject), error.verdict.sequence, verdictRevisions.get(error.verdict)!);
      }
      throw error;
    }
    warnRegistryCachedSettings(verdict, options);
    warnRegistryDefaultNode(verdict, options.cacheStore, options.onRegistryFallback);
    return { hosts, verdict };
  };

  for (let attempt = 1; ; attempt++) {
    let failure: NodeNotFoundError | RegistryUnavailableError;
    try {
      return await resolve();
    } catch (error) {
      if (!(error instanceof NodeNotFoundError) && !(error instanceof RegistryUnavailableError)) {
        throw error;
      }
      failure = error;
    }
    if (!options.onNodeNotFound) throw failure;
    const decision = await options.onNodeNotFound({ error: failure, attempt });
    switch (decision?.action) {
      case "retry":
        continue;
      case "use-host":
        if (!(failure instanceof NodeNotFoundError) || failure.verdict.status !== "unregistered") {
          throw failure;
        }
        const host = exactHttpOrigin(decision.host, "onNodeNotFound host");
        warnRegistryDefaultNode(failure.verdict, options.cacheStore, options.onRegistryFallback);
        return { hosts: [host], verdict: failure.verdict };
      case "abort":
        throw failure;
      default:
        throw new TypeError("onNodeNotFound returned an unknown action");
    }
  }
}


/**
 * The record's hosts that `fail-closed` routes to and creates spaces on:
 * HTTPS or loopback HTTP origins (the rule `use-host` and `newUserHost`
 * follow), deduplicated, in record order. Plaintext hosts on other addresses
 * are never used, even though the owner signed them.
 */
function secureRecordHosts(verdict: RegisteredRegistryVerdict): string[] {
  const hosts = new Set<string>();
  for (const host of verdict.hosts) {
    for (const url of host.urls) {
      try {
        hosts.add(exactHttpOrigin(url, "registry host"));
      } catch {
        // Plaintext HTTP to a non-loopback address.
      }
    }
  }
  return [...hosts];
}

function hostsForVerdict(verdict: RegistryVerdict, newUserHost: string | null): string[] {
  switch (verdict.status) {
    case "registered": {
      const hosts = secureRecordHosts(verdict);
      if (hosts.length === 0) throw new NodeNotFoundError(verdict.subject, verdict);
      return hosts;
    }
    case "unregistered":
      if (newUserHost === null) throw new NodeNotFoundError(verdict.subject, verdict);
      return [newUserHost];
    case "unavailable":
      throw new RegistryUnavailableError(verdict.subject, verdict);
  }
}

/**
 * The replica-registration guard under `fail-closed`. Signed v2 verdicts require
 * the full `spaceId` and a listed node membership. Read-only members may register
 * a replica; ordinary writes are separately restricted to read-write members.
 *
 * @throws NodeRegistryEntryExistsError when a registered owner does not list
 * the requested space on this host (including when v2 `spaceId` is omitted).
 * @throws RegistryUnavailableError for an `unavailable` verdict.
 */
export function assertSpaceCreationAllowed(
  verdict: RegistryVerdict,
  host: string,
  spaceId?: string,
): void {
  switch (verdict.status) {
    case "unregistered":
      return;
    case "unavailable":
      throw new RegistryUnavailableError(verdict.subject, verdict);
    case "registered": {
      const origin = httpOrigin(host);
      if (origin !== undefined && verdict.record !== undefined) {
        const space = spaceId === undefined
          ? undefined
          : verdict.record.spaces.find(({ space: signedSpace }) => sameSpaceIdentifier(signedSpace, spaceId));
        const memberNodes = new Set(
          space?.nodes.map(({ did }) => did) ?? [],
        );
        const spaceHosts = verdict.record.nodes
          .filter(({ did }) => memberNodes.has(did))
          .map(({ url }) => httpOrigin(url));
        if (spaceHosts.includes(origin)) return;
      } else if (origin !== undefined && secureRecordHosts(verdict).includes(origin)) {
        return;
      }
      throw new NodeRegistryEntryExistsError(verdict.subject, host, verdict);
    }
  }
}

function httpOrigin(host: string): string | undefined {
  try {
    const url = new URL(host);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
