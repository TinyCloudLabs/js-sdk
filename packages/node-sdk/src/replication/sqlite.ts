/**
 * `sqliteReplicaStorage` — Node/CLI SQLite replicas with a mandatory
 * profile lifecycle gate and durable identity-scoped pending file.
 *
 * `@tinycloud/replica`, `@tinycloud/replica/sqlite` and
 * `@tinycloud/node-sdk-wasm` load lazily — only inside `open`, `purge`,
 * `sync` and device-key creation — so this module never lands in the `/core`
 * entry and flag-off Node processes never evaluate replica code. The replica
 * types are the structural declarations in `./replica-contract` (never an
 * import of replica's own `.d.ts`), so this package's build — DTS included —
 * does not depend on replica's dist being built first. `replica-contract.test.ts`
 * pins the declarations against the real modules wherever replica IS built.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, open as openFile, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";


import { KVService, ServiceContext, principalDid } from "@tinycloud/sdk-core";
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
  ProfileReplicaDeferredToken,
  ProfileReplicaPurge as ProfileReplicaPurgeContract,
  ReplicaAccountGate,
  ReplicaDenyOutcome,
  ReplicaDenyInput,
  ReplicaEraseReport,
  ReplicaGateAccess,
  ReplicaLifecycleGate,
  ReplicaConsentAnchor,
  ReplicaPurgeIntent,
  ReplicaSessionStamp,
} from "@tinycloud/sdk-services/kv/replication";
import { CONSENT_WINDOW_MS, MAX_GRANT_TTL_MS, REPLICA_GATE_FILE } from "@tinycloud/sdk-services/kv/replication/contractConstants";
import type {
  GrantRecord,
  MutationGuard,
  ReplicaListEntry,
  ReplicaRuntime,
  ReplicaTransport,
  SqliteReplicaStore,
  SqliteGrantInstall,
  SqliteGrantPolicy,
  SqliteRuntime,
} from "./replica-contract";
import { ucanAttUnconstrainedFor } from "./authority";
export type { ProfileReplicaDeferredToken };

/**
 * The methods of the contract's `ProfileReplicaPurge` (sdk-services, the single
 * source of truth) that this release implements. The logout-marker methods
 * arrive with the CLI logout implementation, which exports the full type.
 */
export type ProfileReplicaPurge = Pick<
  ProfileReplicaPurgeContract,
  "recover" | "erasePending" | "pendingPurge" | "deny" | "deferredErase" | "resumeDeferredErase"
>;


type FileGateState = ReplicaAccountGate & {
  intents: ReplicaPurgeIntent[];
  pendingGenerations: Record<string, number>;
  firstInstall: Record<string, number>;
  grantInstall: Record<string, number>;
  eraseDeferred: boolean;
  deferredPrincipalHash: string | null;
};

type FileGate = {
  readGateSnapshot(profileDir: string): Promise<FileGateState | undefined>;
  identityHashOf(salt: string, identityKey: string): Promise<string>;
  principalHashOf(salt: string, principal: string): Promise<string>;
  grantInstallHashOf(salt: string, identityKeyHash: string, cid: string): Promise<string>;
  assertGateAccess(profileDir: string, access: ReplicaGateAccess, salt: string): Promise<FileGateState>;
  readFirstInstall(profileDir: string, identityKeyHash: string): Promise<number | undefined>;
  recordFirstInstall(profileDir: string, identityKeyHash: string, atMs: number): Promise<number>;
  recordGrantInstall(profileDir: string, hash: string, atMs: number): Promise<number>;
  establishSessionStamp(profileDir: string, principal: string, o: { siweIssuedAt: number }): Promise<ReplicaSessionStamp>;
  restoreSessionStamp(profileDir: string, principal: string, persisted: ReplicaSessionStamp | undefined): Promise<ReplicaSessionStamp>;
  denyGate(
    profileDir: string,
    input: ReplicaDenyInput,
    collectIntents: (principalHash: string) => Promise<readonly ReplicaPurgeIntent[]>,
    precomputed?: { salt: string; principalHash: string },
    options?: { deferErase?: boolean },
  ): Promise<ReplicaDenyOutcome>;
  deferredGateToken(profileDir: string): Promise<ProfileReplicaDeferredToken | null>;
  resumeDeferredGate(profileDir: string, token: ProfileReplicaDeferredToken): Promise<boolean>;
  clearGateIntent(profileDir: string, id: string): Promise<void>;
};

async function fileGate(): Promise<FileGate> {
  // @ts-ignore — node-sdk's DTS build precedes replica; the structural FileGate above is checked at use.
  return import("@tinycloud/replica/profile-gate") as Promise<FileGate>;
}

function gated(reason: "gate_unavailable" | "not_established" | "stamp_stale" | "purge_pending"): Error & { code: "REPLICA_GATED"; gate: string } {
  return Object.assign(new Error(`Replica gate refused: ${reason}`), { code: "REPLICA_GATED" as const, gate: reason });
}

async function requiredGuard<T>(guard: MutationGuard | undefined, section: () => Promise<T>): Promise<T> {
  if (guard === undefined) throw gated("gate_unavailable");
  let entered = false;
  try {
    return await guard(async () => {
      entered = true;
      return section();
    });
  } catch (error) {
    if (!entered) throw gated("gate_unavailable");
    throw error;
  }
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

/** True for a real directory, false when absent. A symlink or other file type is a replaced root. */
async function realDirectoryExists(path: string): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw storageError("STORAGE_ERROR", `Reading ${path}`, error);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ReplicaStorageError("STORAGE_ERROR", `Refusing the replaced replica path ${path}.`);
  }
  return true;
}

/**
 * Removes a replica directory that has no usable database without recursion: only the store's own
 * layout (database files, the sync fence and content-addressed blobs) is unlinked, and anything
 * else refuses. unlink/rmdir never follow a path swapped after inventory.
 */
async function removeLeftoverReplicaDir(replicaDir: string): Promise<void> {
  const refuse = (path: string) =>
    new ReplicaStorageError("STORAGE_ERROR", `Refusing to remove unexpected replica path ${path}.`);
  const assertLayout = async (path: string, directory: boolean) => {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || (directory ? !stats.isDirectory() : !stats.isFile())) throw refuse(path);
  };
  const files: string[] = [];
  const directories: string[] = [];
  for (const name of await readdir(replicaDir)) {
    const path = join(replicaDir, name);
    if (["replica.db", "replica.db-wal", "replica.db-shm", FENCE_FILE].includes(name) ||
        /^fence\.json\.[0-9a-f]{12}\.tmp$/.test(name)) {
      await assertLayout(path, false);
      files.push(path);
    } else if (name === "blobs") {
      await assertLayout(path, true);
      for (const shard of await readdir(path)) {
        const shardPath = join(path, shard);
        if (shard !== ".tmp" && !/^[0-9a-f]{2}$/.test(shard)) throw refuse(shardPath);
        await assertLayout(shardPath, true);
        for (const blob of await readdir(shardPath)) {
          const blobPath = join(shardPath, blob);
          if (shard === ".tmp" ? !/^[0-9a-f]{64}\.[0-9a-f]{12}$/.test(blob) : !/^[0-9a-f]{64}$/.test(blob) || !blob.startsWith(shard)) {
            throw refuse(blobPath);
          }
          await assertLayout(blobPath, false);
          files.push(blobPath);
        }
        directories.push(shardPath);
      }
      directories.push(path);
    } else {
      throw refuse(path);
    }
  }
  for (const file of files) await unlink(file);
  for (const directory of directories) await rmdir(directory);
  await rmdir(replicaDir);
}

/** `did:key:…#fragment` → the bare principal DID (replica's principalOf). */
function principalOf(did: string): string {
  return principalDid(did);
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
 * Durable identity-scoped pending file. The profile lock covers the gate and
 * both sides of every file snapshot; only updates create a partition.
 */

/**
 * In-process serialization of pending.json read-modify-writes, keyed by the
 * canonical (realpath) file path and shared by every `FilePendingWriteStore`
 * instance — two stores on one partition (or two `update` calls on one
 * store) can never interleave reads and writes, even when they reach the
 * partition through different paths (a symlink and its target agree on one
 * chain). Entries delete themselves once their section is the chain tail,
 * so the map stays bounded by in-flight updates.
 *
 * PRECONDITION: `file` MUST already be the canonical real path of the
 * target — this function does not resolve symlinks itself (path.resolve is
 * lexical and would split the chain exactly like the bug it replaced).
 */
const PENDING_WRITE_LOCKS = new Map<string, Promise<unknown>>();

/** Run `section` after every queued section for `file`; the chain tail never rejects. */
function serializePendingWrite<T>(file: string, section: () => Promise<T>): Promise<T> {
  const tail = PENDING_WRITE_LOCKS.get(file) ?? Promise.resolve();
  const entered = tail.then(section);
  // The tail swallows each section's outcome; the caller still gets it via
  // `entered`.
  const next: Promise<unknown> = entered.then(
    () => undefined,
    () => undefined,
  );
  PENDING_WRITE_LOCKS.set(file, next);
  void next.then(() => {
    if (PENDING_WRITE_LOCKS.get(file) === next) PENDING_WRITE_LOCKS.delete(file);
  });
  return entered;
}

function parsePendingState(text: string, file: string, identity: ReplicationIdentity): PendingWriteState {
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
    throw new ReplicaStorageError("STORAGE_ERROR", `Pending-write state at ${file} is corrupt.`);
  }
  const storedIdentity = identityRecordOf(state.identity);
  if (storedIdentity === undefined || !sameIdentity(storedIdentity, identity)) {
    throw new ReplicaStorageError("STORAGE_ERROR", `Pending-write state at ${file} belongs to a different identity.`);
  }
  return state as PendingWriteState;
}

export class FilePendingWriteStore implements PendingWriteStore {
  readonly durable = true;
  readonly identity: ReplicationIdentity;
  readonly #dir: string;
  readonly #profileDir: string;
  readonly #guard: MutationGuard | undefined;
  readonly #stamp: ReplicaSessionStamp | undefined;
  readonly #dirSync?: DirSync;
  #generation: number | undefined;
  #canonicalDir: string | undefined;

  constructor(
    identity: ReplicationIdentity,
    dir: string,
    profileDir: string,
    guard: MutationGuard | undefined,
    stamp: ReplicaSessionStamp | undefined,
    dirSync?: DirSync,
  ) {
    this.identity = identity;
    this.#dir = dir;
    this.#profileDir = profileDir;
    this.#guard = guard;
    this.#stamp = stamp;
    this.#dirSync = dirSync;
  }

  async #withGate<T>(section: (file: string) => Promise<T>): Promise<T> {
    if (this.#stamp === undefined) throw gated("not_established");
    if (this.#guard === undefined) throw gated("gate_unavailable");
    const gate = await fileGate();
    const snapshot = await gate.readGateSnapshot(this.#profileDir);
    if (snapshot === undefined) throw gated("gate_unavailable");
    const [principalHash, identityKeyHash] = await Promise.all([
      gate.principalHashOf(snapshot.salt, this.identity.principal),
      gate.identityHashOf(snapshot.salt, replicationIdentityKey(this.identity)),
    ]);
    const access: ReplicaGateAccess = {
      stamp: this.#stamp, incarnation: snapshot.incarnation, principalHash, identityKeyHash,
    };
    // This stable queue key exists even when the identity partition does not.
    // Canonicalizing the root keeps symlink aliases in the same process chain.
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(dirname(this.#dir));
    } catch (error) {
      if (!isNotFound(error)) throw storageError("STORAGE_ERROR", `Resolving ${dirname(this.#dir)}`, error);
      canonicalRoot = join(await realpath(dirname(dirname(this.#dir))), basename(dirname(this.#dir)));
    }
    const queueKey = join(canonicalRoot, basename(this.#dir), "pending.json");
    return serializePendingWrite(queueKey, () => requiredGuard(this.#guard, async () => {
      const before = await gate.assertGateAccess(this.#profileDir, access, snapshot.salt);
      const generation = before.pendingGenerations[identityKeyHash] ?? 0;
      if (this.#generation !== undefined && this.#generation !== generation) {
        throw new ReplicaStorageError("RESET_REQUIRED", "The pending identity was erased; reopen the store.");
      }
      let file = join(this.#dir, "pending.json");
      try {
        file = join(await realpath(this.#dir), "pending.json");
        const recorded = identityRecordOf(await readJsonFile(join(dirname(file), "identity.json")));
        if (recorded === undefined || !sameIdentity(recorded, this.identity)) {
          throw new ReplicaStorageError("STORAGE_ERROR", "The pending partition belongs to a different identity.");
        }
      } catch (error) {
        if (error instanceof ReplicaStorageError) throw error;
        if (!isNotFound(error)) throw storageError("STORAGE_ERROR", `Resolving ${this.#dir}`, error);
      }
      if (this.#canonicalDir !== undefined && dirname(file) !== this.#canonicalDir) {
        throw new ReplicaStorageError("STORAGE_ERROR", "The pending-write partition changed while open.");
      }
      const result = await section(file);
      await gate.assertGateAccess(this.#profileDir, access, snapshot.salt);
      this.#generation = generation;
      if (await pathExists(this.#dir)) this.#canonicalDir = await realpath(this.#dir);
      return result;
    }));
  }

  async #readFile(file: string): Promise<PendingWriteState | undefined> {
    try {
      return parsePendingState(await readFile(file, "utf8"), file, this.identity);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error instanceof ReplicaStorageError) throw error;
      throw storageError("STORAGE_ERROR", `Reading ${file}`, error);
    }
  }

  async read(): Promise<PendingWriteState> {
    return this.#withGate(async (file) =>
      (await this.#readFile(file)) ?? { v: 2, identity: this.identity, committedEpoch: 0, seq: 0, records: [] });
  }

  async readExisting(): Promise<PendingWriteState | undefined> {
    return this.#withGate((file) => this.#readFile(file));
  }

  async update<T>(mutate: (state: PendingWriteState) => T): Promise<T> {
    return this.#withGate(async (file) => {
      // Gate and generation have already been checked while locked. No file
      // or directory is created for a denied or stale session.
      await ensurePartitionIdentity(this.#dir, this.identity, this.#dirSync);
      const currentFile = join(await realpath(this.#dir), "pending.json");
      if (this.#canonicalDir !== undefined && dirname(currentFile) !== this.#canonicalDir) {
        throw new ReplicaStorageError("STORAGE_ERROR", "The pending-write partition changed while open.");
      }
      const state = (await this.#readFile(currentFile)) ??
        { v: 2 as const, identity: this.identity, committedEpoch: 0, seq: 0, records: [] };
      const result = await mutate(state);
      await writeJsonAtomic(currentFile, state, this.#dirSync);
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
  /** Mandatory cross-process profile lock; no unlocked replica or pending path. */
  guard?: MutationGuard;
  /** Full path to replica-gate.json; defaults to the directory next to dir. */
  gateFile?: string;
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
  install: SqliteGrantInstall | null,
): ReplicaGrantInfo | null {
  if (record === null) return null;
  const parsed = replica.parseUcanGrant(record.bytes);
  return {
    cid: record.cid,
    parentCid: parsed.prf[0] ?? null,
    expiresAt: record.expiresAt === null ? null : record.expiresAt * 1000,
    state: pending !== null && record === pending ? "pending" : "active",
    unconstrained: ucanAttUnconstrainedFor(parsed.att, spec.space, spec.prefix),
    ...(install === null ? {} : install),
  };
}

class SqliteReplicaHandle implements KVReplicaHandle {
  readonly spec: KVReplicaSpec;
  readonly deviceDid: string;
  readonly replicaId: string;
  readonly #device: ReplicaDevice;
  readonly #store: SqliteReplicaStore;
  readonly #replicaDir: string;
  readonly #replica: ReplicaRuntime;
  readonly #guard: MutationGuard;
  readonly #read: <T>(section: (snapshot: SqliteReplicaStore, syncedThroughEpoch: number) => Promise<T>, withFence?: boolean) => Promise<T>;
  readonly #policy: (at: number, recordFirst: boolean) => Promise<SqliteGrantPolicy | null>;
  readonly #recordGrantInstall: (cid: string, at: number) => Promise<number>;
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
    replicaId: string;
    device: ReplicaDevice;
    store: SqliteReplicaStore;
    replicaDir: string;
    replica: ReplicaRuntime;
    guard: MutationGuard;
    read: <T>(section: (snapshot: SqliteReplicaStore, syncedThroughEpoch: number) => Promise<T>, withFence?: boolean) => Promise<T>;
    policy: (at: number, recordFirst: boolean) => Promise<SqliteGrantPolicy | null>;
    recordGrantInstall: (cid: string, at: number) => Promise<number>;
    transportFor?: SqliteReplicaStorageOptions["transportFor"];
    dirSync?: DirSync;
    generation: number;
    ino: number | undefined;
  }) {
    this.spec = input.spec;
    this.replicaId = input.replicaId;
    this.#device = input.device;
    this.deviceDid = input.device.did;
    this.#store = input.store;
    this.#replicaDir = input.replicaDir;
    this.#replica = input.replica;
    this.#guard = input.guard;
    this.#read = input.read;
    this.#policy = input.policy;
    this.#recordGrantInstall = input.recordGrantInstall;
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

  async #assertEffective(snapshot: SqliteReplicaStore): Promise<void> {
    const state = await snapshot.open();
    if (state?.grant === undefined || state.grant === null) return;
    const installed = await snapshot.getGrantInstall(state.grant.cid);
    if (installed === null || !Number.isSafeInteger(installed.effectiveExpiresAt) ||
        Date.now() >= installed.effectiveExpiresAt || Date.now() >= installed.consentDeadline) {
      throw new ReplicaStorageError("GRANT_EXPIRED", "The replica grant's effective lifetime has expired.");
    }
  }

  /** Refuse an expired installed grant before constructing transports or fetching pages. */
  async #assertSyncEffective(): Promise<void> {
    const state = await this.#store.open();
    const selected = state?.pendingGrant ?? state?.grant;
    if (selected === undefined || selected === null) return;
    const installed = await this.#store.getGrantInstall(selected.cid);
    const now = Date.now();
    if (installed === null || !Number.isSafeInteger(installed.effectiveExpiresAt) ||
        now >= installed.effectiveExpiresAt || now >= installed.consentDeadline) {
      throw new ReplicaStorageError("GRANT_EXPIRED", "The replica grant's effective lifetime has expired.");
    }
  }

  async get(key: string): Promise<LocalGetResult> {
    return this.#read(async (snapshot, syncedThroughEpoch) => {
    this.#assertOpen();
    await this.#assertEffective(snapshot);
    const result = await new this.#replica.Replica({ store: snapshot }).get(key);
    await this.#assertEffective(snapshot);
    const meta: LocalReadMeta = {
      asOf: result.meta.asOf,
      coverage: result.meta.coverage,
      authority: result.meta.authority,
      syncedThroughEpoch,
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
    }, true);
  }

  async list(options: { prefix: string; after?: string; limit?: number }): Promise<LocalListResult> {
    return this.#read(async (snapshot, syncedThroughEpoch) => {
    this.#assertOpen();
    await this.#assertEffective(snapshot);
    const result = await new this.#replica.Replica({ store: snapshot }).list({
      prefix: options.prefix,
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    await this.#assertEffective(snapshot);
    return {
      keys: result.entries.map((entry: ReplicaListEntry) => entry.key),
      meta: {
        asOf: result.meta.asOf,
        coverage: result.meta.coverage,
        authority: result.meta.authority,
        syncedThroughEpoch,
      },
    };
    }, true);
  }

  /**
   * The newest installed grant — the pending one when a not-yet-promoted
   * install exists — with `parentCid` = signed `prf[0]` and `unconstrained`
   * computed from the signed `att` (replica's own grantCovers ignores
   * caveats, so the adapter computes it, §2.1). A constrained installed
   * grant is still reported (unconstrained: false) and never reused.
   */
  async grant(): Promise<ReplicaGrantInfo | null> {
    return this.#read(async (snapshot) => {
    this.#assertOpen();
    const state = await snapshot.open();
    if (state === null) return null;
    const selected = state.pendingGrant ?? state.grant;
    const install = selected === null ? null : await snapshot.getGrantInstall(selected.cid);
    return newestGrantInfo(
      this.#replica,
      state.pendingGrant ?? state.grant,
      state.pendingGrant,
      this.spec,
      install,
    );
    });
  }

  async installGrant(ucan: string): Promise<ReplicaGrantInfo> {
    return this.#guard(async () => {
    await this.#assertLive();
    const parsed = this.#replica.parseUcanGrant(ucan);
    const state = await this.#store.open();
    if (state === null) {
      throw new this.#replica.ReplicaError(
        this.#replica.ReplicaErrorCode.NOT_FOUND,
        "The replica has not been created.",
      );
    }
    this.#replica.assertGrantInstallable(parsed, {
      deviceDid: principalOf(this.#device.did),
      space: this.spec.space,
      prefix: this.spec.prefix,
      now: Date.now(),
    });
    // Reuse-rule enforcement on every grant path: a caveated get/sync grant
    // can never serve this replica, so it must never be installed.
    if (!ucanAttUnconstrainedFor(parsed.att, this.spec.space, this.spec.prefix)) {
      throw new this.#replica.ReplicaError(
        this.#replica.ReplicaErrorCode.GRANT_NOT_COVERING,
        "The grant's get or sync coverage carries caveats; re-mint instead of installing it.",
      );
    }
    const now = Date.now();
    const policy = await this.#policy(now, true);
    if (policy === null || now >= policy.consentDeadline) {
      throw new ReplicaStorageError("CONSENT_EXPIRED", "The replica's consent window has expired.");
    }
    // The profile gate survives targeted partition purge; persist the CID
    // floor before the SQLite install so a crash cannot refresh its TTL.
    const installedAt = await this.#recordGrantInstall(parsed.cid, now);
    const installed = await this.#store.installGatedGrant(parsed, { ...policy, at: installedAt });
    return newestGrantInfo(this.#replica, parsed, parsed, this.spec, installed)!;
    });
  }

  async sync(options: { signal: AbortSignal; syncStartEpoch: number }): Promise<LocalSyncResult> {
    await this.#guard(async () => {
      await this.#assertLive();
      await this.#assertSyncEffective();
    });
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
    return this.#read(async (snapshot, syncedThroughEpoch) => {
    this.#assertOpen();
    const engine = new this.#replica.Replica({ store: snapshot });
    const status = await engine.status();
    // The fence was captured before the SQLite snapshot began.
    const state = await snapshot.open();
    const selected = state?.pendingGrant ?? state?.grant ?? null;
    const selectedInstall = selected === null ? null : await snapshot.getGrantInstall(selected.cid);
    const activeRecord = state?.grant ?? null;
    const activeInstall = activeRecord === null ? null : await snapshot.getGrantInstall(activeRecord.cid);
    const grant =
      state === null
        ? null
        : newestGrantInfo(
            this.#replica,
            state.pendingGrant ?? state.grant,
            state.pendingGrant,
            this.spec,
            selectedInstall,
          );
    return {
      coverage: status.coverage,
      lastSyncAt: status.lastSyncAt,
      syncedThroughEpoch,
      authority: activeRecord !== null && (activeInstall === null ||
          Date.now() >= activeInstall.effectiveExpiresAt || !Number.isSafeInteger(activeInstall.effectiveExpiresAt))
        ? { state: "expired", expiresAt: activeInstall === null ? null : new Date(activeInstall.effectiveExpiresAt).toISOString() }
        : { state: status.authority.state, expiresAt: status.authority.expiresAt },
      grant,
      counts: status.counts,
      bytes: status.bytes,
      lastError: status.lastError,
    };
    }, true);
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
): KVReplicaStorage & { lifecycle: ReplicaLifecycleGate & ProfileReplicaPurge } {
  const root = options.dir;
  const profileDir = dirname(options.gateFile ?? join(dirname(root), REPLICA_GATE_FILE));
  const guard = options.guard;
  const createDevice = options.createDevice ?? createDeviceKey;
  const heldLock = new AsyncLocalStorage<boolean>();
  let visibleStamp: ReplicaSessionStamp | undefined;
  let visiblePrincipalHash: string | undefined;
  let checkedGate: { ino: bigint; mtimeNs: bigint; size: bigint; incarnation: string; epoch: number; principalHash: string | null } | undefined;

  async function profileSection<T>(section: () => Promise<T>): Promise<T> {
    if (heldLock.getStore() === true) return section();
    return requiredGuard(guard, () => heldLock.run(true, section));
  }

  async function guarded<T>(
    principal: string,
    stamp: ReplicaSessionStamp | undefined,
    identity: ReplicationIdentity | undefined,
    partitionId: string | undefined,
    section: () => Promise<T>,
  ): Promise<T> {
    if (stamp === undefined) throw gated("not_established");
    if (guard === undefined) throw gated("gate_unavailable");
    const gate = await fileGate();
    const snapshot = await gate.readGateSnapshot(profileDir);
    if (snapshot === undefined) throw gated("gate_unavailable");
    const [principalHash, identityKeyHash] = await Promise.all([
      gate.principalHashOf(snapshot.salt, principal),
      identity === undefined ? Promise.resolve(undefined) : gate.identityHashOf(snapshot.salt, replicationIdentityKey(identity)),
    ]);
    return profileSection(async () => {
      await gate.assertGateAccess(profileDir, {
        stamp, incarnation: snapshot.incarnation, principalHash, identityKeyHash, partitionId,
      }, snapshot.salt);
      return section();
    });
  }

  async function readGated<T>(
    spec: KVReplicaSpec,
    partitionId: string,
    store: SqliteReplicaStore,
    replicaDir: string,
    generation: number,
    section: (snapshot: SqliteReplicaStore, syncedThroughEpoch: number) => Promise<T>,
    withFence = false,
  ): Promise<T> {
    if (spec.stamp === undefined) throw gated("not_established");
    const gate = await fileGate();
    const snapshot = await gate.readGateSnapshot(profileDir);
    if (snapshot === undefined) throw gated("gate_unavailable");
    const [principalHash, identityKeyHash] = await Promise.all([
      gate.principalHashOf(snapshot.salt, spec.identity.principal),
      gate.identityHashOf(snapshot.salt, replicationIdentityKey(spec.identity)),
    ]);
    const access: ReplicaGateAccess = {
      stamp: spec.stamp, incarnation: snapshot.incarnation, principalHash, identityKeyHash, partitionId,
    };
    const path = options.gateFile ?? join(profileDir, REPLICA_GATE_FILE);
    let checked: { ino: bigint; size: bigint; mtimeNs: bigint } | undefined;
    const checkGate = async (): Promise<void> => {
      let before;
      try {
        before = await stat(path, { bigint: true });
      } catch {
        throw gated("gate_unavailable");
      }
      if (checked?.ino === before.ino && checked.size === before.size && checked.mtimeNs === before.mtimeNs) return;
      const checkedState = await gate.assertGateAccess(profileDir, access, snapshot.salt);
      if (spec.grantPolicy?.consentAnchor === null && checkedState.firstInstall[identityKeyHash] === undefined) {
        const installed = await store.open();
        if (installed !== null && (installed.grant !== null || installed.pendingGrant !== null)) throw gated("gate_unavailable");
      }
      let after;
      try {
        after = await stat(path, { bigint: true });
      } catch {
        throw gated("gate_unavailable");
      }
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
        throw gated("gate_unavailable");
      }
      checked = after;
    };
    if (withFence) await checkGate();
    // A fence written after the SQLite snapshot starts belongs to newer rows.
    // Capture it first; a concurrent sync can only make this value conservative.
    const fence = withFence ? await readFence(replicaDir) : 0;
    return store.readTransaction(generation, checkGate, (sqliteSnapshot) => section(sqliteSnapshot, fence));
  }

  async function identityDirs(): Promise<string[]> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink() || (entry.isDirectory() && !/^[a-z2-7]{26}$/.test(entry.name))) {
          throw new ReplicaStorageError("STORAGE_ERROR", `Unknown identity partition at ${root}.`);
        }
      }
      return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw storageError("STORAGE_ERROR", `Listing ${root}`, error);
    }
  }

  async function collectIntents(principalHash: string, salt: string): Promise<ReplicaPurgeIntent[]> {
    const gate = await fileGate();
    const intents: ReplicaPurgeIntent[] = [];
    for (const idDir of await identityDirs()) {
      const identity = identityRecordOf(await readJsonFile(join(idDir, "identity.json")));
      if (identity === undefined) throw new ReplicaStorageError("STORAGE_ERROR", `Missing identity at ${idDir}.`);
      if (await gate.principalHashOf(salt, identity.principal) !== principalHash) continue;
      const identityKeyHash = await gate.identityHashOf(salt, replicationIdentityKey(identity));
      const recordedAt = Date.now();
      if (await pathExists(join(idDir, "pending.json")) || await pathExists(join(idDir, "device.jwk"))) {
        intents.push({ id: `pending:${identityKeyHash}`, kind: "pending", identityKeyHash, principalHash, recordedAt });
      }
      const replicasDir = join(idDir, "replicas");
      let entries;
      try {
        entries = await readdir(replicasDir, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) continue;
        throw storageError("STORAGE_ERROR", `Listing ${replicasDir}`, error);
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/^[a-z2-7]{26}$/.test(entry.name)) {
          throw new ReplicaStorageError("STORAGE_ERROR", `Unrecognized replica partition at ${replicasDir}.`);
        }
        const partitionId = `${identityKeyHash}:${entry.name}`;
        intents.push({ id: partitionId, kind: "partition", partitionId, principalHash, recordedAt });
      }
    }
    return intents;
  }

  /** Preserve even superseded CIDs before legacy DBs are purged or recomputed. Call with the profile lock held. */
  async function retainGrantInstalls(
    gate: FileGate,
    gateState: FileGateState,
    identityKeyHash: string,
    store: SqliteReplicaStore,
  ): Promise<void> {
    for (const { cid, installedAt } of await store.grantInstallTimes()) {
      const key = await gate.grantInstallHashOf(gateState.salt, identityKeyHash, cid);
      await gate.recordGrantInstall(profileDir, key, installedAt);
    }
  }
  const lifecycle: ReplicaLifecycleGate & ProfileReplicaPurge = {
    kind: "file",
    async recover({ signal }) {
      return lifecycle.erasePending({ signal });
    },
    async establishSessionStamp(principal, { consentAnchor }) {
      if (consentAnchor?.source === "first_install" || !Number.isSafeInteger(consentAnchor?.at) || consentAnchor.at < 0) {
        throw gated("not_established");
      }
      const gate = await fileGate();
      const stamp = await profileSection(() =>
        gate.establishSessionStamp(profileDir, principal, { siweIssuedAt: consentAnchor.at }));
      const state = await gate.readGateSnapshot(profileDir);
      if (state === undefined) throw gated("gate_unavailable");
      visiblePrincipalHash = await gate.principalHashOf(state.salt, principal);
      checkedGate = undefined;
      visibleStamp = stamp;
      return stamp;
    },
    async restoreSessionStamp(principal, persisted) {
      const gate = await fileGate();
      const stamp = await profileSection(() => gate.restoreSessionStamp(profileDir, principal, persisted));
      const state = await gate.readGateSnapshot(profileDir);
      if (state === undefined) throw gated("gate_unavailable");
      visiblePrincipalHash = await gate.principalHashOf(state.salt, principal);
      checkedGate = undefined;
      visibleStamp = stamp;
      return stamp;
    },
    async activationAllowed(next) {
      if (guard === undefined) return false;
      try {
        const gate = await fileGate();
        return await profileSection(async () => {
          const state = await gate.readGateSnapshot(profileDir);
          return state !== undefined && !state.eraseDeferred && state.intents.length === 0 &&
            (state.principalHash === null || state.principalHash === await gate.principalHashOf(state.salt, next));
        });
      } catch {
        return false;
      }
    },
    checkDelivery(stamp) {
      if (guard === undefined || visiblePrincipalHash === undefined) return { status: "gated", gate: "gate_unavailable" };
      if (!stamp || visibleStamp?.incarnation !== stamp.incarnation ||
          visibleStamp.lifecycleEpoch !== stamp.lifecycleEpoch) {
        return { status: "gated", gate: "stamp_stale" };
      }
      try {
        const path = options.gateFile ?? join(profileDir, REPLICA_GATE_FILE);
        const stats = statSync(path, { bigint: true });
        if (checkedGate === undefined || checkedGate.ino !== stats.ino ||
            checkedGate.mtimeNs !== stats.mtimeNs || checkedGate.size !== stats.size) {
          const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
          if (typeof raw.incarnation !== "string" || !Number.isSafeInteger(raw.lifecycleEpoch) ||
              (raw.principalHash !== null && typeof raw.principalHash !== "string") ||
              !Array.isArray(raw.intents)) {
            return { status: "gated", gate: "gate_unavailable" };
          }
          checkedGate = {
            ino: stats.ino, mtimeNs: stats.mtimeNs, size: stats.size,
            incarnation: raw.incarnation, epoch: raw.lifecycleEpoch as number,
            principalHash: raw.principalHash,
          };
        }
      } catch {
        return { status: "gated", gate: "gate_unavailable" };
      }
      if (checkedGate.incarnation !== stamp.incarnation || checkedGate.epoch !== stamp.lifecycleEpoch) {
        return { status: "gated", gate: "stamp_stale" };
      }
      return checkedGate.principalHash === visiblePrincipalHash
        ? { status: "allow" }
        : { status: "gated", gate: "principal_mismatch" };
    },
    consentDeadline() { return null; },
    deliverable(stamp) { return lifecycle.checkDelivery(stamp).status === "allow"; },
    deny(input: ReplicaDenyInput, options?: { deferErase?: boolean }) {
      if (options?.deferErase === true && input.reason !== "sign_out") {
        throw new TypeError("Deferred erase is only available for sign-out.");
      }
      visibleStamp = undefined;
      visiblePrincipalHash = undefined;
      checkedGate = undefined;
      return (async (): Promise<ReplicaDenyOutcome & { resumeToken?: ProfileReplicaDeferredToken }> => {
        try {
          const gate = await fileGate();
          const snapshot = await gate.readGateSnapshot(profileDir);
          const precomputed = snapshot === undefined ? undefined : {
            salt: snapshot.salt, principalHash: await gate.principalHashOf(snapshot.salt, input.principal),
          };
          return await profileSection(async () => {
            const result = await gate.denyGate(profileDir, input,
              async (principalHash) => collectIntents(principalHash, precomputed?.salt ?? ""),
              precomputed, options);
            if (result.status !== "denied" || options?.deferErase !== true) return result;
            const resumeToken = await gate.deferredGateToken(profileDir);
            if (resumeToken === null || resumeToken.deniedEpoch !== result.lifecycleEpoch) {
              return { status: "unguarded", code: "gate_unavailable" };
            }
            return { ...result, resumeToken };
          });
        } catch (error) {
          return { status: "unguarded", code: typeof error === "object" && error !== null &&
            "code" in error && typeof error.code === "string" ? error.code : "gate_unavailable" };
        }
      })();
    },
    deferredErase() {
      return profileSection(async () => (await fileGate()).deferredGateToken(profileDir));
    },
    async resumeDeferredErase(token, { signal }) {
      signal.throwIfAborted();
      await profileSection(async () => (await fileGate()).resumeDeferredGate(profileDir, token));
      return lifecycle.erasePending({ signal });
    },
    async pendingPurge() {
      const gate = await fileGate();
      return (await gate.readGateSnapshot(profileDir))?.intents ?? [];
    },
    async erasePending({ signal }): Promise<ReplicaEraseReport> {
      const gate = await fileGate();
      const erased: string[] = [];
      const failed: Array<{ id: string; code: string }> = [];
      const intents = await lifecycle.pendingPurge();
      const held = await profileSection(() => gate.readGateSnapshot(profileDir));
      if (held?.eraseDeferred) return { erased, failed, remaining: held.intents.length };
      for (const intent of intents) {
        signal.throwIfAborted();
        try {
          await profileSection(async () => {
            const state = await gate.readGateSnapshot(profileDir);
            if (state?.eraseDeferred) return;
            if (!state?.intents.some((queued) => queued.id === intent.id)) return;
            let idDir: string | undefined;
            for (const dir of await identityDirs()) {
              const identity = identityRecordOf(await readJsonFile(join(dir, "identity.json")));
              if (identity === undefined) throw new ReplicaStorageError("STORAGE_ERROR", `Missing identity at ${dir}.`);
              const hash = await gate.identityHashOf(state.salt, replicationIdentityKey(identity));
              if (intent.kind === "pending" ? hash === intent.identityKeyHash : intent.partitionId.startsWith(`${hash}:`)) {
                idDir = dir;
                break;
              }
            }
            if (intent.kind === "pending") {
              if (intent.id !== `pending:${intent.identityKeyHash}`) throw gated("gate_unavailable");
              if (idDir !== undefined) {
                await rm(join(idDir, "pending.json"), { force: true });
                await rm(join(idDir, "device.jwk"), { force: true });
                await fsyncDir(idDir);
              }
            } else {
              if (!/^[0-9a-f]{64}:[a-z2-7]{26}$/.test(intent.partitionId) || intent.id !== intent.partitionId) {
                throw gated("gate_unavailable");
              }
              if (idDir !== undefined) {
                const replicaDir = join(idDir, "replicas", intent.partitionId.slice(65));
                // A replaced identity, replicas or replica directory refuses; the intent stays queued.
                if (await realDirectoryExists(idDir) && await realDirectoryExists(join(idDir, "replicas")) &&
                    await realDirectoryExists(replicaDir)) {
                  const [replica, sqlite] = (await Promise.all([
                    // @ts-ignore — replica dist may not exist during node-sdk DTS build.
                    import("@tinycloud/replica"),
                    // @ts-ignore — same as above.
                    import("@tinycloud/replica/sqlite"),
                  ])) as [ReplicaRuntime, SqliteRuntime];
                  let store: SqliteReplicaStore | undefined;
                  try {
                    store = await sqlite.SqliteReplicaStore.open(replicaDir, { create: false, guard: profileSection });
                    const row = await store.open();
                    if (row !== null) {
                      const lease = await store.acquireSyncLease(SYNC_LEASE_TTL_MS);
                      if (lease === null) throw new replica.ReplicaError(replica.ReplicaErrorCode.BUSY, "The partition is busy.");
                      try {
                        if (row.revoked === null) await store.reset(lease, "purged");
                        await store.destroy(lease);
                      } finally {
                        await store.releaseLease(lease).catch(() => undefined);
                      }
                    } else {
                      await removeLeftoverReplicaDir(replicaDir);
                    }
                  } catch (error) {
                    if (!replica.isReplicaError(error, replica.ReplicaErrorCode.NOT_FOUND)) throw error;
                    await removeLeftoverReplicaDir(replicaDir);
                  } finally {
                    await store?.close().catch(() => undefined);
                  }
                  await fsyncDir(join(idDir, "replicas"));
                }
              }
            }
            await gate.clearGateIntent(profileDir, intent.id);
            erased.push(intent.id);
          });
        } catch (error) {
          failed.push({ id: intent.id, code: typeof error === "object" && error !== null &&
            "code" in error && typeof error.code === "string" ? error.code : "STORAGE_ERROR" });
        }
      }
      return { erased, failed, remaining: (await lifecycle.pendingPurge()).length };
    },
  };

  async function openHandle(spec: KVReplicaSpec): Promise<KVReplicaHandle> {
    // Lazy by contract (§11.1): only the Node entry reaches this module,
    // and only enabled replicas reach this point.
    // Literal specifiers so bundlers can follow the dependency; @ts-ignore
    // (not expect-error) because tsc resolves replica when its dist exists.
    const [replica, sqlite] = (await Promise.all([
      // @ts-ignore — TS2307 when replica's dist is absent (CI builds node-sdk first).
      import("@tinycloud/replica"),
      // @ts-ignore — same as above.
      import("@tinycloud/replica/sqlite"),
    ])) as [ReplicaRuntime, SqliteRuntime];
    if (spec.stamp === undefined) throw gated("not_established");
    if (guard === undefined) throw gated("gate_unavailable");
    if (spec.grantPolicy === undefined) {
      throw new ReplicaStorageError("REPLICA_INVALID_ARGUMENT", "A replica grant policy is required.");
    }
    const gate = await fileGate();
    const snapshot = await gate.readGateSnapshot(profileDir);
    if (snapshot === undefined) throw gated("gate_unavailable");
    const identityKeyHash = await gate.identityHashOf(snapshot.salt, replicationIdentityKey(spec.identity));
    const resolvePolicy = async (at: number, recordFirst: boolean): Promise<SqliteGrantPolicy | null> => {
      const policy = spec.grantPolicy!;
      if (!Number.isSafeInteger(policy.grantTtlMs) || policy.grantTtlMs <= 0 ||
          policy.grantTtlMs > MAX_GRANT_TTL_MS) {
        throw new TypeError("A replica grant requires a finite TTL not exceeding seven days.");
      }
      const verified = policy.consentAnchor;
      if (verified !== null && (!Number.isSafeInteger(verified.at) || verified.at < 0 ||
          verified.source === "first_install")) {
        throw new ReplicaStorageError("CONSENT_EXPIRED", "The verified consent anchor is unavailable.");
      }
      const first = recordFirst
        ? await gate.recordFirstInstall(profileDir, identityKeyHash, at)
        : await gate.readFirstInstall(profileDir, identityKeyHash);
      const anchor: ReplicaConsentAnchor | null = verified === null
        ? (first === undefined ? null : { at: first, source: "first_install" })
        : { at: Math.min(verified.at, at), source: verified.source };
      if (anchor === null) return null;
      const deadline = anchor.at + CONSENT_WINDOW_MS;
      if (!Number.isSafeInteger(anchor.at) || anchor.at < 0 || !Number.isSafeInteger(deadline)) {
        throw new ReplicaStorageError("CONSENT_EXPIRED", "The durable consent anchor is invalid.");
      }
      return { at, ttlMs: policy.grantTtlMs, consentDeadline: deadline, consentAnchor: anchor };
    };
    let partitionId: string | undefined;
    const storeGuard: MutationGuard = (section) =>
      guarded(spec.identity.principal, spec.stamp, spec.identity, partitionId, section);
    return guarded(spec.identity.principal, spec.stamp, spec.identity, undefined, async () => {
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
    const createdDevice = spec.device ?? (await loadOrCreateDevice(idDir, profileSection, createDevice, options.dirSync));
    // Device key APIs return a verification-method DID URL. Replica grants
    // use the key's principal DID as their audience and stored device identity.
    const device = { ...createdDevice, did: principalOf(createdDevice.did) };
    const replicaHash = replicaHashOf(spec.prefix, device.did);
    partitionId = `${identityKeyHash}:${replicaHash}`;
    const replicaDir = join(idDir, "replicas", replicaHash);
    const store = await sqlite.SqliteReplicaStore.open(replicaDir, {
      create: true,
      guard: storeGuard,
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
      await retainGrantInstalls(gate, snapshot, identityKeyHash, store);
      if (state.grant !== null || state.pendingGrant !== null) {
        const policy = await resolvePolicy(Date.now(), false);
        if (policy === null) throw gated("gate_unavailable");
        if (state.grant !== null) await store.recomputeGrantInstall(state.grant, policy);
        if (state.pendingGrant !== null) await store.recomputeGrantInstall(state.pendingGrant, policy);
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
      replicaId: replicaHash,
      device,
      store,
      replicaDir,
      replica,
      guard: storeGuard,
      read: (section, withFence) => readGated(spec, partitionId!, store, replicaDir, generation, section, withFence),
      policy: resolvePolicy,
      recordGrantInstall: async (cid, at) =>
        gate.recordGrantInstall(profileDir, await gate.grantInstallHashOf(snapshot.salt, identityKeyHash, cid), at),
      transportFor: options.transportFor,
      dirSync: options.dirSync,
      generation,
      ino,
    });
    });
  }

  async function inspectStatus(spec: KVReplicaSpec, { signal }: { signal: AbortSignal }): Promise<LocalReplicaStatus | undefined> {
    const checkAbort = () => {
      if (signal.aborted) throw signal.reason ?? Object.assign(new Error("Replica status inspection was aborted"), { code: "ABORTED" });
    };
    checkAbort();
    const idDir = partitionDirOf(root, spec.identity);
    if (!(await pathExists(idDir))) return undefined;
    checkAbort();
    const identityFile = join(idDir, "identity.json");
    const storedIdentity = identityRecordOf(await readJsonFile(identityFile));
    if (storedIdentity === undefined || !sameIdentity(storedIdentity, spec.identity)) {
      throw new ReplicaStorageError("STORAGE_ERROR", `The partition at ${idDir} belongs to a different identity or has no identity record.`);
    }
    checkAbort();
    let device = spec.device;
    if (device === undefined) {
      const deviceFile = join(idDir, "device.jwk");
      const storedDevice = await readJsonFile(deviceFile);
      if (storedDevice === undefined) return undefined;
      device = deviceRecordOf(storedDevice);
      if (device === undefined) throw new ReplicaStorageError("STORAGE_ERROR", `The replica device key at ${deviceFile} is unreadable.`);
    }
    checkAbort();
    const replicaDir = join(idDir, "replicas", replicaHashOf(spec.prefix, device.did));
    if (!(await pathExists(replicaDir))) return undefined;
    checkAbort();
    const [replica, sqlite] = (await Promise.all([
      // @ts-ignore — TS2307 when replica's dist is absent (CI builds node-sdk first).
      import("@tinycloud/replica"),
      // @ts-ignore — same as above.
      import("@tinycloud/replica/sqlite"),
    ])) as [ReplicaRuntime, SqliteRuntime];
    checkAbort();
    const syncedThroughEpoch = await readFence(replicaDir);
    checkAbort();
    const inspected = await sqlite.SqliteReplicaStore.inspect(replicaDir, { signal });
    checkAbort();
    if (inspected === null) return undefined;
    const { state, status } = inspected;
    if (state.config.host !== spec.identity.host || state.config.space !== spec.space || state.config.prefix !== spec.prefix || principalOf(state.config.deviceDid) !== principalOf(device.did)) {
      throw new ReplicaStorageError("STORAGE_ERROR", `The replica at ${replicaDir} does not match the requested identity, space, prefix, or device.`);
    }
    checkAbort();
    return {
      coverage: status.coverage,
      lastSyncAt: status.lastSyncAt,
      syncedThroughEpoch,
      authority: state.grant !== null && (inspected.activeGrantInstall === null ||
          Date.now() >= inspected.activeGrantInstall.effectiveExpiresAt)
        ? { state: "expired", expiresAt: inspected.activeGrantInstall === null
          ? null : new Date(inspected.activeGrantInstall.effectiveExpiresAt).toISOString() }
        : { state: status.authority.state, expiresAt: status.authority.expiresAt },
      grant: newestGrantInfo(replica, state.pendingGrant ?? state.grant, state.pendingGrant, spec, inspected.grantInstall),
      counts: status.counts,
      bytes: status.bytes,
      lastError: status.lastError,
    };
  }

  async function purgePartition(target: PurgeTarget): Promise<void> {
    // Literal specifiers, as in openHandle, so bundlers follow the dependency.
    const [replica, sqlite] = (await Promise.all([
      // @ts-ignore — TS2307 when replica's dist is absent (CI builds node-sdk first).
      import("@tinycloud/replica"),
      // @ts-ignore — same as above.
      import("@tinycloud/replica/sqlite"),
    ])) as [ReplicaRuntime, SqliteRuntime];
    return profileSection(async () => {
    const idDir = partitionDirOf(root, target.identity);
    if (!(await realDirectoryExists(idDir))) return;
    const hasReplicas = await realDirectoryExists(join(idDir, "replicas"));
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
      if (!hasReplicas || !(await realDirectoryExists(replicaDir))) continue;
      try {
        let store: SqliteReplicaStore;
        try {
          store = await sqlite.SqliteReplicaStore.open(replicaDir, { create: false, guard: profileSection });
        } catch (error) {
          if (replica.isReplicaError(error, replica.ReplicaErrorCode.NOT_FOUND)) {
            // A leftover directory without a database is removed nonrecursively.
            await profileSection(() => removeLeftoverReplicaDir(replicaDir));
            continue;
          }
          throw error;
        }
        try {
          const state = await store.open();
          if (state === null) {
            await store.close().catch(() => undefined);
            await profileSection(() => removeLeftoverReplicaDir(replicaDir));
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
            const gate = await fileGate();
            const currentGate = await gate.readGateSnapshot(profileDir);
            if (currentGate !== undefined && currentGate.principalHash !== null &&
                currentGate.principalHash === await gate.principalHashOf(currentGate.salt, target.identity.principal)) {
              const identityKeyHash = await gate.identityHashOf(currentGate.salt, replicationIdentityKey(target.identity));
              await retainGrantInstalls(gate, currentGate, identityKeyHash, store);
            }
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
    });
  }

  return {
    kind: "sqlite",
    lifecycle,
    open: openHandle,
    inspectStatus,
    purge: purgePartition,
    // File-backed pending writes are always bound to a stamped gate.
    pendingWrites(identity: ReplicationIdentity, opts?: { stamp?: ReplicaSessionStamp }): PendingWriteStore {
      return new FilePendingWriteStore(
        identity,
        partitionDirOf(root, identity),
        profileDir,
        guard,
        opts?.stamp,
        options.dirSync,
      );
    },
  };
}

/** CLI-facing profile lifecycle; callers supply their existing nonreentrant profile lock. */
export function createProfileReplicaPurge(options: {
  profileDir: string;
  guard: MutationGuard;
}): ProfileReplicaPurge {
  return createSqliteReplicaStorage({
    dir: join(options.profileDir, "replication"),
    guard: options.guard,
  }).lifecycle;
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
  gateFile?: string;
}): KVReplicaStorage {
  return createSqliteReplicaStorage(options);
}
