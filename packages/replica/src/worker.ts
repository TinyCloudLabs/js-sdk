/**
 * The replica worker (TC-19): one dedicated module worker owns the engine,
 * the network calls, IndexedDB and the browser device key. The main thread
 * is a thin RPC client.
 *
 * Boundary rules this file keeps:
 *   - it never imports `@tinycloud/web-sdk` (custom elements) or
 *     `@tinycloud/node-sdk` (node builtins);
 *   - `invoke`/`invokeAny` come from `@tinycloud/web-sdk-wasm` with the WASM
 *     inlined by the build;
 *   - the KV service is wired exactly like `node-sdk/src/DelegatedAccess.ts`:
 *     `ServiceContext({invoke, invokeAny, fetch, hosts:[host]})`,
 *     `KVService({})`, `registerService`, `setSession`;
 *   - one IndexedDB transaction per feed page (see `browser/store.ts`);
 *   - a Web Lock (`navigator.locks`) makes one tab the sync writer; the
 *     `writerEpoch` it bumps fences the store; `BroadcastChannel` relays
 *     `committed` events to sibling tabs' workers.
 */
import { sha256 } from "@noble/hashes/sha2";
import { KVService, ServiceContext } from "@tinycloud/sdk-services";
import { initialized, tinycloud, tcwSession } from "@tinycloud/web-sdk-wasm";

import { Replica } from "./engine.js";
import { ReplicaError, ReplicaErrorCode, isReplicaError } from "./errors.js";
import { assertGrantInstallable, parseUcanGrant } from "./grant.js";
import { isPrincipalDid, principalOf } from "./did.js";
import { requiresSecretsOptIn } from "./scope.js";
import { kvSyncTransport } from "./transport.js";
import type { GrantRecord, ListOpts, ReplicaConfig, ReplicaState } from "./types.js";
import {
  IndexedDbReplicaStore,
  deviceIdentity,
  replicaDatabaseName,
  type DeviceIdentity,
} from "./browser/store.js";
import { purgeReplicaStore } from "./browser/purge.js";
import type {
  GetRequest,
  GetResult,
  ListRequest,
  ListResult,
  OpenRequest,
  OpenResult,
  ReplicaReply,
  ReplicaRequest,
  StatusResult,
  SyncRequest,
  SyncResult,
} from "./browser/protocol.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** The worker global, narrowed to the two members this module uses. */
const workerScope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((message: MessageEvent) => void) | null;
};

function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

const textEncoder = new TextEncoder();

/**
 * Database-name id (spec §8 principal partitioning): host, scope, device and
 * the signed-in user's principal DID. The principal is an app-asserted label
 * — it partitions, it does not authorize.
 */
export function replicaIdOf(input: {
  host: string;
  space: string;
  prefix: string;
  deviceDid: string;
  principal: string;
}): string {
  const material = textEncoder.encode(`${input.host} ${input.space} ${input.prefix} ${input.deviceDid} ${input.principal}`);
  return base32(sha256(material)).slice(0, 26);
}

function newDeviceKey(): DeviceIdentity {
  const manager = new tcwSession.TCWSessionManager();
  const keyId = manager.createSessionKey("replica-device") ?? "replica-device";
  const jwkText = manager.jwk(keyId) ?? null;
  if (jwkText === null || jwkText === undefined) {
    throw new ReplicaError(ReplicaErrorCode.STORAGE_ERROR, "The WASM key manager returned no JWK.");
  }
  return { jwk: JSON.parse(jwkText) as object, did: manager.getDID(keyId) };
}

function postReply(id: number, result: unknown, transfer: Transferable[] = []): void {
  const reply: ReplicaReply = { id, ok: true, result };
  workerScope.postMessage(reply, transfer);
}

function postError(id: number, error: unknown): void {
  const err =
    isReplicaError(error) === true
      ? {
          code: error.code,
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        }
      : { code: "ERROR", message: error instanceof Error ? error.message : String(error) };
  const reply: ReplicaReply = { id, ok: false, err };
  workerScope.postMessage(reply);
}

function postEvent(name: string, fields: Record<string, unknown> = {}): void {
  workerScope.postMessage({ event: { event: name, ...fields } });
}

type Session = {
  host: string;
  space: string;
  replicaId: string;
  device: DeviceIdentity;
  store: IndexedDbReplicaStore;
  channel: BroadcastChannel | null;
};

let session: Session | null = null;
const locks: LockManager | undefined = navigator.locks;
const holderId = `w${Math.random().toString(36).slice(2, 10)}`;

function needSession(): Session {
  if (session === null) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "No replica is open in this worker.");
  return session;
}

function lockName(replicaId: string): string {
  return `tinycloud-replica:${replicaId}`;
}

/** A KV service bound to one grant, the device key and the pinned host. */
function boundKv(grant: GrantRecord, s: Session) {
  const context = new ServiceContext({
    invoke: tinycloud.invoke,
    invokeAny: tinycloud.invokeAny,
    fetch: globalThis.fetch.bind(globalThis),
    hosts: [s.host],
  });
  const kv = new KVService({});
  kv.initialize(context);
  context.registerService("kv", kv);
  context.setSession({
    delegationHeader: { Authorization: new TextDecoder().decode(grant.bytes) },
    delegationCid: grant.cid,
    spaceId: s.space,
    verificationMethod: s.device.did,
    jwk: s.device.jwk,
  });
  return kv;
}

/**
 * Run `body` while holding the replica's writer Web Lock. `{busy:true}` when
 * another tab's worker holds it. The lock is the cross-tab mutex; the store's
 * writerEpoch is the durable fence under it.
 */
async function withWriterLock<T>(s: Session, body: () => Promise<T>): Promise<T | { busy: true }> {
  if (locks === undefined) {
    throw new ReplicaError(
      ReplicaErrorCode.RUNTIME_UNSUPPORTED,
      "This browser has no Web Locks API; the replica can read local data but cannot sync.",
    );
  }
  let outcome: T | { busy: true } = { busy: true };
  await locks.request(lockName(s.replicaId), { ifAvailable: true }, async (lock) => {
    if (lock === null) return;
    await s.store.claimWriterLock();
    outcome = await body();
  });
  return outcome;
}

async function closeSession(): Promise<void> {
  if (session !== null) {
    await session.store.close().catch(() => undefined);
    session.channel?.close();
    session = null;
  }
}


/** Latest commit serial → the sibling-worker BroadcastChannel. */
function broadcastCommitted(s: Session): void {
  void s.store
    .commitSerial()
    .then((serial) => s.channel?.postMessage({ type: "committed", serial }))
    .catch(() => undefined);
}

async function handleOpen(request: OpenRequest): Promise<OpenResult> {
  await closeSession();
  if (typeof request.principal !== "string" || !isPrincipalDid(request.principal)) {
    throw new ReplicaError(
      ReplicaErrorCode.INVALID_ARGUMENT,
      `open() requires \`principal\`, the signed-in user's identity DID (got ${JSON.stringify(request.principal)}).`,
    );
  }
  if (requiresSecretsOptIn(request.space, request.prefix) && request.allowSecrets !== true) {
    throw new ReplicaError(
      ReplicaErrorCode.SECRETS_OPT_IN_REQUIRED,
      `Replicating ${request.space}/kv/${request.prefix} copies secret material to this browser; pass allowSecrets to opt in.`,
    );
  }
  const host = request.host.replace(/\/+$/, "");
  const device = await deviceIdentity(newDeviceKey);
  const replicaId = replicaIdOf({
    host,
    space: request.space,
    prefix: request.prefix,
    deviceDid: principalOf(device.did),
    principal: request.principal,
  });
  const store = await IndexedDbReplicaStore.open(replicaId, { holder: holderId });
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(lockName(replicaId));
  if (channel !== null) {
    channel.onmessage = (message) => {
      const data = message.data as { type?: unknown; serial?: unknown; reason?: unknown };
      if (data !== null && typeof data === "object" && data.type === "committed" && typeof data.serial === "number") {
        postEvent("committed", { serial: data.serial });
      } else if (data !== null && typeof data === "object" && data.type === "reset") {
        // A sibling reset or purged this replica. Our store surfaces
        // RESET_REQUIRED (purge) or fresh state on the next call; the client
        // hears the reason now and can reopen.
        postEvent("reset", { reason: typeof data.reason === "string" ? data.reason : "sibling" });
      }
    };
  }
  // Any failure after this point must release the IDB connection and the
  // channel or they leak (and a purge later reports BUSY from a dead open).
  let created = false;
  try {
    const existed = (await store.open()) !== null;
    created = !existed;
    if (!existed) {
      const config: ReplicaConfig = {
        name: request.name ?? (request.prefix.replace(/\/+$/, "") || "replica"),
        replicaId,
        host,
        space: request.space,
        prefix: request.prefix,
        deviceDid: device.did,
        allowSecrets: request.allowSecrets === true,
        localReadPolicy: "whileGrantValid",
        retentionGrantCid: null,
      };
      await store.init(config);
    } else {
      const config = (await store.open())!.config;
      if (config.host !== host || config.space !== request.space || config.prefix !== request.prefix) {
        throw new ReplicaError(
          ReplicaErrorCode.CONFIG_MISMATCH,
          `This replica follows ${config.host} ${config.space}/kv/${config.prefix}, not ${host} ${request.space}/kv/${request.prefix}.`,
        );
      }
      if (principalOf(config.deviceDid) !== principalOf(device.did)) {
        throw new ReplicaError(ReplicaErrorCode.CONFIG_MISMATCH, "The stored replica belongs to a different device key; reset it to rekey.");
      }
    }
    await store.finishPurgeIfPending();
    session = { host, space: request.space, replicaId, device, store, channel };
  } catch (error) {
    channel?.close();
    await store.close().catch(() => undefined);
    throw error;
  }
  const state = await store.open();

  return {
    replicaId,
    deviceDid: principalOf(device.did),
    verificationMethod: device.did,
    status: state === null ? null : await store.status(),
    created,
  };
}

async function handleInstallGrant(delegation: string): Promise<{ cid: string; audience: string; expiresAt: number | null }> {
  const s = needSession();
  const grant = parseUcanGrant(delegation);
  const state = await s.store.open();
  if (state === null) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "The replica has not been created.");
  // Only what assertGrantInstallable checks: the grant is addressed to this
  // device, covers this replica's scope and is inside its validity window.
  // The issuer is not checked — `principal` partitions the database, it does
  // not authorize: the node does that at sync time, and a session-key
  // rotation installs through pending-grant promotion.
  assertGrantInstallable(grant, {
    deviceDid: principalOf(state.config.deviceDid),
    space: state.config.space,
    prefix: state.config.prefix,
    now: Date.now(),
  });
  await s.store.installGrant(grant);
  return { cid: grant.cid, audience: grant.audience, expiresAt: grant.expiresAt };
}

async function handleSync(request: SyncRequest): Promise<SyncResult> {
  const s = needSession();
  const state = await s.store.open();
  if (state === null) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "The replica has not been created.");
  const engine = new Replica({
    store: s.store,
    transportFor: (grant) => kvSyncTransport(boundKv(grant, s)),
    // Siblings hear every committed page and repair batch, not only whole
    // syncs: a sync that fails on page 2 still reports page 1.
    onCommit: () => broadcastCommitted(s),
  });
  const outcome = await withWriterLock(s, () => engine.sync(request.limit === undefined ? {} : { limit: request.limit }));
  if (typeof outcome === "object" && "busy" in outcome) return { status: "busy" };
  return { status: "synced", ...outcome };
}

async function handleGet(request: GetRequest): Promise<GetResult> {
  const s = needSession();
  const result = await new Replica({ store: s.store }).get(request.key);
  if (result.status === "content_missing") {
    return { status: "content_missing", key: result.key, etag: result.etag, metadata: result.metadata };
  }
  if (result.status !== "present") return { status: result.status, key: result.key };
  return { status: "present", key: result.key, value: result.value.slice().buffer, etag: result.etag, metadata: result.metadata };
}

async function handleList(request: ListRequest): Promise<ListResult> {
  const s = needSession();
  const options: ListOpts = {};
  if (request.prefix !== undefined) options.prefix = request.prefix;
  if (request.after !== undefined) options.after = request.after;
  if (request.limit !== undefined) options.limit = request.limit;
  const { entries } = await new Replica({ store: s.store }).list(options);
  return { entries };
}

async function handleStatus(): Promise<StatusResult> {
  const s = needSession();
  const persisted =
    typeof navigator.storage?.persisted === "function" ? await navigator.storage.persisted().catch(() => null) : null;
  return {
    status: await s.store.status(),
    persistence: { persisted, locksSupported: locks !== undefined },
  };
}

async function handleReset(purge: boolean): Promise<{ reset: true; purged: boolean }> {
  const s = needSession();
  if (purge) {
    // Lock first, then the durable lease: taking the lease before the lock
    // leaked it when the Web Lock was busy. `destroy` wipes the database in
    // place — one commit clears the data, releases the lease and stamps the
    // durable `purged` marker, so the result is fixed the moment it lands.
    const tell = () => {
      try {
        s.channel?.postMessage({ type: "reset", reason: "purge" });
      } catch {
        // A closing channel must never reject the finished purge.
      }
      // BroadcastChannel does not echo: the purging tab's own client only
      // sees the reset via postEvent. Each side fires exactly once — here.
      try {
        postEvent("reset", { reason: "purge" });
      } catch {
        // A torn-down worker must never reject the finished purge.
      }
    };
    await purgeReplicaStore(s.store, {
      locks,
      replicaId: s.replicaId,
      // The wipe is committed: tell siblings and our own client now — the
      // generation fence does the rest, no connection has to close.
      onPurged: tell,
    });
    s.channel?.close();
    // Keep the session: the store's generation fence now throws
    // RESET_REQUIRED on every later call — the purging client must see that
    // (never NOT_FOUND) until it reopens, which swaps the session out.
    return { reset: true, purged: true };
  }
  const run = async () => {
    await new Replica({ store: s.store }).reset("manual");
    return true;
  };
  if (locks === undefined) {
    await run();
  } else {
    const outcome = await withWriterLock(s, run);
    if (outcome !== true) throw new ReplicaError(ReplicaErrorCode.BUSY, "Another tab is syncing this replica.");
  }
  s.channel?.postMessage({ type: "reset", reason: "manual" });
  postEvent("reset", { reason: "manual" });
  return { reset: true, purged: false };
}

async function handleSetRetention(grantCid: string | null): Promise<{ retentionGrantCid: string | null }> {
  const s = needSession();
  await s.store.setRetentionGrant(grantCid);
  return { retentionGrantCid: grantCid };
}

async function dispatch(request: ReplicaRequest): Promise<unknown> {
  switch (request.op) {
    case "open":
      return handleOpen(request);
    case "installGrant":
      return handleInstallGrant(request.delegation);
    case "sync":
      return handleSync(request);
    case "get":
      return handleGet(request);
    case "list":
      return handleList(request);
    case "status":
      return handleStatus();
    case "reset":
      return handleReset(request.purge === true);
    case "setRetention":
      return handleSetRetention(request.grantCid);
    case "close":
      await closeSession();
      return { closed: true };
  }
}

async function main(): Promise<void> {
  await initialized;
  workerScope.onmessage = (message: MessageEvent) => {
    const request = message.data as { id?: unknown } & ReplicaRequest;
    const id = typeof request.id === "number" ? request.id : 0;
    dispatch(request).then(
      (result) => {
        const transfer: Transferable[] =
          typeof result === "object" && result !== null && "value" in result && result.value instanceof ArrayBuffer
            ? [result.value]
            : [];
        postReply(id, result, transfer);
      },
      (error) => postError(id, error),
    );
  };
  postEvent("ready");
}

export { replicaDatabaseName };
void main();
