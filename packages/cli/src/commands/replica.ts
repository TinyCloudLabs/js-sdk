import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { randomBytes } from "node:crypto";
import { constants as fsConstants, lstatSync } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink, lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { withPinnedReplicaForReset } from "../lib/profile-replicas.js";
import { createReplicationReport, renderReplicationReport, type ReplicationPartitionSummary } from "../lib/replication-report.js";
import { parseDuration } from "../lib/duration.js";
import {
  ProfileSymlinkError,
  ProfileDeletedError,
  profilePath,
  readAdditionalDelegations,
  readSession,
  withProfileLock,
  withPinnedProfileDirectory,
} from "@tinycloud/operations/state";
import { ownerSessionLacksProof } from "@tinycloud/operations/profile";
import type { ReplicationEvent } from "@tinycloud/node-sdk";
import {
  assertFolderPrefix,
  Replica,
  ReplicaError,
  ReplicaErrorCode,
  assertGrantInstallable,
  isReplicaError,
  kvSyncTransport,
  parseUcanGrant,
  requiresSecretsOptIn,
  syncGrantSpaces,
  type GrantRecord,
  type KVSyncClient,
  type ParsedUcanGrant,
  type ReplicaConfig,
  type ReplicaTransport,
  type ReplicaReadResult,
  type ReplicaStatus,
} from "@tinycloud/replica";
import { SqliteReplicaStore, loadSqlite, type MutationGuard } from "@tinycloud/replica/sqlite";

import { ProfileManager } from "../config/profiles.js";
import { DEFAULT_PROFILE, ExitCode } from "../config/constants.js";
import { CLIError, handleError } from "../output/errors.js";
import { formatBytes, formatField, formatTable, outputJson, shouldOutputJson } from "../output/formatter.js";
import { theme } from "../output/theme.js";

/** Replica error → exit code. Mirrors `ExitCode`; see `tc replica --help`. */
const EXIT_BY_CODE: Record<ReplicaErrorCode, number> = {
  [ReplicaErrorCode.INVALID_ARGUMENT]: ExitCode.USAGE_ERROR,
  [ReplicaErrorCode.CLOSED]: ExitCode.ERROR,
  [ReplicaErrorCode.BUSY]: ExitCode.ERROR,
  [ReplicaErrorCode.RUNTIME_UNSUPPORTED]: ExitCode.ERROR,
  [ReplicaErrorCode.STORAGE_ERROR]: ExitCode.ERROR,
  [ReplicaErrorCode.STORAGE_FULL]: ExitCode.STORAGE_FULL,
  [ReplicaErrorCode.NOT_FOUND]: ExitCode.NOT_FOUND,
  [ReplicaErrorCode.CONFIG_MISMATCH]: ExitCode.USAGE_ERROR,
  [ReplicaErrorCode.NOT_COVERED]: ExitCode.USAGE_ERROR,
  [ReplicaErrorCode.SECRETS_OPT_IN_REQUIRED]: ExitCode.USAGE_ERROR,
  [ReplicaErrorCode.GRANT_MISSING]: ExitCode.AUTH_REQUIRED,
  [ReplicaErrorCode.GRANT_INVALID]: ExitCode.AUTH_REQUIRED,
  [ReplicaErrorCode.GRANT_FORMAT_UNSUPPORTED]: ExitCode.AUTH_REQUIRED,
  [ReplicaErrorCode.GRANT_AUDIENCE_MISMATCH]: ExitCode.AUTH_REQUIRED,
  [ReplicaErrorCode.GRANT_NOT_COVERING]: ExitCode.AUTH_REQUIRED,
  [ReplicaErrorCode.GRANT_NOT_YET_VALID]: ExitCode.PERMISSION_DENIED,
  [ReplicaErrorCode.GRANT_EXPIRED]: ExitCode.PERMISSION_DENIED,
  [ReplicaErrorCode.GRANT_REVOKED]: ExitCode.PERMISSION_DENIED,
  [ReplicaErrorCode.GRANT_UNAUTHORIZED]: ExitCode.PERMISSION_DENIED,
  [ReplicaErrorCode.RETENTION_GRANT_REFUSED]: ExitCode.PERMISSION_DENIED,
  [ReplicaErrorCode.NETWORK_ERROR]: ExitCode.NETWORK_ERROR,
  [ReplicaErrorCode.NODE_ERROR]: ExitCode.NODE_ERROR,
  [ReplicaErrorCode.PROTOCOL_ERROR]: ExitCode.NODE_ERROR,
  [ReplicaErrorCode.RESET_REQUIRED]: ExitCode.NODE_ERROR,
  [ReplicaErrorCode.REPLICATION_ROOT_UNSUPPORTED]: ExitCode.NODE_ERROR,
  [ReplicaErrorCode.SOURCE_CHANGED]: ExitCode.NODE_ERROR,
  [ReplicaErrorCode.SCOPE_VIOLATION]: ExitCode.NODE_ERROR,
  [ReplicaErrorCode.CONTENT_MISMATCH]: ExitCode.NODE_ERROR,
  [ReplicaErrorCode.INTEGRITY_ERROR]: ExitCode.NODE_ERROR,
};

/** Non-present local reads: code and exit status. */
const READ_FAILURE: Record<Exclude<ReplicaReadResult["status"], "present">, { code: string; exit: number; what: string }> = {
  absent: { code: "KEY_ABSENT", exit: ExitCode.NOT_FOUND, what: "is not in the replica (the replica covers its whole prefix)" },
  deleted: { code: "KEY_DELETED", exit: ExitCode.NOT_FOUND, what: "was deleted at the source" },
  content_missing: { code: "CONTENT_MISSING", exit: ExitCode.NOT_FOUND, what: `is known but its content has not been fetched yet; run ${CLI_NAME} replica sync` },
  coverage_incomplete: {
    code: "COVERAGE_INCOMPLETE",
    exit: ExitCode.NOT_FOUND,
    what: `is not in the replica, which has not finished its first sync; run ${CLI_NAME} replica sync`,
  },
  not_covered: { code: "NOT_COVERED", exit: ExitCode.USAGE_ERROR, what: "is outside the replica's prefix" },
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function toCliError(error: unknown): unknown {
  if (!isReplicaError(error)) return error;
  const hint = error.code === ReplicaErrorCode.GRANT_MISSING && typeof error.detail?.hint === "string" ? error.detail.hint : undefined;
  return new CLIError(error.code, error.message, EXIT_BY_CODE[error.code], hint === undefined ? undefined : { hint });
}

async function run(action: () => Promise<void>, needsSqlite = true): Promise<void> {
  try {
    if (needsSqlite) await loadSqlite();
    await action();
  } catch (error) {
    return handleError(toCliError(error));
  }
}

/** The profile name, from flags, env and the local config only (no host discovery). */
async function profileName(cmd: Command): Promise<string> {
  const globals = cmd.optsWithGlobals() as { profile?: string };
  if (globals.profile) return globals.profile;
  if (process.env.TC_PROFILE) return process.env.TC_PROFILE;
  const config = await ProfileManager.getConfig().catch(() => undefined);
  return config?.defaultProfile ?? DEFAULT_PROFILE;
}

async function replicaNames(profile: string): Promise<string[]> {
  return await withReplicaRoot(profile, async (root) => {
    const names: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw localPathChanged(profile);
      if (!NAME.test(entry.name) || !entry.isDirectory()) continue;
      const present = await withPinnedLocalDirectory(profile, root, entry.name, async (directory) => {
        const database = await lstat(join(directory, "replica.db"), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (database && (database.isSymbolicLink() || !database.isFile())) throw localPathChanged(profile);
        return database !== null;
      });
      if (present === null) throw localPathChanged(profile);
      if (present) names.push(entry.name);
    }
    return names.sort();
  }) ?? [];
}

function assertName(name: string): string {
  if (!NAME.test(name)) {
    throw new CLIError("USAGE_ERROR", `Replica names use letters, digits, '.', '_' and '-' (got ${JSON.stringify(name)}).`, ExitCode.USAGE_ERROR);
  }
  return name;
}

/** The profile pin is held by the caller's lock or command. Child pins outlive every SQLite use. */
async function withReplicaRoot<T>(
  profile: string,
  action: (root: string, recheckRoot: () => Promise<void>, recheckProfile?: () => Promise<void>) => Promise<T>,
  create = false,
): Promise<T | null> {
  const profileDirectory = profilePath(profile);
  const readRoot = async (directory: string, recheckProfile?: () => Promise<void>): Promise<T | null> => {
    if (create) {
      if (recheckProfile) await recheckProfile();
      await mkdir(join(directory, "replicas"), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    return withPinnedLocalDirectory(profile, directory, "replicas",
      (root, _named, _identity, recheckRoot) => action(root, recheckRoot, recheckProfile));
  };
  if (process.platform === "linux") return readRoot(profileDirectory);
  const checked = await withPinnedLocalDirectory(profile, dirname(profileDirectory), basename(profileDirectory),
    (directory, _named, _identity, recheckProfile) => readRoot(directory, recheckProfile));
  if (checked === null) throw localPathChanged(profile);
  return checked;
}

async function withReplicaDirectory<T>(
  profile: string,
  name: string,
  action: (path: string, expectedDirectory: { dev: number; ino: number }) => Promise<T>,
  create = false,
): Promise<T> {
  assertName(name);
  const result = await withReplicaRoot(profile, async (root, recheckRoot, recheckProfile) => {
    if (create) {
      await recheckRoot();
      await mkdir(join(root, name), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    const opened = await withPinnedLocalDirectory(profile, root, name,
      async (_directory, path, expectedDirectory, recheckChild) => {
        await recheckRoot();
        await recheckChild();
        const database = await lstat(join(_directory, "replica.db"), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (database && (database.isSymbolicLink() || !database.isFile())) throw localPathChanged(profile);
        // Named-path platforms must recheck every ancestor after the leaf
        // inspection and immediately before SQLite can open or migrate it.
        if (recheckProfile) {
          await recheckProfile();
          await recheckRoot();
          await recheckChild();
        }
        return action(path, expectedDirectory);
      });
    if (opened === null) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, `Replica "${name}" was not found.`);
    return opened;
  }, create);
  if (result === null) throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, `Profile "${profile}" has no replicas.`);
  return result;
}

/** `--replica`, or the profile's only replica. */
async function existingReplicaName(profile: string, option: string | undefined): Promise<string> {
  if (option !== undefined) return assertName(option);
  const names = await replicaNames(profile);
  if (names.length === 1) return names[0]!;
  if (names.length === 0) {
    throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, `Profile "${profile}" has no replicas. Create one with: ${CLI_NAME} replica sync --prefix <prefix>`);
  }
  throw new CLIError("USAGE_ERROR", `Profile "${profile}" has several replicas (${names.join(", ")}); pass --replica <name>.`, ExitCode.USAGE_ERROR);
}

/**
 * Every mutation of a replica (database write or file change) runs briefly
 * under the profile lock, taken only while the profile exists: the lock
 * never recreates a deleted profile, and nothing is written into one. Never
 * held across network calls.
 */
export function profileGuard(profile: string): MutationGuard {
  return async (section) => {
    try {
      return await withProfileLock(profile, section, { requireProfile: true });
    } catch (error) {
      if (error instanceof ProfileDeletedError) {
        throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, `Profile "${profile}" was deleted; its replicas are gone and nothing was written.`);
      }
      throw error;
    }
  };
}

async function withOpenReplica<T>(
  profile: string,
  name: string,
  action: (store: SqliteReplicaStore) => Promise<T>,
  guard: MutationGuard = profileGuard(profile),
): Promise<T> {
  return withReplicaDirectory(profile, name, async (path, expectedDirectory) => {
    const store = await SqliteReplicaStore.open(path, { create: false, guard, expectedDirectory });
    try {
      return await action(store);
    } finally {
      await store.close();
    }
  });
}

/** The marker is durable until recovery finishes; local reads never infer clearance from session state. */
function assertLegacyLogoutClear(profile: string): void {
  try {
    lstatSync(join(profilePath(profile), "replica-logout-pending.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
  }
  throw new CLIError(
    "REPLICA_GATED",
    "A logout is pending or its state cannot be checked for this profile.",
    ExitCode.PERMISSION_DENIED,
  );
}

/** Keep the selected profile pinned and its read and output serialized with logout. */
async function withLegacyReplicaRead(profile: string, action: (checkDelivery: () => Promise<void>) => Promise<void>): Promise<void> {
  await withProfileLock(profile, async () => {
    const checkDelivery = async () => { assertLegacyLogoutClear(profile); };
    await checkDelivery();
    await action(checkDelivery);
  }, { requireProfile: true });
}

/**
 * Construct a test replica under the profile guard. Its descriptor-relative
 * path expires when this helper returns; command handlers keep the store
 * inside withReplicaDirectory for every SQLite use.
 */
export async function createReplica(profile: string, config: ReplicaConfig): Promise<SqliteReplicaStore> {
  const guard = profileGuard(profile);
  return guard(() => withReplicaDirectory(profile, config.name, async (path, expectedDirectory) => {
    const store = await SqliteReplicaStore.open(path, { create: true, guard, expectedDirectory });
    try {
      if ((await store.open()) === null) await store.init(config);
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }, true));
}

/**
 * The compact JWTs this profile holds: its session and every imported
 * delegation. An unverified OpenKey owner session is refused everywhere
 * (TC-1053), so it never backs a replica either.
 */
async function storedGrants(profile: string): Promise<ParsedUcanGrant[]> {
  const authorizations: string[] = [];
  const session = await readSession<{ delegationHeader?: { Authorization?: unknown }; siwe?: unknown; signature?: unknown }>(profile).catch(() => null);
  const config = await ProfileManager.getProfile(profile).catch(() => null);
  if (typeof session?.delegationHeader?.Authorization === "string" && !ownerSessionLacksProof(session, config)) {
    authorizations.push(session.delegationHeader.Authorization);
  }
  const records = await readAdditionalDelegations<{ delegation?: { delegationHeader?: { Authorization?: unknown } } }>(profile).catch(
    () => [],
  );
  for (const record of records) {
    const authorization = record.delegation?.delegationHeader?.Authorization;
    if (typeof authorization === "string") authorizations.push(authorization);
  }
  const grants: ParsedUcanGrant[] = [];
  const seen = new Set<string>();
  for (const authorization of authorizations) {
    let grant: ParsedUcanGrant;
    try {
      grant = parseUcanGrant(authorization);
    } catch {
      continue; // SIWE sessions and other non-UCAN grants cannot back a replica.
    }
    if (seen.has(grant.cid)) continue;
    seen.add(grant.cid);
    grants.push(grant);
  }
  return grants;
}

function grantHint(space: string, prefix: string): string {
  return [
    "A replica needs a device grant with get and sync on its prefix:",
    `  device: ${CLI_NAME} auth request --cap tinycloud.kv:${space}:${prefix}:get,list,metadata,sync --expiry 30d --emit req.json`,
    `  owner:  ${CLI_NAME} auth grant req.json > grant.json`,
    `  device: ${CLI_NAME} auth import grant.json`,
  ].join("\n");
}

/** The space a short name or full id names among the grants that carry sync. */
function resolveSpace(input: string | undefined, prefix: string, grants: ParsedUcanGrant[]): string {
  if (input?.startsWith("tinycloud:")) return input;
  const candidates = new Set<string>();
  for (const grant of grants) {
    for (const space of syncGrantSpaces(grant)) {
      if (input !== undefined && !space.endsWith(`:${input}`)) continue;
      candidates.add(space);
    }
  }
  if (candidates.size === 1) return [...candidates][0]!;
  if (candidates.size === 0) {
    throw new ReplicaError(
      ReplicaErrorCode.GRANT_MISSING,
      input === undefined
        ? `No imported grant carries tinycloud.kv/sync; pass --space with the full space id or import a device grant.`
        : `No imported grant carries tinycloud.kv/sync on a space named ${JSON.stringify(input)}; pass the full space id.`,
      { hint: grantHint(input ?? "<space>", prefix) },
    );
  }
  throw new CLIError(
    "USAGE_ERROR",
    `Several spaces have sync grants (${[...candidates].join(", ")}); pass --space with the full space id.`,
    ExitCode.USAGE_ERROR,
  );
}

/** The newest-expiring grant this device holds that covers sync + get on the prefix. */
function chooseGrant(grants: ParsedUcanGrant[], deviceDid: string, space: string, prefix: string): ParsedUcanGrant {
  const now = Date.now();
  const usable = grants.filter((grant) => {
    try {
      assertGrantInstallable(grant, { deviceDid, space, prefix, now });
      return true;
    } catch {
      return false;
    }
  });
  usable.sort((a, b) => (b.expiresAt ?? Number.MAX_SAFE_INTEGER) - (a.expiresAt ?? Number.MAX_SAFE_INTEGER));
  const best = usable[0];
  if (best === undefined) {
    throw new ReplicaError(
      ReplicaErrorCode.GRANT_MISSING,
      `This device (${deviceDid}) holds no unexpired grant with tinycloud.kv/sync and tinycloud.kv/get on ${space}/kv/${prefix}.`,
      { hint: grantHint(space, prefix) },
    );
  }
  return best;
}

/**
 * Transports that each invoke with exactly one grant and the device key,
 * against the pinned host: the engine tries a pending grant and can fall
 * back to the active one.
 */
async function grantTransports(input: { host: string; space: string; deviceDid: string; jwk: object }) {
  const [{ KVService, ServiceContext }, wasm] = await Promise.all([import("@tinycloud/sdk-core"), import("@tinycloud/node-sdk-wasm")]);
  return (grant: GrantRecord): ReplicaTransport => {
    const context = new ServiceContext({
      invoke: wasm.invoke,
      invokeAny: wasm.invokeAny,
      fetch: globalThis.fetch.bind(globalThis),
      hosts: [input.host],
    });
    const kv = new KVService({});
    kv.initialize(context);
    context.registerService("kv", kv);
    context.setSession({
      delegationHeader: { Authorization: new TextDecoder().decode(grant.bytes) },
      delegationCid: grant.cid,
      spaceId: input.space,
      verificationMethod: input.deviceDid,
      jwk: input.jwk,
    });
    const client: KVSyncClient = kv;
    return kvSyncTransport(client);
  };
}

function syncOptionsDiffer(
  stored: { space: string; prefix: string; host: string },
  requested: { space?: string; prefix?: string; host?: string },
): string | undefined {
  if (requested.prefix !== undefined && requested.prefix !== stored.prefix) return `prefix ${stored.prefix}`;
  if (requested.host !== undefined && requested.host.replace(/\/+$/, "") !== stored.host) return `host ${stored.host}`;
  if (requested.space !== undefined && requested.space !== stored.space && !stored.space.endsWith(`:${requested.space}`)) {
    return `space ${stored.space}`;
  }
  return undefined;
}

function describeStatus(status: ReplicaStatus): string {
  return [
    theme.heading(`Replica ${status.name}`),
    formatField("Source", `${status.source.host} ${status.source.space}/kv/${status.source.prefix}`),
    formatField("Node", status.source.nodeDid),
    formatField("Authority", `${status.authority.state}${status.authority.expiresAt ? ` (expires ${status.authority.expiresAt})` : ""}`),
    formatField("Retain until", status.authority.retainUntil),
    formatField("Coverage", status.coverage),
    formatField("Last sync", status.lastSyncAt),
    formatField("Keys", `${status.counts.keys} (${status.counts.contentMissing} content missing, ${status.counts.tombstones} deleted)`),
    formatField("Size", formatBytes(status.bytes)),
    formatField("Grant", status.device.delegationCid),
    formatField("Last error", status.lastError ? `${status.lastError.code}: ${status.lastError.message}` : null),
    formatField("Purge", status.purgePending ? `incomplete: content files remain; the next ${CLI_NAME} replica command retries` : null),
  ].join("\n");
}

/** Write `bytes` to `path` atomically (temp + fsync + rename), mode 0600. */
async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const target = resolve(path);
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function jsonValue(bytes: Uint8Array): { value: string; encoding: "utf8" | "base64" } {
  try {
    return { value: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf8" };
  } catch {
    return { value: Buffer.from(bytes).toString("base64"), encoding: "base64" };
  }
}
export function replicaSecretsWarning(space: string, prefix: string, secretsAllowed: boolean): string | undefined {
  if (!secretsAllowed || !requiresSecretsOptIn(space, prefix)) return undefined;
  return `This replica stores the ciphertext of every secret under "${prefix}". A tinycloud.encryption/decrypt grant covers the whole encryption network, not one secret (TC-755), so whoever holds decrypt can open every replicated secret.`;
}

type LocalEntryIdentity = {
  dev: number | bigint;
  ino: number | bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

function localFileId(value: number | bigint): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

function sameLocalEntry(left: LocalEntryIdentity, right: LocalEntryIdentity): boolean {
  const dev = localFileId(left.dev);
  const ino = localFileId(left.ino);
  return dev !== null && ino !== null && dev === localFileId(right.dev) && ino === localFileId(right.ino);
}

function localPathChanged(profile: string): ProfileSymlinkError {
  return new ProfileSymlinkError(profile, "its local replica files contain a symlink or changed while reading");
}

async function assertNamedLocalEntry(
  profile: string,
  path: string,
  expected: LocalEntryIdentity,
  kind: "directory" | "file",
): Promise<void> {
  const current = await lstat(path, { bigint: true }).catch(() => null);
  if (!current || current.isSymbolicLink() ||
      (kind === "directory" ? !current.isDirectory() : !current.isFile()) ||
      !sameLocalEntry(expected, current)) throw localPathChanged(profile);
}

/** Hold each directory descriptor until its callback finishes; no child follows a named parent alias. */
async function withPinnedLocalDirectory<T>(
  profile: string,
  parent: string,
  name: string,
  action: (directory: string, named: string, identity: { dev: number; ino: number }, recheck: () => Promise<void>) => Promise<T>,
): Promise<T | null> {
  const path = join(parent, name);
  const before = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!before) return null;
  if (before.isSymbolicLink() || !before.isDirectory()) throw localPathChanged(profile);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ELOOP" || error.code === "ENOTDIR" || error.code === "ENOENT") throw localPathChanged(profile);
      throw error;
    });
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameLocalEntry(before, opened)) throw localPathChanged(profile);
    const dev = localFileId(opened.dev);
    const ino = localFileId(opened.ino);
    if (dev === null || ino === null || dev > BigInt(Number.MAX_SAFE_INTEGER) || ino > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw localPathChanged(profile);
    }
    const pinned = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path;
    const recheck = () => assertNamedLocalEntry(profile, path, opened, "directory");
    const result = await action(pinned, path, { dev: Number(dev), ino: Number(ino) }, recheck);
    await recheck();
    return result;
  } finally {
    await handle.close();
  }
}

async function readReportFile(profile: string, parent: string, name: string): Promise<string | null> {
  const path = join(parent, name);
  const before = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!before) return null;
  if (before.isSymbolicLink() || !before.isFile()) throw localPathChanged(profile);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ELOOP" || error.code === "ENOTDIR" || error.code === "ENOENT") throw localPathChanged(profile);
      throw error;
    });
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameLocalEntry(before, opened)) throw localPathChanged(profile);
    const data = await handle.readFile("utf8");
    await assertNamedLocalEntry(profile, path, opened, "file");
    return data;
  } finally {
    await handle.close();
  }
}

async function readReportJson<T>(profile: string, parent: string, name: string): Promise<T | null> {
  const data = await readReportFile(profile, parent, name);
  if (data === null) return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

async function readReplicationEvents(profile: string, root: string, sinceMs: number): Promise<ReplicationEvent[]> {
  const events: ReplicationEvent[] = [];
  for (const name of ["events.jsonl.1", "events.jsonl"]) {
    const data = await readReportFile(profile, root, name) ?? "";
    for (const line of data.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as ReplicationEvent;
        if (Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) >= sinceMs) events.push(event);
      } catch {
        // A truncated final line is ignored; later appends remain usable.
      }
    }
  }
  return events;
}

async function replicationPartitions(profile: string, root: string): Promise<ReplicationPartitionSummary[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const partitions: ReplicationPartitionSummary[] = [];
  for (const entry of entries) {
    if (!/^[a-z2-7]{26}$/.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw localPathChanged(profile);
    if (!entry.isDirectory()) continue;
    const partition = await withPinnedLocalDirectory(profile, root, entry.name, async (pinned) => {
      const identity = await readReportJson<{ host?: unknown; space?: unknown }>(profile, pinned, "identity.json");
      const pending = await readReportJson<{ records?: Array<{ state?: string }> }>(profile, pinned, "pending.json");
      const pinnedCount = pending?.records?.filter((record) => record.state === "in_flight" || record.state === "ambiguous").length ?? 0;
      return {
        idHash: entry.name,
        host: typeof identity?.host === "string" ? identity.host : null,
        space: typeof identity?.space === "string" ? identity.space : null,
        pinned: pinnedCount,
      };
    });
    if (!partition) throw localPathChanged(profile);
    partitions.push(partition);
  }
  return partitions.sort((left, right) => left.idHash.localeCompare(right.idHash));
}

export function registerReplicaCommand(program: Command): void {
  const replica = program
    .command("replica")
    .description("Durable read-only local replicas of a KV prefix (sync online, read offline) [beta]")
    .addHelpText(
      "after",
      `
Local replicas are a beta feature: commands, output and on-disk format may change in a minor release.

A replica keeps the latest state of one KV prefix on this device. \`sync\` pulls
the tinycloud.kv/sync feed from the replica's pinned host under a device grant;
\`get\`, \`list\`, \`status\` and \`reset\` never touch the network.

Exit codes: 0 ok; 1 busy, runtime or storage error; 2 usage, NOT_COVERED,
SECRETS_OPT_IN_REQUIRED; 3 grant missing; 4 key absent, deleted, content missing
or coverage incomplete; 5 grant expired, revoked or not yet valid; 6 network;
7 node, protocol or integrity error; 10 storage full.`,
    );
  replica
    .command("report")
    .description("Read-only report of persisted replication events and identity partitions")
    .option("--since <duration>", "Include events from the last duration (default: 24h)", "24h")
    .option("--purge", "Refused: named replica reset --replica <name> --purge only; flag-owned purge unavailable (TC-1309)")
    .option("--clear-pending", "Refused: no equivalent pending-clear command yet (TC-1309)")
    .action((options, cmd: Command) =>
      run(async () => {
        const profile = await profileName(cmd);
        if (options.purge) {
          throw new CLIError("REPORT_READ_ONLY", `Replica report is read-only. To remove a named local replica, run ${CLI_NAME} replica reset --replica <name> --purge; flag-owned purge has no equivalent yet (TC-1309).`, ExitCode.USAGE_ERROR);
        }
        if (options.clearPending) {
          throw new CLIError("REPORT_READ_ONLY", "Clearing pending replica writes has no equivalent yet; see TC-1309 for a safe replacement command.", ExitCode.USAGE_ERROR);
        }
        let durationMs: number;
        try {
          durationMs = parseDuration(options.since);
        } catch (error) {
          throw new CLIError("USAGE_ERROR", error instanceof Error ? error.message : String(error), ExitCode.USAGE_ERROR);
        }
        const report = await withPinnedProfileDirectory(profile, async (directory) => {
          if (directory === null) throw new CLIError("PROFILE_NOT_FOUND", `Profile "${profile}" does not exist.`, ExitCode.ERROR);
          const readPersistedReport = async (root: string) => {
            await replicaNames(profile);
            const sinceMs = Date.now() - durationMs;
            const persisted = await withPinnedLocalDirectory(profile, root, "replication", async (directory) => ({
              events: await readReplicationEvents(profile, directory, sinceMs),
              partitions: await replicationPartitions(profile, directory),
            }));
            return createReplicationReport(options.since, persisted?.events ?? [], persisted?.partitions ?? []);
          };
          if (process.platform === "linux") return readPersistedReport(directory);
          const checked = await withPinnedLocalDirectory(profile, dirname(directory), basename(directory), readPersistedReport);
          if (checked === null) throw localPathChanged(profile);
          return checked;
        });
        if (shouldOutputJson()) outputJson(report);
        else process.stdout.write(`${renderReplicationReport(report)}\n`);
      }, false),
    );

  replica
    .command("sync")
    .description("Create or update a replica from its source host")
    .option("--replica <name>", "Replica name (default: the profile's only replica, or one named after the prefix)")
    .option("--space <id|name>", "Space to replicate (first sync; default: the space of the sync grant)")
    .option("--prefix <prefix>", "KV prefix to replicate, e.g. notes/ (first sync)")
    .option("--retention-grant <cid>", "CID of a tinycloud.kv/retain grant: keep local reads after the sync grant expires")
    .option("--limit <n>", "Feed page size (1-1000)", (value) => Number.parseInt(value, 10))
    .option("--allow-secrets", "Opt in to copying ciphertext from a secrets space, vault prefix, or whole space")
    .action((options, cmd: Command) =>
      run(async () => {
        const profile = await profileName(cmd);
        if (options.prefix !== undefined) {
          try {
            assertFolderPrefix(options.prefix);
          } catch (error) {
            throw new CLIError("INVALID_REPLICATION_PREFIX", error instanceof Error ? error.message : String(error), ExitCode.USAGE_ERROR);
          }
        }
        await withPinnedProfileDirectory(profile, async (directory) => {
          if (directory === null) throw new CLIError("PROFILE_NOT_FOUND", `Profile "${profile}" does not exist.`, ExitCode.ERROR);
          const globals = cmd.optsWithGlobals() as { host?: string };
          const config = await ProfileManager.getProfile(profile);
          const deviceDid = config.sessionDid ?? config.did;
          const jwk = await ProfileManager.getKey(profile);
          if (jwk === null) {
            throw new CLIError("AUTH_REQUIRED", `Profile "${profile}" has no device key.`, ExitCode.AUTH_REQUIRED);
          }
          if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)) {
            throw new CLIError("USAGE_ERROR", "--limit must be an integer from 1 through 1000.", ExitCode.USAGE_ERROR);
          }
          const existing = await replicaNames(profile);
          const name: string =
            options.replica !== undefined
              ? assertName(options.replica)
              : options.prefix !== undefined
                ? assertName(options.prefix.replace(/\/+$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "default")
                : await existingReplicaName(profile, undefined);
          const grants = await storedGrants(profile);
          const initialConfig: ReplicaConfig | null = existing.includes(name) ? null : (() => {
            const prefix: string | undefined = options.prefix;
            if (prefix === undefined) {
              throw new CLIError("USAGE_ERROR", "The first sync of a replica needs --prefix (and a device grant covering it).", ExitCode.USAGE_ERROR);
            }
            const space = resolveSpace(options.space, prefix, grants);
            if (requiresSecretsOptIn(space, prefix) && options.allowSecrets !== true) {
              throw new ReplicaError(
                ReplicaErrorCode.SECRETS_OPT_IN_REQUIRED,
                `Replicating ${space}/kv/${prefix} copies encrypted secret material to this disk; pass --allow-secrets to opt in.`,
              );
            }
            const host = (globals.host ?? process.env.TC_HOST ?? config.host)?.replace(/\/+$/, "");
            if (!host) throw new CLIError("USAGE_ERROR", "Pass --host: the profile has no host to pin.", ExitCode.USAGE_ERROR);
            // Choose the grant before creating any directory or database.
            chooseGrant(grants, deviceDid, space, prefix);
            return {
              name,
              replicaId: randomBytes(16).toString("hex"),
              host,
              space,
              prefix,
              deviceDid,
              allowSecrets: options.allowSecrets === true,
              localReadPolicy: "whileGrantValid",
              retentionGrantCid: null,
            };
          })();
          const { replica, report, status, warning } = await withReplicaDirectory(profile, name, async (path, expectedDirectory) => {
            const store = await SqliteReplicaStore.open(path, {
              create: initialConfig !== null, guard: profileGuard(profile), expectedDirectory,
            });
            try {
              if (initialConfig !== null && (await store.open()) === null) await store.init(initialConfig);
              const state = (await store.open())!;
              if (initialConfig === null) {
                const differs = syncOptionsDiffer(state.config, {
                  ...(options.space === undefined ? {} : { space: options.space }),
                  ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
                  ...(globals.host === undefined ? {} : { host: globals.host }),
                });
                if (differs !== undefined) {
                  throw new ReplicaError(
                    ReplicaErrorCode.CONFIG_MISMATCH,
                    `Replica ${name} already follows ${differs}. Use another --replica name, or ${CLI_NAME} replica reset --replica ${name} --purge first.`,
                  );
                }
              }
              const { space, prefix, host } = state.config;
              if (requiresSecretsOptIn(space, prefix) && !state.config.allowSecrets && options.allowSecrets !== true) {
                throw new ReplicaError(ReplicaErrorCode.SECRETS_OPT_IN_REQUIRED, `Replicating ${space}/kv/${prefix} needs --allow-secrets.`);
              }
              let grant: ParsedUcanGrant | undefined;
              try {
                grant = chooseGrant(grants, state.config.deviceDid, space, prefix);
              } catch (error) {
                // An expired stored grant is the engine's call (GRANT_EXPIRED), not a missing one.
                if (!isReplicaError(error, ReplicaErrorCode.GRANT_MISSING) || (state.grant ?? state.pendingGrant) === null) throw error;
              }
              if (grant !== undefined) await store.installGrant(grant);
              if (options.retentionGrant !== undefined && options.retentionGrant !== state.config.retentionGrantCid) {
                await store.setRetentionGrant(options.retentionGrant === "" ? null : options.retentionGrant);
              }
              const current = (await store.open())!;
              const transportFor = await grantTransports({ host, space, deviceDid: current.config.deviceDid, jwk });
              const warning = replicaSecretsWarning(space, prefix, options.allowSecrets === true || state.config.allowSecrets);
              const report = await new Replica({ store, transportFor }).sync(options.limit === undefined ? {} : { limit: options.limit });
              const status = await store.status();
              return { replica: current.config.name, report, status, warning };
            } finally {
              await store.close();
            }
          }, initialConfig !== null);
          if (warning !== undefined) process.stderr.write(`Warning: ${warning}\n`);
          if (shouldOutputJson()) {
            outputJson({ replica, sync: report, status, ...(warning === undefined ? {} : { warning }) });
          } else {
            process.stdout.write(
              `${theme.success("✓")} Synced ${report.changes} change(s) in ${report.pages} page(s), fetched ${report.fetched} value(s).\n${describeStatus(status)}\n`,
            );
          }
        });
      }),
    );

  replica
    .command("get <key>")
    .description("Read a key from the local replica (never touches the network)")
    .option("--replica <name>", "Replica name")
    .option("--raw", "Write the value's bytes to stdout")
    .option("-o, --output <file>", "Write the value to a file (atomically, mode 0600)")
    .option("--no-verify", "Skip re-hashing the stored content")
    .action((key: string, options, cmd: Command) =>
      run(async () => {
        const profile = await profileName(cmd);
        await withLegacyReplicaRead(profile, async (checkDelivery) => {
          const result = await withOpenReplica(profile, await existingReplicaName(profile, options.replica),
            (store) => new Replica({ store }).get(key, { verify: options.verify !== false }));
          await checkDelivery();
          if (result.status !== "present") {
            const failure = READ_FAILURE[result.status];
            throw new CLIError(failure.code, `Key ${JSON.stringify(key)} ${failure.what}.`, failure.exit);
          }
          if (options.output) {
            await writeFileAtomic(options.output, result.value);
            outputJson({ key, written: options.output, etag: result.etag, meta: result.meta });
            return;
          }
          if (options.raw) {
            process.stdout.write(result.value);
            return;
          }
          if (shouldOutputJson()) {
            outputJson({ key, status: result.status, ...jsonValue(result.value), etag: result.etag, metadata: result.metadata, meta: result.meta });
            return;
          }
          process.stdout.write(result.value);
          process.stdout.write("\n");
        });
      }),
    );

  replica
    .command("list [prefix]")
    .description("List live keys in the local replica (never touches the network)")
    .option("--replica <name>", "Replica name")
    .option("--after <key>", "Start after this key")
    .option("--limit <n>", "Maximum keys", (value) => Number.parseInt(value, 10))
    .action((prefix: string | undefined, options, cmd: Command) =>
      run(async () => {
        if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
          throw new CLIError("USAGE_ERROR", "--limit must be a positive integer.", ExitCode.USAGE_ERROR);
        }
        const profile = await profileName(cmd);
        await withLegacyReplicaRead(profile, async (checkDelivery) => {
          const { entries, meta } = await withOpenReplica(profile, await existingReplicaName(profile, options.replica),
            (store) => new Replica({ store }).list({
              ...(prefix === undefined ? {} : { prefix }),
              ...(options.after === undefined ? {} : { after: options.after }),
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            }));
          await checkDelivery();
          if (shouldOutputJson()) {
            outputJson({ keys: entries, count: entries.length, prefix: prefix ?? null, meta });
          } else if (entries.length === 0) {
            process.stdout.write(theme.muted("No keys.") + "\n");
          } else {
            process.stdout.write(
              formatTable(
                ["Key", "Content"],
                entries.map((entry) => [entry.key, entry.content ? "local" : "missing"]),
              ) + "\n",
            );
          }
        });
      }),
    );

  replica
    .command("status")
    .description("Show one replica's sync state, authority and counts, or all of them")
    .option("--replica <name>", "Replica name")
    .action((options, cmd: Command) =>
      run(async () => {
        const profile = await profileName(cmd);
        await withLegacyReplicaRead(profile, async (checkDelivery) => {
          const names = options.replica === undefined ? await replicaNames(profile) : [assertName(options.replica)];
          const statuses: ReplicaStatus[] = [];
          for (const name of names) {
            statuses.push(await withOpenReplica(profile, name, (store) => new Replica({ store }).status()));
          }
          await checkDelivery();
          if (shouldOutputJson()) {
            outputJson(options.replica === undefined ? { replicas: statuses } : statuses[0]);
          } else if (statuses.length === 0) {
            process.stdout.write(theme.muted(`Profile "${profile}" has no replicas.`) + "\n");
          } else {
            process.stdout.write(statuses.map(describeStatus).join("\n\n") + "\n");
          }
        });
      }),
    );

  replica
    .command("reset")
    .description("Clear a replica's entries, content and cursor (keeps its configuration and grant)")
    .option("--replica <name>", "Replica name")
    .option("--purge", "Remove the replica entirely")
    .action((options, cmd: Command) =>
      run(async () => {
        const profile = await profileName(cmd);
        await withProfileLock(profile, async () => {
          const name = await existingReplicaName(profile, options.replica);
          if (options.purge) {
            await withPinnedReplicaForReset(profile, name, async (path, recheck, expectedDirectory) => {
              const profileLock = profileGuard(profile);
              const safeGuard: MutationGuard = (section) => profileLock(async () => {
                await recheck();
                return section();
              });
              const store = await SqliteReplicaStore.open(path, { create: false, guard: safeGuard, expectedDirectory });
              try {
                await recheck();
                // The store fences the database identity and lease; the root fd
                // keeps deletion in the selected directory if its name moves.
                const lease = await store.acquireSyncLease(60_000);
                if (lease === null) throw new ReplicaError(ReplicaErrorCode.BUSY, "Another process is syncing this replica.");
                await recheck();
                await store.destroy(lease);
              } finally {
                await store.close();
              }
            });
          } else {
            await withOpenReplica(profile, name, (store) => new Replica({ store }).reset("manual"));
          }
          outputJson({ replica: name, reset: true, purged: options.purge === true });
        }, { requireProfile: true });
      }),
    );
}
