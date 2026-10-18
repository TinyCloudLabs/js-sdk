/**
 * Registry policy for host resolution and space creation (TC-1443).
 *
 * - `legacy-fallback` (the default, deprecated): {@link resolveTinyCloudHosts}
 *   as before. A registry miss or failure silently routes to the hosted
 *   fallback node, with a one-time deprecation warning.
 * - `fail-closed` (opt-in): routing and space creation act on the three-state
 *   registry verdict. `unavailable` is never treated as `unregistered`.
 *
 * Registry lookups key on the owner's signer address, never the session
 * chain. The v1 registry stores records under an exact
 * `did:pkh:eip155:<chain>:<EIP-55 address>` subject, so v1 lookups use
 * {@link registryOwnerSubjectV1} with a configured chain (default 1). Registry
 * v2 keys owner records on the EIP-55 address alone, chain-independent.
 */

import { pkhDid } from "./identity";
import {
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL,
  boundedResponseBytes,
  defaultWebStorage,
  discoverLocalTinyCloudNode,
  exactHttpOrigin,
  memoizeFetch,
  type LocalNodeIdentityStore,
  type WebStorageLike,
} from "./location";
import {
  REGISTRY_LOOKUP_MAX_BODY_BYTES,
  RegistryLookupInputError,
  classifyRegistryLookup,
  isCanonicalSubject,
  type RegisteredRegistryVerdict,
  type RegistryLookupResponse,
  type RegistryVerdict,
  type UnavailableRegistryVerdict,
  type UnregisteredRegistryVerdict,
} from "./registry-verdict";

export type RegistryPolicy = "legacy-fallback" | "fail-closed";

/** Chain of the v1 registry subject when none is configured. */
export const DEFAULT_REGISTRY_OWNER_CHAIN_ID = 1;
/** Host for `unregistered` owners under `fail-closed` when none is configured. */
export const DEFAULT_NEW_USER_HOST = DEFAULT_TINYCLOUD_FALLBACK_HOST;
/** Budget for one registry lookup, covering the request and the body. */
export const DEFAULT_REGISTRY_LOOKUP_TIMEOUT_MS = 3_000;
/** Default key {@link createLocalStorageRegistrySequenceStore} stores its sequences under. */
export const DEFAULT_REGISTRY_SEQUENCE_STORAGE_KEY = "tinycloud.registrySequences.v1";

const DID_KEY_PREFIX = "did:key:";
/** A canonical Ed25519 `did:key` identifier is 48 base58 characters. */
const MAX_DID_KEY_IDENTIFIER_LENGTH = 48;
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
 * `set` is only called with a sequence above the remembered one. Errors from
 * either method fail the lookup closed.
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
 * unavailable. A corrupt stored value throws instead of being reset:
 * forgetting a sequence would let a registry not-found read as `unregistered`.
 */
export function createLocalStorageRegistrySequenceStore(
  storage?: WebStorageLike,
  storageKey: string = DEFAULT_REGISTRY_SEQUENCE_STORAGE_KEY,
): RegistrySequenceStore {
  const backing = storage ?? defaultWebStorage();
  if (!backing) {
    return createInMemoryRegistrySequenceStore();
  }

  const read = (): Record<string, number> => {
    const raw = backing.getItem(storageKey);
    if (raw === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Object.values(parsed).every(isSequence)
    ) {
      throw new Error(`Corrupt registry sequence store "${storageKey}"`);
    }
    return parsed as Record<string, number>;
  };

  return {
    get: (subject) => {
      const sequences = read();
      return Object.prototype.hasOwnProperty.call(sequences, subject)
        ? sequences[subject]
        : undefined;
    },
    set: (subject, sequence) => {
      const sequences = read();
      const known = Object.prototype.hasOwnProperty.call(sequences, subject)
        ? sequences[subject]!
        : -1;
      if (known >= sequence) return;
      sequences[subject] = sequence;
      backing.setItem(storageKey, JSON.stringify(sequences));
    },
  };
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export interface ResolveOwnerHostsOptions {
  /** Location registry base URL. Default https://registry.tinycloud.xyz. */
  registryUrl?: string;
  /** Remembered sequences. Omit to remember nothing. */
  sequenceStore?: RegistrySequenceStore;
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Lookup budget in milliseconds. Default {@link DEFAULT_REGISTRY_LOOKUP_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Look up `subject` in the off-chain v1 location registry and classify the
 * answer with {@link classifyRegistryLookup}, using and updating the
 * remembered sequence. Transport failures, timeouts and oversize or non-UTF-8
 * bodies are `unavailable` verdicts. Performs no host probing and never
 * applies a fallback.
 *
 * @throws RegistryLookupInputError if `subject` is not canonical or a
 * remembered sequence is invalid. The subject is length-checked before any
 * other parsing.
 */
export async function resolveOwnerHosts(
  subject: string,
  options: ResolveOwnerHostsOptions = {},
): Promise<RegistryVerdict> {
  if (
    typeof subject !== "string" ||
    subject.length > MAX_SUBJECT_LENGTH ||
    (subject.startsWith(DID_KEY_PREFIX) &&
      subject.length - DID_KEY_PREFIX.length > MAX_DID_KEY_IDENTIFIER_LENGTH) ||
    !isCanonicalSubject(subject)
  ) {
    throw new RegistryLookupInputError(
      "invalid-subject",
      "subject must be did:pkh:eip155:<chainId>:<EIP-55 address> or an Ed25519 did:key",
    );
  }
  const store = options.sequenceStore;
  // classifyRegistryLookup rejects an invalid remembered sequence.
  const remembered = store === undefined ? undefined : await store.get(subject);

  const registryUrl = options.registryUrl ?? DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL;
  const url = `${registryUrl.replace(/\/$/, "")}/v1/locations/${encodeURIComponent(subject)}`;
  const observed = await observeRegistry(
    url,
    options.fetch ?? globalThis.fetch,
    options.timeoutMs ?? DEFAULT_REGISTRY_LOOKUP_TIMEOUT_MS,
  );
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

  const verdict = await classifyRegistryLookup(subject, observed, {
    rememberedSequence: remembered ?? null,
  });
  if (
    store !== undefined &&
    verdict.status === "registered" &&
    (remembered === undefined || verdict.sequence > remembered)
  ) {
    await store.set(subject, verdict.sequence);
  }
  return verdict;
}

type RegistryObservation =
  | RegistryLookupResponse
  | { readonly kind: "oversize" }
  | { readonly kind: "invalid-utf8" };

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
      body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
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
  /** Origins the owner's record lists, in record order. */
  readonly registeredHosts: string[];

  constructor(
    readonly subject: string,
    readonly host: string,
    readonly verdict: RegisteredRegistryVerdict,
  ) {
    super(`The registry entry for ${subject} does not list ${host}`);
    this.name = "NodeRegistryEntryExistsError";
    this.registeredHosts = verdict.hosts.flatMap((host) => [...host.urls]);
  }
}

export interface LookupOwnerRegistryVerdictOptions {
  /** Location registry base URL. `null` means none, which is `RegistryUnavailableError`. */
  registryUrl?: string | null;
  sequenceStore?: RegistrySequenceStore;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * {@link resolveOwnerHosts} for policy decisions: a lookup that throws, or no
 * configured registry, becomes {@link RegistryUnavailableError}. An
 * `unavailable` verdict is returned as a verdict.
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
  try {
    return await resolveOwnerHosts(subject, {
      registryUrl: options.registryUrl,
      sequenceStore: options.sequenceStore,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw new RegistryUnavailableError(subject, undefined, {
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
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
 * Decides what sign-in does when no host can be resolved under `fail-closed`:
 * look up again, use a host for this session only (an HTTPS or loopback HTTP
 * origin; space creation there still goes through the creation guard), or
 * abort with the error.
 */
export type OnNodeNotFound = (
  context: NodeNotFoundContext,
) => NodeNotFoundDecision | Promise<NodeNotFoundDecision>;

export interface FailClosedHostOptions extends LookupOwnerRegistryVerdictOptions {
  /** Chain of the v1 registry subject. Default {@link DEFAULT_REGISTRY_OWNER_CHAIN_ID}. */
  registryChainId?: number;
  /**
   * Host for owners the registry reports as `unregistered`, and only them.
   * Default {@link DEFAULT_NEW_USER_HOST}. `null`: unregistered owners get
   * {@link NodeNotFoundError}.
   */
  newUserHost?: string | null;
  /** Without a callback, resolution throws the error. */
  onNodeNotFound?: OnNodeNotFound;
  /** Probe configured and registry-listed local nodes first, as the legacy policy does. Default true. */
  autoDiscoverLocalNode?: boolean;
  localNodeUrl?: string;
  localLinkName?: string;
  expectedNodeDid?: string;
  localNodeIdentityStore?: LocalNodeIdentityStore;
}

export interface FailClosedHosts {
  hosts: string[];
  /** The registry verdict behind `hosts`. Absent when a verified local node was used. */
  verdict?: RegistryVerdict;
}

/**
 * Resolve the hosts for `address` under the `fail-closed` policy: a verified
 * local node if one is configured or listed, else the registry verdict for
 * {@link registryOwnerSubjectV1}. `registered` routes to the record's hosts
 * (record order), `unregistered` to `newUserHost`, and `unavailable` or a
 * record without a usable host goes to `onNodeNotFound`, else throws.
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
  const rawFetch = options.fetch ?? globalThis.fetch;
  // Local discovery and the first lookup share one registry request; a retry
  // must ask the registry again.
  let fetchFn = memoizeFetch(rawFetch);

  if (options.autoDiscoverLocalNode ?? true) {
    const local = await discoverLocalTinyCloudNode({
      subject,
      localNodeUrl: options.localNodeUrl,
      localLinkName: options.localLinkName,
      registryUrl: options.registryUrl,
      expectedNodeDid: options.expectedNodeDid,
      identityStore: options.localNodeIdentityStore,
      fetch: fetchFn,
    });
    if (local) return { hosts: [local.url] };
  }

  for (let attempt = 1; ; attempt++) {
    let failure: NodeNotFoundError | RegistryUnavailableError;
    try {
      const verdict = await lookupOwnerRegistryVerdict(subject, { ...options, fetch: fetchFn });
      return { hosts: hostsForVerdict(verdict, newUserHost), verdict };
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
        fetchFn = rawFetch;
        continue;
      case "use-host":
        return {
          hosts: [exactHttpOrigin(decision.host, "onNodeNotFound host")],
          ...(failure.verdict === undefined ? {} : { verdict: failure.verdict }),
        };
      case "abort":
        throw failure;
      default:
        throw new TypeError("onNodeNotFound returned an unknown action");
    }
  }
}

function hostsForVerdict(verdict: RegistryVerdict, newUserHost: string | null): string[] {
  switch (verdict.status) {
    case "registered": {
      const hosts = [...new Set(verdict.hosts.flatMap((host) => host.urls))];
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
 * The space-creation guard under `fail-closed`: creating a space on `host` is
 * allowed for an `unregistered` owner, or for a `registered` owner whose
 * record lists `host`.
 *
 * @throws NodeRegistryEntryExistsError for a registered owner whose record
 * does not list `host` (including an empty record).
 * @throws RegistryUnavailableError for an `unavailable` verdict.
 */
export function assertSpaceCreationAllowed(verdict: RegistryVerdict, host: string): void {
  switch (verdict.status) {
    case "unregistered":
      return;
    case "unavailable":
      throw new RegistryUnavailableError(verdict.subject, verdict);
    case "registered": {
      const origin = httpOrigin(host);
      if (origin !== undefined && verdict.hosts.some((listed) => listed.urls.includes(origin))) {
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
