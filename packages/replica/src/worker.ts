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
import { requiresSecretsOptIn } from "./scope.js";
import { kvSyncTransport } from "./transport.js";
import type { ListOpts, ReplicaConfig, ReplicaState } from "./types.js";
import {
  IndexedDbReplicaStore,
  deleteReplicaDatabase,
  deviceIdentity,
  replicaDatabaseName,
  type DeviceIdentity,
} from "./browser/store.js";
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


/** `did:key` verification method fragment → the principal DID. */
function principalOf(did: string): string {
  return did.split("#", 1)[0]!;
}

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
 * grant subject. `grantSubject` stays empty until installGrant proves it.
 */
export function replicaIdOf(input: {
  host: string;
  space: string;
  prefix: string;
  deviceDid: string;
  grantSubject: string;
}): string {
  const material = textEncoder.encode(`${input.host} ${input.space} ${input.prefix} ${input.deviceDid} ${input.grantSubject}`);
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
  /** Declared at open; the first installed grant's issuer must match it. */
  grantSubject: string;
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

/** A KV service bound to the replica's grant, device key and pinned host. */
function boundKv(state: ReplicaState, s: Session) {
  const grant = state.pendingGrant ?? state.grant;
  if (grant === null) throw new ReplicaError(ReplicaErrorCode.GRANT_MISSING, "No grant is installed for this replica.");
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

async function handleOpen(request: OpenRequest): Promise<OpenResult> {
  await closeSession();
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
    grantSubject: request.grantSubject ?? "",
  });
  const store = await IndexedDbReplicaStore.open(replicaId, { holder: holderId });
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(lockName(replicaId));
  if (channel !== null) {
    channel.onmessage = (message) => {
      const data = message.data as { type?: unknown; serial?: unknown };
      if (data !== null && typeof data === "object" && data.type === "committed" && typeof data.serial === "number") {
        postEvent("committed", { serial: data.serial });
      }
    };
  }

  session = { host, space: request.space, replicaId, grantSubject: request.grantSubject ?? "", device, store, channel };

  const existed = (await store.open()) !== null;
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
  const state = await store.open();

  return {
    replicaId,
    deviceDid: principalOf(device.did),
    verificationMethod: device.did,
    status: state === null ? null : await store.status(),
    created: !existed,
  };
}

async function handleInstallGrant(delegation: string): Promise<{ cid: string; audience: string; expiresAt: number | null }> {
  const s = needSession();
  const grant = parseUcanGrant(delegation);
  const state = await s.store.open();
  if (state === null) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, "The replica has not been created.");
  // The grant's issuer must be the subject this replica was opened for: a
  // grant from another principal belongs to a different replicaId partition.
  if (s.grantSubject !== "" && principalOf(grant.issuer) !== s.grantSubject) {
    throw new ReplicaError(
      ReplicaErrorCode.GRANT_INVALID,
      `The grant was issued by ${grant.issuer}; this replica is partitioned for ${s.grantSubject}.`,
    );
  }
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
  const engine = new Replica({ store: s.store, transport: kvSyncTransport(boundKv(state, s)) });
  const outcome = await withWriterLock(s, () => engine.sync(request.limit === undefined ? {} : { limit: request.limit }));
  if (typeof outcome === "object" && "busy" in outcome) return { status: "busy" };
  const serial = await s.store.commitSerial();
  s.channel?.postMessage({ type: "committed", serial });
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
  return { status: await s.store.status(), persistence: { persisted, locksSupported: locks !== undefined } };
}

async function handleReset(purge: boolean): Promise<{ reset: true; purged: boolean }> {
  const s = needSession();
  if (locks === undefined) {
    if (purge) {
      await s.store.close();
      s.channel?.close();
      session = null;
      await deleteReplicaDatabase(s.replicaId);
      return { reset: true, purged: true };
    }
    await new Replica({ store: s.store }).reset("manual");
    return { reset: true, purged: false };
  }
  const outcome = await withWriterLock(s, async () => {
    if (purge) {
      await s.store.close();
      s.channel?.close();
      session = null;
      await deleteReplicaDatabase(s.replicaId);
    } else {
      await new Replica({ store: s.store }).reset("manual");
    }
    return true;
  });
  if (outcome !== true) throw new ReplicaError(ReplicaErrorCode.BUSY, "Another tab is syncing this replica.");
  if (!purge) postEvent("reset", { reason: "manual" });
  return { reset: true, purged: purge };
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
