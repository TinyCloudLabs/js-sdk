/**
 * `sqliteReplicaStorage` (TC-858 §6.3, §10.1-10.3, §11.1) — the Node/CLI
 * `KVReplicaStorage`: SQLite replicas under a per-identity partition, a
 * durable file pending store when a `guard` serializes mutations, a per-
 * replica `syncedThroughEpoch` fence, and purge across the device union.
 *
 * `@tinycloud/replica`, `@tinycloud/replica/sqlite` and
 * `@tinycloud/node-sdk-wasm` load lazily — only inside `open`, `purge`,
 * `sync` and device-key creation — so this module never lands in the `/core`
 * entry and flag-off Node processes never evaluate replica code. The static
 * `import type` declarations below are erased at compile time and keep
 * consumers' type signatures precise without loading the modules.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open as openFile, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";


import { KVService, ServiceContext } from "@tinycloud/sdk-core";
import {
  canonicalReplicationIdentity,
  replicationIdentityKey,
  requiresSecretsOptIn,
} from "@tinycloud/sdk-services";
import type {
  KVReplicaHandle,
  KVReplicaSpec,
  KVReplicaStorage,
  LocalGetResult,
  LocalListResult,
  LocalReadMeta,
  LocalReplicaStatus,
  LocalSyncResult,
  PendingWriteState,
  PendingWriteStore,
  PurgeTarget,
  ReplicaDevice,
  ReplicaGrantInfo,
  ReplicationIdentity,
} from "@tinycloud/sdk-services";
import type {
  assertGrantInstallable,
  GrantRecord,
  isReplicaError,
  kvSyncTransport,
  parseUcanGrant,
  ReadMeta,
  Replica,
  ReplicaError,
  ReplicaErrorCode,
  ReplicaOptions,
  ReplicaTransport,
} from "@tinycloud/replica";
import type { SqliteReplicaStore } from "@tinycloud/replica/sqlite";
import { ucanAttUnconstrainedFor } from "./authority";

type MutationGuard = <T>(section: () => Promise<T>) => Promise<T>;

/** The members of `@tinycloud/replica` the adapter uses, as a value-level contract. */
interface ReplicaRuntime {
  Replica: new (options: ReplicaOptions) => Replica;
  ReplicaError: new (
    code: ReplicaErrorCode,
    message: string,
    detail?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) => ReplicaError;
  ReplicaErrorCode: {
    BUSY: ReplicaErrorCode;
    NOT_FOUND: ReplicaErrorCode;
    CLOSED: ReplicaErrorCode;
    CONFIG_MISMATCH: ReplicaErrorCode;
    SECRETS_OPT_IN_REQUIRED: ReplicaErrorCode;
    GRANT_NOT_COVERING: ReplicaErrorCode;
    RESET_REQUIRED: ReplicaErrorCode;
  };
  isReplicaError: typeof isReplicaError;
  parseUcanGrant: typeof parseUcanGrant;
  assertGrantInstallable: typeof assertGrantInstallable;
  kvSyncTransport: typeof kvSyncTransport;
}

/** The members of `@tinycloud/replica/sqlite` the adapter uses. */
interface SqliteRuntime {
  SqliteReplicaStore: {
    open(
      dir: string,
      options: {
        create: boolean;
        now?: () => number;
        guard?: MutationGuard;
      },
    ): Promise<SqliteReplicaStore>;
  };
}

/** A storage-layer failure carrying the replica error-code convention. */
class ReplicaStorageError extends Error {
  readonly code: string;
  readonly cause: unknown;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ReplicaStorageError";
    this.code = code;
    this.cause = options?.cause;
  }
}

function storageError(code: string, action: string, error: unknown): ReplicaStorageError {
  if (error instanceof ReplicaStorageError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ReplicaStorageError(code, `${action} failed: ${detail}`, { cause: error });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * Whether `path` exists. ONLY ENOENT means absent: every other `stat`
 * failure (permissions, I/O) propagates so a purge can never turn a
 * filesystem error into a successful wipe (review: pending protection).
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw storageError("STORAGE_ERROR", `Reading ${path}`, error);
  }
}

/** `did:key:…#fragment` → the bare principal DID (replica's principalOf). */
function principalOf(did: string): string {
  return did.split("#", 1)[0]!;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function sha256Base32(material: string): string {
  const digest = createHash("sha256").update(material, "utf8").digest();
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out.slice(0, 26);
}

/** `<dir>/<idHash>` — the durable partition of one canonical identity (§6.3). */
function partitionDirOf(root: string, identity: ReplicationIdentity): string {
  return join(root, sha256Base32(replicationIdentityKey(identity)));
}

/**
 * `<idHash>/replicas/<replicaHash>` — one replica per (prefix, device
 * principal). The principal strips any `#fragment` so verification-method
 * spellings of one device share the replica (the `replicaIdOf` precedent).
 */
function replicaHashOf(prefix: string, deviceDid: string): string {
  return sha256Base32(`${prefix}\n${principalOf(deviceDid)}`);
}

/** Directory-fsync boundary: durable renames for the pending store (a test seam lets a unit test observe the code path). */
export type DirSync = (dir: string) => Promise<void>;

/** Write `value` as JSON via temp+fsync+rename+dir-fsync: readers never see a partial file, and the rename survives a crash. */
async function writeJsonAtomic(
  path: string,
  value: unknown,
  dirSync: DirSync = fsyncDir,
): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(tmp, "w", 0o600);
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    await rename(tmp, path);
    // Crash durability (review): the rename is durable only once the
    // PARENT DIRECTORY is fsynced — without it a power loss can resurrect
    // the previous pending.json. Platforms that cannot fsync a directory
    // skip this rather than failing the write.
    await dirSync(dirname(path));
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // best effort
    }
    await rm(tmp, { force: true }).catch(() => undefined);
    throw storageError("STORAGE_ERROR", `Writing ${path}`, error);
  }
}

/** The errno codes of "this platform cannot fsync a directory". */
const DIR_SYNC_UNSUPPORTED: Record<string, true> = {
  ENOTSUP: true,
  ENOSYS: true,
  EINVAL: true,
  EISDIR: true,
  EPERM: true,
};

/**
 * fsync a directory so renames inside it are crash-durable. Where the
 * platform does not support directory fsync (Windows, some filesystems),
 * this is a documented no-op — the write already happened; pretending the
 * sync ran is the only option short of failing every write.
 */
async function fsyncDir(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(dir, "r");
    await handle.sync();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (typeof code === "string" && DIR_SYNC_UNSUPPORTED[code] === true) return;
    throw storageError("STORAGE_ERROR", `Syncing ${dir}`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw storageError("STORAGE_ERROR", `Reading ${path}`, error);
  }
}

/** A parsed `{v:1, host, space, principal}` identity record, or undefined for any other shape. */
function identityRecordOf(value: unknown): ReplicationIdentity | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (
    !("host" in value) ||
    !("space" in value) ||
    !("principal" in value) ||
    typeof value.host !== "string" ||
    typeof value.space !== "string" ||
    typeof value.principal !== "string"
  ) {
    return undefined;
  }
  return { host: value.host, space: value.space, principal: value.principal };
}

/** A parsed `{did, jwk}` device record, or undefined for any other shape. */
function deviceRecordOf(value: unknown): ReplicaDevice | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (
    !("did" in value) ||
    !("jwk" in value) ||
    typeof value.did !== "string" ||
    value.jwk === null ||
    typeof value.jwk !== "object"
  ) {
    return undefined;
  }
  return { did: value.did, jwk: value.jwk };
}

function sameIdentity(a: ReplicationIdentity, b: ReplicationIdentity): boolean {
  try {
    const left = canonicalReplicationIdentity(a);
    const right = canonicalReplicationIdentity(b);
    return (
      left.host === right.host &&
      left.space === right.space &&
      left.principal === right.principal
    );
  } catch {
    return false;
  }
}

/**
 * Ensure `dir` exists and `identity.json` names exactly `identity`: written
 * once (atomically) when absent, verified on every open — a file naming a
 * different identity is STORAGE_ERROR, never silently shared (§6.3). Used
 * by the pending store and by `open`, which must not depend on pending
 * state having been requested first.
 */
async function ensurePartitionIdentity(
  dir: string,
  identity: ReplicationIdentity,
  dirSync?: DirSync,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  } catch (error) {
    throw storageError("STORAGE_ERROR", `Creating ${dir}`, error);
  }
  const file = join(dir, "identity.json");
  const existing = await readJsonFile(file);
  if (existing === undefined) {
    await writeJsonAtomic(file, { v: 1, ...canonicalReplicationIdentity(identity) }, dirSync);
    return;
  }
  const record = identityRecordOf(existing);
  if (record === undefined || !sameIdentity(record, identity)) {
    throw new ReplicaStorageError(
      "STORAGE_ERROR",
      `The partition at ${dir} belongs to a different identity.`,
    );
  }
}

/**
 * The durable pending-write store of ONE identity (§6.3): `pending.json`
 * inside the identity's partition. `read` is a lock-free snapshot (writers
 * rename whole files); `update` serializes read-modify-write under the
 * guard — the profile lock for the CLI — and is durable before it resolves.
 * Open failures surface as `STORAGE_ERROR` on read/update; there is no
 * memory fallback anywhere in this store.
 */

export class FilePendingWriteStore implements PendingWriteStore {
  readonly durable = true;
  readonly identity: ReplicationIdentity;
  readonly #dir: string;
  readonly #guard: MutationGuard;
  readonly #dirSync?: DirSync;
  #ensured: Promise<void> | undefined;

  constructor(identity: ReplicationIdentity, dir: string, guard: MutationGuard, dirSync?: DirSync) {
    this.identity = identity;
    this.#dir = dir;
    this.#guard = guard;
    this.#dirSync = dirSync;
  }

  /**
   * Create the partition and write `identity.json` once; on every later use,
   * verify the recorded identity still matches this store's (§6.3: a file
   * whose identity differs is STORAGE_ERROR, never silently shared). The
   * identity file is written once, atomically, so verification needs no lock.
   */
  async #ensurePartition(): Promise<void> {
    this.#ensured ??= ensurePartitionIdentity(this.#dir, this.identity, this.#dirSync);
    return this.#ensured;
  }

  async read(): Promise<PendingWriteState> {
    await this.#ensurePartition();
    const file = join(this.#dir, "pending.json");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return { v: 2, identity: this.identity, committedEpoch: 0, seq: 0, records: [] };
      }
      throw storageError("STORAGE_ERROR", `Reading ${file}`, error);
    }
    let state: unknown;
    try {
      state = JSON.parse(text);
    } catch (error) {
      throw storageError("STORAGE_ERROR", `Parsing ${file}`, error);
    }
    if (
      state === null ||
      typeof state !== "object" ||
      !("v" in state) ||
      state.v !== 2 ||
      !("identity" in state) ||
      !("committedEpoch" in state) ||
      typeof state.committedEpoch !== "number" ||
      !("seq" in state) ||
      typeof state.seq !== "number" ||
      !("records" in state) ||
      !Array.isArray(state.records)
    ) {
      throw new ReplicaStorageError(
        "STORAGE_ERROR",
        `Pending-write state at ${file} is corrupt.`,
      );
    }
    const identity = identityRecordOf(state.identity);
    if (identity === undefined || !sameIdentity(identity, this.identity)) {
      throw new ReplicaStorageError(
        "STORAGE_ERROR",
        `Pending-write state at ${file} belongs to a different identity.`,
      );
    }
    return state as PendingWriteState;
  }

  async update<T>(mutate: (state: PendingWriteState) => T): Promise<T> {
    return this.#guard(async () => {
      const state = await this.read();
      const result = mutate(state);
      await writeJsonAtomic(join(this.#dir, "pending.json"), state, this.#dirSync);
      return result;
    });
  }
}

/**
 * The persisted device key of a partition (`device.jwk`): the audience
 * minted-grant UCANs are issued to. Read-only when the file exists —
 * `open(spec)` without `spec.device` creates it on first use.
 */
async function loadOrCreateDevice(
  idDir: string,
  guard: MutationGuard,
  createDevice: () => Promise<ReplicaDevice>,
  dirSync?: DirSync,
): Promise<ReplicaDevice> {
  return guard(async () => {
    try {
      await mkdir(idDir, { recursive: true, mode: 0o700 });
      await chmod(idDir, 0o700);
    } catch (error) {
      throw storageError("STORAGE_ERROR", `Creating ${idDir}`, error);
    }
    const file = join(idDir, "device.jwk");
    const existing = await readJsonFile(file);
    if (existing !== undefined) {
      const device = deviceRecordOf(existing);
      if (device === undefined) {
        throw new ReplicaStorageError(
          "STORAGE_ERROR",
          `The replica device key at ${file} is unreadable; remove the partition or restore it.`,
        );
      }
      return device;
    }
    const device = await createDevice();
    await writeJsonAtomic(file, { did: device.did, jwk: device.jwk }, dirSync);
    return device;
  });
}

/** A session key for the adapter's own replica device, via the WASM session manager. */
async function createDeviceKey(): Promise<ReplicaDevice> {
  const wasm = await import("@tinycloud/node-sdk-wasm");
  const manager = new wasm.TCWSessionManager();
  const keyId = manager.createSessionKey("replica-device") ?? "replica-device";
  const jwkText = manager.jwk(keyId);
  if (jwkText === null || jwkText === undefined) {
    throw new ReplicaStorageError(
      "STORAGE_ERROR",
      "The session manager returned no JWK for the replica device key.",
    );
  }
  return { did: manager.getDID(keyId), jwk: JSON.parse(jwkText) as object };
}

export interface SqliteReplicaStorageOptions {
  /** Root directory holding every identity partition (mode 0700). */
  dir: string;
  /**
   * Serializes every durable mutation — pending-store updates, sqlite
   * commits, directory creates/removes. The CLI passes the profile lock
   * (`{ timeoutMs: 35_000 }`, §3.3). Without it the pending store still
   * persists to `pending.json` on every update (never memory), but
   * read-modify-write isn't serialized across processes — single-process
   * use only.
   */
  guard?: MutationGuard;
  /**
   * Test seam: supply sync transports without WASM/KVService. Production
   * builds invoke through `kvSyncTransport` like the CLI's `grantTransports`.
   * @internal
   */
  transportFor?: (
    grant: GrantRecord,
    spec: KVReplicaSpec,
    device: ReplicaDevice,
  ) => ReplicaTransport;
  /**
   * Test seam: device-key creation without WASM.
   * @internal
   */
  createDevice?: () => Promise<ReplicaDevice>;
  /**
   * Test seam: observe/replace the parent-directory fsync that makes each
   * atomic JSON rename crash-durable. Defaults to `fsyncDir`.
   * @internal
   */
  dirSync?: DirSync;
}

const SYNC_LEASE_TTL_MS = 120_000;
const FENCE_FILE = "fence.json";

/** The persisted per-replica fence; 0 until the first successful sync. */
async function readFence(replicaDir: string): Promise<number> {
  const fence = await readJsonFile(join(replicaDir, FENCE_FILE));
  return typeof fence === "object" &&
    fence !== null &&
    "syncedThroughEpoch" in fence &&
    typeof fence.syncedThroughEpoch === "number"
    ? fence.syncedThroughEpoch
    : 0;
}

/** The newest grant on the store, or null — a pending install supersedes the active one. */
function newestGrantInfo(
  replica: ReplicaRuntime,
  record: GrantRecord | null,
  pending: GrantRecord | null,
  spec: KVReplicaSpec,
): ReplicaGrantInfo | null {
  if (record === null) return null;
  const parsed = replica.parseUcanGrant(record.bytes);
  return {
    cid: record.cid,
    parentCid: parsed.prf[0] ?? null,
    expiresAt: record.expiresAt === null ? null : record.expiresAt * 1000,
    state: pending !== null && record === pending ? "pending" : "active",
    unconstrained: ucanAttUnconstrainedFor(parsed.att, spec.space, spec.prefix),
  };
}

class SqliteReplicaHandle implements KVReplicaHandle {
  readonly spec: KVReplicaSpec;
  readonly deviceDid: string;
  readonly #device: ReplicaDevice;
  readonly #store: SqliteReplicaStore;
  readonly #replicaDir: string;
  readonly #replica: ReplicaRuntime;
  readonly #guard: MutationGuard;
  readonly #dirSync?: DirSync;
  /** The replica row generation this handle opened under — the durable fence a purge commits past (browser-parity wipe). */
  readonly #generation: number;
  /** The inode of `replica.db` at open — a directory recreated in place is a different replica. */
  readonly #ino: number | undefined;
  readonly #transportOverride: SqliteReplicaStorageOptions["transportFor"];
  #closed = false;
  readonly #inFlight = new Set<{ promise: Promise<unknown>; abort: () => void }>();
  #transportFactory: Promise<(grant: GrantRecord) => ReplicaTransport> | undefined;

  constructor(input: {
    spec: KVReplicaSpec;
    device: ReplicaDevice;
    store: SqliteReplicaStore;
    replicaDir: string;
    replica: ReplicaRuntime;
    guard: MutationGuard;
    transportFor?: SqliteReplicaStorageOptions["transportFor"];
    dirSync?: DirSync;
    generation: number;
    ino: number | undefined;
  }) {
    this.spec = input.spec;
    this.#device = input.device;
    this.deviceDid = input.device.did;
    this.#store = input.store;
    this.#replicaDir = input.replicaDir;
    this.#replica = input.replica;
    this.#guard = input.guard;
    this.#transportOverride = input.transportFor;
    this.#dirSync = input.dirSync;
    this.#generation = input.generation;
    this.#ino = input.ino;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new this.#replica.ReplicaError(
        this.#replica.ReplicaErrorCode.CLOSED,
        "The replica handle is closed.",
      );
    }
  }

  /**
   * The purge fence (review): `purge()` bumps the replica row's generation
   * before the directory is removed — the same wipe-then-tombstone contract
   * the browser store's purge commits. A handle opened before the purge is
   * fenced on its next call, in two durable ways: the live row's generation
   * no longer matches the one this handle opened under, and once the
   * directory is gone (or recreated under another inode) `stat` reports it.
   * Only ENOENT means "purged"; other `stat` errors are STORAGE_ERROR.
   */
  async #assertLive(): Promise<void> {
    this.#assertOpen();
    try {
      const stats = await stat(join(this.#replicaDir, "replica.db"));
      if (this.#ino !== undefined && stats.ino !== this.#ino) {
        throw new this.#replica.ReplicaError(
          this.#replica.ReplicaErrorCode.RESET_REQUIRED,
          "The replica was recreated; open it again to continue.",
        );
      }
    } catch (error) {
      if (isNotFound(error)) {
        throw new this.#replica.ReplicaError(
          this.#replica.ReplicaErrorCode.RESET_REQUIRED,
          "The replica was purged; open it again to continue.",
        );
      }
      throw error;
    }
    const state = await this.#store.open();
    if (state !== null && state.generation !== this.#generation) {
      throw new this.#replica.ReplicaError(
        this.#replica.ReplicaErrorCode.RESET_REQUIRED,
        "The replica was purged or reopened; open it again to continue.",
      );
    }
  }

  /**
   * Transports that each invoke with exactly one grant and this handle's
   * device key against the identity's pinned host — the CLI's
   * `grantTransports` (replica.ts), with `spec.fetch` for the graph-scoped
   * fetch. Built lazily on the first sync so read-only handles never load
   * the WASM binding.
   */
  async #transports(): Promise<(grant: GrantRecord) => ReplicaTransport> {
    if (this.#transportOverride !== undefined) {
      const override = this.#transportOverride;
      const spec = this.spec;
      const device = this.#device;
      return (grant) => override(grant, spec, device);
    }
    this.#transportFactory ??= (async () => {
      const wasm = await import("@tinycloud/node-sdk-wasm");
      const kvSyncTransport = this.#replica.kvSyncTransport;
      const spec = this.spec;
      const device = this.#device;
      const fetch = spec.fetch ?? globalThis.fetch.bind(globalThis);
      return (grant: GrantRecord): ReplicaTransport => {
        const context = new ServiceContext({
          invoke: wasm.invoke,
          invokeAny: wasm.invokeAny,
          fetch,
          hosts: [spec.identity.host],
        });
        const kv = new KVService({});
        kv.initialize(context);
        context.registerService("kv", kv);
        context.setSession({
          delegationHeader: { Authorization: new TextDecoder().decode(grant.bytes) },
          delegationCid: grant.cid,
          spaceId: spec.space,
          verificationMethod: device.did,
          jwk: device.jwk,
        });
        return kvSyncTransport(kv);
      };
    })();
    return this.#transportFactory;
  }

  async get(key: string): Promise<LocalGetResult> {
    await this.#assertLive();
    const result = await new this.#replica.Replica({ store: this.#store }).get(key);
    const meta: LocalReadMeta = {
      asOf: result.meta.asOf,
      coverage: result.meta.coverage,
      authority: result.meta.authority,
      syncedThroughEpoch: await readFence(this.#replicaDir),
    };
    switch (result.status) {
      case "present":
        return {
          status: "present",
          key: result.key,
          value: result.value,
          etag: result.etag,
          metadata: result.metadata,
          meta,
        };
      case "content_missing":
        return {
          status: "content_missing",
          key: result.key,
          etag: result.etag,
          metadata: result.metadata,
          meta,
        };
      default:
        return { status: result.status, key: result.key, meta };
    }
  }

  async list(options: { prefix: string; after?: string; limit?: number }): Promise<LocalListResult> {
    await this.#assertLive();
    const result = await new this.#replica.Replica({ store: this.#store }).list({
      prefix: options.prefix,
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    return {
      keys: result.entries.map((entry) => entry.key),
      meta: {
        asOf: result.meta.asOf,
        coverage: result.meta.coverage,
        authority: result.meta.authority,
        syncedThroughEpoch: await readFence(this.#replicaDir),
      },
    };
  }

  /**
   * The newest installed grant — the pending one when a not-yet-promoted
   * install exists — with `parentCid` = signed `prf[0]` and `unconstrained`
   * computed from the signed `att` (replica's own grantCovers ignores
   * caveats, so the adapter computes it, §2.1). A constrained installed
   * grant is still reported (unconstrained: false) and never reused.
   */
  async grant(): Promise<ReplicaGrantInfo | null> {
    await this.#assertLive();
    const state = await this.#store.open();
    if (state === null) return null;
    return newestGrantInfo(
      this.#replica,
      state.pendingGrant ?? state.grant,
      state.pendingGrant,
      this.spec,
    );
  }

  async installGrant(ucan: string): Promise<ReplicaGrantInfo> {
    await this.#assertLive();
    const parsed = this.#replica.parseUcanGrant(ucan);
    const state = await this.#store.open();
    if (state === null) {
      throw new this.#replica.ReplicaError(
        this.#replica.ReplicaErrorCode.NOT_FOUND,
        "The replica has not been created.",
      );
    }
    // Reuse-rule enforcement on every grant path (amendment §3): a caveated
    // get/sync grant can never serve this replica, so it must never be
    // installed — the caller re-mints instead of falling back to one.
    if (!ucanAttUnconstrainedFor(parsed.att, this.spec.space, this.spec.prefix)) {
      throw new this.#replica.ReplicaError(
        this.#replica.ReplicaErrorCode.GRANT_NOT_COVERING,
        "The grant's get or sync coverage carries caveats; re-mint instead of installing it.",
      );
    }
    this.#replica.assertGrantInstallable(parsed, {
      deviceDid: principalOf(this.#device.did),
      space: this.spec.space,
      prefix: this.spec.prefix,
      now: Date.now(),
    });
    await this.#store.installGrant(parsed);
    return newestGrantInfo(this.#replica, parsed, parsed, this.spec)!;
  }

  async sync(options: { signal: AbortSignal; syncStartEpoch: number }): Promise<LocalSyncResult> {
    await this.#assertLive();
    const transportFor = await this.#transports();
    const abort = new AbortController();
    options.signal.throwIfAborted();
    const onAbort = (): void => abort.abort(options.signal.reason);
    options.signal.addEventListener("abort", onAbort, { once: true });
    const engine = new this.#replica.Replica({
      store: this.#store,
      transportFor,
    });
    const running = engine.sync({ signal: abort.signal });
    const registration = { promise: running, abort: () => abort.abort() };
    this.#inFlight.add(registration);
    try {
      const report = await running;
      // The per-replica fence (amendment §1): the identity's committedEpoch
      // captured at this sync's start, persisted only on success, atomically.
      await this.#guard(() =>
        writeJsonAtomic(
          join(this.#replicaDir, FENCE_FILE),
          { v: 1, syncedThroughEpoch: options.syncStartEpoch },
          this.#dirSync,
        ),
      );
      return {
        status: "synced",
        pages: report.pages,
        changes: report.changes,
        deleted: report.deleted,
        fetched: report.fetched,
        contentMissing: report.contentMissing,
        coverage: report.coverage,
        syncedThroughEpoch: options.syncStartEpoch,
      };
    } catch (error) {
      if (this.#replica.isReplicaError(error, this.#replica.ReplicaErrorCode.BUSY)) {
        return { status: "busy" };
      }
      throw error;
    } finally {
      this.#inFlight.delete(registration);
      options.signal.removeEventListener("abort", onAbort);
    }
  }

  async status(): Promise<LocalReplicaStatus> {
    await this.#assertLive();
    const engine = new this.#replica.Replica({ store: this.#store });
    const status = await engine.status();
    const syncedThroughEpoch = await readFence(this.#replicaDir);
    const state = await this.#store.open();
    const grant =
      state === null
        ? null
        : newestGrantInfo(
            this.#replica,
            state.pendingGrant ?? state.grant,
            state.pendingGrant,
            this.spec,
          );
    return {
      coverage: status.coverage,
      lastSyncAt: status.lastSyncAt,
      syncedThroughEpoch,
      authority: { state: status.authority.state, expiresAt: status.authority.expiresAt },
      grant,
      counts: status.counts,
      bytes: status.bytes,
      lastError: status.lastError,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const sync of this.#inFlight) sync.abort();
    await Promise.allSettled([...this.#inFlight].map((sync) => sync.promise));
    await this.#store.close();
  }
}

export function createSqliteReplicaStorage(
  options: SqliteReplicaStorageOptions,
): KVReplicaStorage {
  const root = options.dir;
  const guard: MutationGuard = options.guard ?? ((section) => section());
  const createDevice = options.createDevice ?? createDeviceKey;

  async function openHandle(spec: KVReplicaSpec): Promise<KVReplicaHandle> {
    // Lazy by contract (§11.1): only the Node entry reaches this module,
    // and only enabled replicas reach this point.
    const [replica, sqlite]: [ReplicaRuntime, SqliteRuntime] = await Promise.all([
      import("@tinycloud/replica"),
      import("@tinycloud/replica/sqlite"),
    ]);
    // Defense in depth (§10.1): the secrets gate again at open, on the
    // session's actual verbatim space — even when sign-in never ran.
    if (requiresSecretsOptIn(spec.space, spec.prefix) && spec.allowSecrets !== true) {
      throw new replica.ReplicaError(
        replica.ReplicaErrorCode.SECRETS_OPT_IN_REQUIRED,
        `Replicating ${spec.space}/kv/${spec.prefix} copies secret material to disk; pass allowSecrets to opt in.`,
      );
    }
    const idDir = partitionDirOf(root, spec.identity);
    // The partition's identity record is written/verified on every open,
    // pending store or not (§6.3). A mismatched file fails closed.
    await ensurePartitionIdentity(idDir, spec.identity, options.dirSync);
    // Delegate posture (§2.1): a spec.device handle never reads or creates
    // the partition's own device key.
    const device = spec.device ?? (await loadOrCreateDevice(idDir, guard, createDevice, options.dirSync));
    const replicaHash = replicaHashOf(spec.prefix, device.did);
    const replicaDir = join(idDir, "replicas", replicaHash);
    const store = await sqlite.SqliteReplicaStore.open(replicaDir, {
      create: true,
      guard,
    });
    let generation: number;
    try {
      // First-open race (review): the existence check must run INSIDE the
      // store's guarded init, not in an unguarded read — two processes that
      // both saw "no row" raced to init and one failed spuriously. init is
      // deterministic, so a CONFIG_MISMATCH "already exists" from a
      // concurrent identical init is benign; the config check below is the
      // real mismatch gate.
      try {
        await store.init({
          name: spec.prefix.replace(/\/+$/, "") || "replica",
          replicaId: replicaHash,
          host: spec.identity.host,
          space: spec.space,
          prefix: spec.prefix,
          deviceDid: device.did,
          allowSecrets: spec.allowSecrets,
          localReadPolicy: "whileGrantValid",
          retentionGrantCid: null,
        });
      } catch (error) {
        if (!replica.isReplicaError(error, replica.ReplicaErrorCode.CONFIG_MISMATCH)) {
          throw error;
        }
      }
      const state = await store.open();
      if (state === null) {
        throw new replica.ReplicaError(
          replica.ReplicaErrorCode.NOT_FOUND,
          "The replica row vanished during init.",
        );
      }
      const config = state.config;
      if (
        config.host !== spec.identity.host ||
        config.space !== spec.space ||
        config.prefix !== spec.prefix
      ) {
        throw new replica.ReplicaError(
          replica.ReplicaErrorCode.CONFIG_MISMATCH,
          `This replica follows ${config.host} ${config.space}/kv/${config.prefix}, not ${spec.identity.host} ${spec.space}/kv/${spec.prefix}.`,
        );
      }
      if (principalOf(config.deviceDid) !== principalOf(device.did)) {
        throw new replica.ReplicaError(
          replica.ReplicaErrorCode.CONFIG_MISMATCH,
          "The stored replica belongs to a different device key; purge the partition to rekey.",
        );
      }
      generation = state.generation;
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
    // The inode at handle open: a replica dir recreated in place (or after
    // a purge) is a different replica, so the handle fences on it (review).
    let ino: number | undefined;
    try {
      ino = (await stat(join(replicaDir, "replica.db"))).ino;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return new SqliteReplicaHandle({
      spec,
      device,
      store,
      replicaDir,
      replica,
      guard,
      transportFor: options.transportFor,
      dirSync: options.dirSync,
      generation,
      ino,
    });
  }

  async function purgePartition(target: PurgeTarget): Promise<void> {
    const [replica, sqlite]: [ReplicaRuntime, SqliteRuntime] = await Promise.all([
      import("@tinycloud/replica"),
      import("@tinycloud/replica/sqlite"),
    ]);
    const idDir = partitionDirOf(root, target.identity);
    if (!(await pathExists(idDir))) return;
    // The deduplicated device union (§10.2): the partition's stored device
    // read ONLY (a missing file never creates one and never skips the
    // session device), plus the delegate-posture session device.
    const deviceDids: string[] = [];
    const deviceFile = join(idDir, "device.jwk");
    const stored = await readJsonFile(deviceFile);
    if (stored !== undefined) {
      const device = deviceRecordOf(stored);
      if (device === undefined) {
        throw new ReplicaStorageError(
          "STORAGE_ERROR",
          `The replica device key at ${deviceFile} is unreadable.`,
        );
      }
      deviceDids.push(device.did);
    }
    if (target.sessionDeviceDid !== undefined) deviceDids.push(target.sessionDeviceDid);
    const devices = [...new Map(deviceDids.map((did) => [principalOf(did), did])).values()];

    let firstError: unknown;
    for (const deviceDid of devices) {
      const replicaDir = join(idDir, "replicas", replicaHashOf(target.prefix, deviceDid));
      if (!(await pathExists(replicaDir))) continue;
      try {
        let store: SqliteReplicaStore;
        try {
          store = await sqlite.SqliteReplicaStore.open(replicaDir, { create: false, guard });
        } catch (error) {
          if (replica.isReplicaError(error, replica.ReplicaErrorCode.NOT_FOUND)) {
            // A leftover directory without a database still gets removed.
            await guard(() => rm(replicaDir, { recursive: true, force: true }));
            continue;
          }
          throw error;
        }
        try {
          const state = await store.open();
          if (state === null) {
            await store.close().catch(() => undefined);
            await guard(() => rm(replicaDir, { recursive: true, force: true }));
            continue;
          }
          const lease = await store.acquireSyncLease(SYNC_LEASE_TTL_MS);
          if (lease === null) {
            throw new replica.ReplicaError(
              replica.ReplicaErrorCode.BUSY,
              "Another process holds this replica's sync lease.",
            );
          }
          try {
            // Generation fencing (review): wipe in place FIRST so the
            // replica row's generation commits past every handle opened
            // before this purge — the same contract the browser purge
            // stamps. Skipped when the replica is already revoked:
            // markRevoked bumped the generation itself, and reset refuses
            // revoked replicas. Only then is the directory removed — an
            // open handle never reads a live replica out of a directory
            // that vanished under it.
            if (state.revoked === null) {
              await store.reset(lease, "purged");
            }
            await store.destroy(lease);
          } finally {
            await store.releaseLease(lease).catch(() => undefined);
          }
        } finally {
          await store.close().catch(() => undefined);
        }
      } catch (error) {
        // Every device is attempted; the first error throws after the rest ran.
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  return {
    kind: "sqlite",
    open: openHandle,
    purge: purgePartition,
    // Always the durable partitioned file store (review): the runtime
    // must never fall back to volatile in-memory pending state — a
    // restart that lost ambiguous write records would serve stale data.
    // Without a guard the file store still durably serializes each update;
    // the guard only adds cross-process read-modify-write exclusion.
    pendingWrites(identity: ReplicationIdentity): PendingWriteStore {
      return new FilePendingWriteStore(
        identity,
        partitionDirOf(root, identity),
        guard,
        options.dirSync,
      );
    },
  };
}

/**
 * The public Node-entry adapter (§2.5): durable SQLite replicas partitioned
 * by canonical identity, and ALWAYS the durable partitioned pending-write
 * store — never a silent memory fallback (§3.1, review). Node ≥ 22.13 —
 * older runtimes surface `RUNTIME_UNSUPPORTED` from `open`/`purge`, never
 * silently.
 */
export function sqliteReplicaStorage(options: {
  dir: string;
  guard?: MutationGuard;
}): KVReplicaStorage {
  return createSqliteReplicaStorage(options);
}
