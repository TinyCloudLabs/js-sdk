/**
 * Signed-v2 registry policy for host resolution and space creation (TC-2481).
 * A genuine absence in both registry namespaces is the only state that may
 * use the configured new-user host; registry errors and v1-only entries fail
 * closed.
 *
 * V2 owner keys are chain-independent: EOA records use the exact EIP-55
 * address and did:key records use the exact DID. V1 is queried only after a
 * genuine v2 absence to identify legacy-only owners, never to route them.
 */

import { pkhDid } from "./identity";
import {
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL,
  boundedResponseBytes,
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
 * `set` is only called with a sequence above the remembered one. A `get`
 * failure fails that lookup closed (`RegistryUnavailableError`, never
 * "nothing remembered"). A `set` failure is logged once and the verdict in
 * hand stands: failing to remember weakens later rollback detection but
 * never turns a correct `registered` answer into a lockout.
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
 * `unregistered`. Remove `storageKey` to reset.
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
      const sequences = read();
      if ((sequences.get(subject) ?? -1) >= sequence) return;
      sequences.set(subject, sequence);
      backing.setItem(storageKey, JSON.stringify(Object.fromEntries(sequences)));
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
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Lookup budget in milliseconds. Default {@link DEFAULT_REGISTRY_LOOKUP_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** V1 format-probe chain for EOA owners. V2 lookup is chain-independent. */
  registryChainId?: number;
}

/**
 * Look up the signed-v2 owner record first. Only a genuine v2 absence probes
 * v1 to distinguish an unregistered owner from a v1-only owner; v1 records
 * never supply routing hosts. Sequence memory is keyed by the chain-independent
 * v2 owner key.
 */
export async function resolveOwnerHosts(
  subject: string,
  options: ResolveOwnerHostsOptions = {},
): Promise<RegistryVerdict> {
  if (
    typeof subject !== "string" ||
    subject.length > MAX_SUBJECT_LENGTH ||
    !isCanonicalSubject(subject)
  ) {
    throw new RegistryLookupInputError(
      "invalid-subject",
      "subject must be did:pkh:eip155:<chainId>:<EIP-55 address> or an Ed25519 did:key",
    );
  }
  const ownerKey = registryOwnerKeyV2(subject);
  const store = options.sequenceStore;
  const remembered = store === undefined ? undefined : await store.get(ownerKey);
  const registryUrl = options.registryUrl ?? DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL;
  const baseUrl = registryUrl.replace(/\/$/, "");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_LOOKUP_TIMEOUT_MS;

  const v2 = await classifyObservation(
    subject,
    await observeRegistry(`${baseUrl}/v2/locations/${encodeURIComponent(ownerKey)}`, fetchFn, timeoutMs),
    2,
    remembered ?? null,
  );
  if (v2.status !== "unregistered") {
    await rememberAcceptedSequence(store, ownerKey, remembered, v2);
    return v2;
  }

  const v1Subject = legacyRegistrySubject(subject, options.registryChainId);
  const v1 = await classifyObservation(
    v1Subject,
    await observeRegistry(`${baseUrl}/v1/locations/${encodeURIComponent(v1Subject)}`, fetchFn, timeoutMs),
    1,
    null,
  );
  if (v1.status === "registered") {
    return {
      status: "unavailable",
      subject,
      source: "offchain",
      reason: "unsupported-format",
      message: "owner has a v1 location record but no signed-v2 routing record",
      hosts: [],
    };
  }
  if (v1.status === "unavailable") return { ...v1, subject };
  return { status: "unregistered", subject, source: "offchain", hosts: [] };
}

let sequenceWriteWarned = false;

type RegistryObservation =
  | RegistryLookupResponse
  | { readonly kind: "oversize" }
  | { readonly kind: "invalid-utf8" };

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

function registryOwnerKeyV2(subject: string): string {
  return subject.startsWith("did:pkh:")
    ? subject.slice(subject.lastIndexOf(":") + 1)
    : subject;
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
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** V1 format-probe chain for EOA owners. V2 lookup is chain-independent. */
  registryChainId?: number;
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
      registryChainId: options.registryChainId,
    });
  } catch (error) {
    throw new RegistryUnavailableError(subject, undefined, {
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
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

  let targetDids: string[];
  if (access === "encryption") {
    if (record.encryptionNode === null) throw new NodeNotFoundError(subject, verdict);
    targetDids = [record.encryptionNode];
  } else {
    const space = record.spaces.find(({ space: signedSpace }) => sameSpaceIdentifier(signedSpace, resource));
    if (space === undefined) throw new NodeNotFoundError(subject, verdict);
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
  if (hosts.length === 0) throw new NodeNotFoundError(subject, verdict);
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
      if (local) return { hosts: [local.url], verdict };
    }
    return { hosts: hostsForVerdict(verdict, newUserHost), verdict };
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
        return {
          hosts: [exactHttpOrigin(decision.host, "onNodeNotFound host")],
          verdict: failure.verdict,
        };
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
