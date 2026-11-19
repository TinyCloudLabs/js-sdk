import { verifyResourceDestination } from "@tinycloud/sdk-services";
import { boundedResponseBytes } from "./location";
import {
  canonicalLocationPayloadV2,
  exactHttpOrigin,
  LocationRecordValidationError,
  LocationRegistryHttpError,
  OWNER_NODE_BINDING_TIMEOUT_MS,
  signLocationRecordV2,
  validateLocationRecordV2,
  validateLocationRecordV2Payload,
  verifyLocationRecordV2,
  type LocationRecordSigner,
  type LocationRecordV2,
  type LocationRecordV2Payload,
  verifyRegistryCacheEntry,
  registryOwnerKeyV2,
  type RegistryCacheStore,
  type RegistrySequenceStore,
} from "./registry-publication-helpers";

export { boundedResponseBytes };

type PublicationFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export interface PublishLocationRecordV2Options {
  registryUrl: string;
  subject: string;
  signer: LocationRecordSigner;
  /** Only these memberships are added or changed; all unrelated memberships survive. */
  memberships: readonly {
    space: string;
    node: { did: string; url: string };
    mode: "read-write" | "read-only";
  }[];
  /** Omitted: preserve the existing service. Null: explicitly select no service. */
  encryptionNode?: { did: string; url: string } | null;
  /** Supply the owning client's sequence/cache stores when it has registration history. */
  sequenceStore?: Pick<RegistrySequenceStore, "get" | "getRegistration">;
  cacheStore?: RegistryCacheStore;
  /** The complete public result, before signing or writing. False cancels publication. */
  onPrepared?: (payload: Readonly<LocationRecordV2Payload>, current: Readonly<LocationRecordV2> | null) => boolean | Promise<boolean>;
  fetch?: PublicationFetch;
  signal?: AbortSignal;
  now?: () => Date;
}

/**
 * Explicitly publish owner-signed v2 placement. Never called automatically by sign-in.
 * Records are publicly readable, including owner, server identities and space names.
 * The caller owns approval UX; onPrepared can review the complete merged record.
 * No cached/legacy record authorizes a write, and conflicts are never retried.
 * Returns the server-verified record; local persistence is a separate caller action.
 */
export async function publishLocationRecordV2(options: PublishLocationRecordV2Options): Promise<LocationRecordV2> {
  const subject = options.subject;
  const registryUrl = exactHttpOrigin(options.registryUrl, "registry URL");
  const selected = options.memberships.map(({ space, node, mode }) => ({ space, node: { ...node }, mode }));
  if (selected.length === 0) throw new LocationRecordValidationError("publication requires an explicitly selected space");
  const encryption = options.encryptionNode === undefined ? undefined
    : options.encryptionNode === null ? null : { ...options.encryptionNode };
  const signer = options.signer;
  const parentSignal = options.signal;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => new Date());
  const selectedNodes = new Map<string, { did: string; url: string }>();
  const selectNode = (node: { did: string; url: string }) => {
    const url = exactHttpOrigin(node.url, "storage server URL");
    if (url !== node.url) throw new LocationRecordValidationError("storage server URL must be canonical");
    const previous = selectedNodes.get(node.did);
    if (previous && previous.url !== url) throw new LocationRecordValidationError("one server identity names conflicting origins");
    selectedNodes.set(node.did, { did: node.did, url });
  };
  for (const { node } of selected) selectNode(node);
  if (encryption) selectNode(encryption);
  const intent = validateLocationRecordV2Payload({
    version: 2, subject, nodes: [...selectedNodes.values()],
    spaces: selected.map(({ space, node, mode }) => ({ space, nodes: [{ did: node.did, mode }] })),
    encryptionNode: encryption?.did ?? null, updated_at: now().toISOString(), sequence: 0,
  });
  const key = registryOwnerKeyV2(subject);
  const endpoint = `${registryUrl}/v2/locations/${encodeURIComponent(key)}`;
  const sequenceStore = options.sequenceStore;
  const cache = options.cacheStore;
  const revision = cache ? await cache.getRevision(key) : undefined;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) {
    throw new LocationRecordValidationError("invalid registration revision");
  }
  const readRememberedV2Sequence = async (): Promise<number | undefined> => {
    const sequence = await sequenceStore?.get(key);
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0)) {
      throw new LocationRecordValidationError("invalid remembered registration sequence");
    }
    const registration = await sequenceStore?.getRegistration?.(key);
    if (registration === undefined) return sequence;
    if (!Number.isSafeInteger(registration.sequence) || registration.sequence < 0 ||
        (registration.kind !== "legacy-v1" && registration.kind !== "signed-v2" && registration.kind !== "unknown") ||
        (registration.kind === "legacy-v1" && registration.sequence !== 0)) {
      throw new LocationRecordValidationError("invalid remembered registration evidence");
    }
    // Only explicit legacy-only evidence can distinguish a first v2 zero.
    if (sequence === 0 && registration.sequence === 0 && registration.kind === "legacy-v1") return undefined;
    return Math.max(sequence ?? -1, registration.sequence);
  };
  const remembered = await readRememberedV2Sequence();
  const cached = await cache?.get(key);
  const cachedRecord = cached ? (await verifyRegistryCacheEntry(subject, key, cached, remembered)).record : undefined;
  const highWater = Math.max(remembered ?? -1, cachedRecord?.sequence ?? -1);
  const request: PublicationFetch = async (input, init) => {
    parentSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(OWNER_NODE_BINDING_TIMEOUT_MS);
    const signals = [timeout, ...(parentSignal ? [parentSignal] : []), ...(init?.signal ? [init.signal] : [])];
    const response = await fetchFn(input, { ...init, signal: AbortSignal.any(signals), redirect: "error" });
    parentSignal?.throwIfAborted();
    if (response.redirected) throw new LocationRecordValidationError("publication cannot follow a redirect");
    return response;
  };
  const readJson = async (response: Response): Promise<unknown> => {
    const bytes = await boundedResponseBytes(response, 64 * 1024);
    if (bytes === null) throw new LocationRecordValidationError("registry response exceeds 64 KiB");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new LocationRecordValidationError("registry response is not valid JSON"); }
  };
  const readCurrent = async (): Promise<LocationRecordV2 | null> => {
    const response = await request(endpoint, { headers: { accept: "application/json" } });
    if (response.status !== 200 && response.status !== 404) {
      throw new LocationRegistryHttpError(`registry lookup returned HTTP ${response.status}`, response.status);
    }
    const body = await readJson(response);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new LocationRecordValidationError("registry response must be an object");
    if (response.status === 404) {
      if (Object.keys(body).length !== 1 || !("error" in body) || body.error !== "location record not found") {
        throw new LocationRecordValidationError("registry 404 is not canonical owner absence");
      }
      if (highWater >= 0 || (revision ?? 0) > 0) throw new LocationRecordValidationError("known registration is absent");
      return null;
    }
    if (!("record" in body)) throw new LocationRecordValidationError("registry response is missing its record");
    const record = validateLocationRecordV2(body.record);
    if (registryOwnerKeyV2(record.subject) !== key || !(await verifyLocationRecordV2(record))) {
      throw new LocationRecordValidationError("registry record does not verify for this owner");
    }
    if (record.sequence < highWater) throw new LocationRecordValidationError("registry sequence is older than remembered registration");
    if (cachedRecord && record.sequence === cachedRecord.sequence && canonicalLocationPayloadV2(record) !== canonicalLocationPayloadV2(cachedRecord)) {
      throw new LocationRecordValidationError("registry changed an accepted equal-sequence payload");
    }
    return record;
  };
  const current = await readCurrent();
  const nodes = new Map(current?.nodes.map((node) => [node.did, node]) ?? []);
  for (const node of intent.nodes) {
    const previous = nodes.get(node.did);
    if (previous && previous.url !== node.url) throw new LocationRecordValidationError("publication would move an existing server identity");
    nodes.set(node.did, node);
  }
  const spaces = new Map(current?.spaces.map(({ space, nodes }) => [space, { space, nodes: nodes.map((node) => ({ ...node })) }]) ?? []);
  for (const { space, nodes: memberships } of intent.spaces) {
    const previous = spaces.get(space);
    const merged = new Map(previous?.nodes.map((membership) => [membership.did, membership]) ?? []);
    for (const membership of memberships) merged.set(membership.did, membership);
    spaces.set(space, { space, nodes: [...merged.values()] });
  }
  const payload = validateLocationRecordV2Payload({
    version: 2, subject: current?.subject ?? subject, nodes: [...nodes.values()], spaces: [...spaces.values()],
    encryptionNode: encryption === undefined ? current?.encryptionNode ?? null : encryption?.did ?? null,
    updated_at: intent.updated_at, sequence: (current?.sequence ?? -1) + 1,
  });
  if (current && canonicalLocationPayloadV2({ ...payload, sequence: current.sequence, updated_at: current.updated_at }) === canonicalLocationPayloadV2(current)) return current;
  for (const node of intent.nodes) await verifyResourceDestination({ url: node.url, nodeDid: node.did }, request);
  const prepared = canonicalLocationPayloadV2(payload);
  if (options.onPrepared && await options.onPrepared(payload, current) !== true) throw new DOMException("Publication cancelled", "AbortError");
  parentSignal?.throwIfAborted();
  if (canonicalLocationPayloadV2(payload) !== prepared) throw new LocationRecordValidationError("publication payload changed after preview");
  const latest = await readCurrent();
  if ((latest === null) !== (current === null) || (latest && current && canonicalLocationPayloadV2(latest) !== canonicalLocationPayloadV2(current))) {
    throw new LocationRegistryHttpError("storage settings changed after preview", 409);
  }
  const record = await signLocationRecordV2(payload, signer);
  parentSignal?.throwIfAborted();
  if (cache && await cache.getRevision(key) !== revision) throw new LocationRegistryHttpError("registration changed before publication", 409);
  const latestRemembered = await readRememberedV2Sequence();
  if (latestRemembered !== undefined && (!Number.isSafeInteger(latestRemembered) || latestRemembered < 0 || latestRemembered > (current?.sequence ?? -1))) {
    throw new LocationRegistryHttpError("registration sequence changed before publication", 409);
  }
  const body = JSON.stringify(record);
  if (new TextEncoder().encode(JSON.stringify({ record, status: "created" })).byteLength > 64 * 1024) {
    throw new LocationRecordValidationError("published record response exceeds 64 KiB");
  }
  const response = await request(endpoint, { method: "PUT", headers: { accept: "application/json", "content-type": "application/json" }, body });
  if (response.status !== 200 && response.status !== 201) {
    throw new LocationRegistryHttpError(`registry publication returned HTTP ${response.status}`, response.status);
  }
  const reply = await readJson(response);
  if (!reply || typeof reply !== "object" || !("record" in reply)) throw new LocationRecordValidationError("registry publication response is missing its record");
  const accepted = validateLocationRecordV2(reply.record);
  if (canonicalLocationPayloadV2(accepted) !== prepared || accepted.signature !== record.signature || !(await verifyLocationRecordV2(accepted))) {
    throw new LocationRecordValidationError("registry publication response does not match the signed record");
  }
  return accepted;
}
