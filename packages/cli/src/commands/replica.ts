import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readdir, rename, stat, unlink, readFile, lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ensureAuthenticated } from "../lib/sdk.js";
import { replicationForProfile } from "../lib/replication-registry.js";
import { CLEAR_PENDING_WARNING, createReplicationReport, renderReplicationReport, type ReplicationPartitionSummary } from "../lib/replication-report.js";
import { parseDuration } from "../lib/duration.js";
import {
  ProfileDeletedError,
  profilePath,
  readAdditionalDelegations,
  readSession,
  withProfileLock,
} from "@tinycloud/operations/state";
import type { ReplicationEvent, ReplicationControl } from "@tinycloud/node-sdk";
import {
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
  [ReplicaErrorCode.SOURCE_CHANGED]: ExitCode.NODE_ERROR,
  [ReplicaErrorCode.SCOPE_VIOLATION]: ExitCode.NODE_ERROR,
  [ReplicaErrorCode.CONTENT_MISMATCH]: ExitCode.NODE_ERROR,
  [ReplicaErrorCode.INTEGRITY_ERROR]: ExitCode.NODE_ERROR,
};

/** Non-present local reads: code and exit status. */
const READ_FAILURE: Record<Exclude<ReplicaReadResult["status"], "present">, { code: string; exit: number; what: string }> = {
  absent: { code: "KEY_ABSENT", exit: ExitCode.NOT_FOUND, what: "is not in the replica (the replica covers its whole prefix)" },
  deleted: { code: "KEY_DELETED", exit: ExitCode.NOT_FOUND, what: "was deleted at the source" },
  content_missing: { code: "CONTENT_MISSING", exit: ExitCode.NOT_FOUND, what: "is known but its content has not been fetched yet; run tc replica sync" },
  coverage_incomplete: {
    code: "COVERAGE_INCOMPLETE",
    exit: ExitCode.NOT_FOUND,
    what: "is not in the replica, which has not finished its first sync; run tc replica sync",
  },
  not_covered: { code: "NOT_COVERED", exit: ExitCode.USAGE_ERROR, what: "is outside the replica's prefix" },
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function toCliError(error: unknown): unknown {
  if (!isReplicaError(error)) return error;
  const hint = error.code === ReplicaErrorCode.GRANT_MISSING && typeof error.detail?.hint === "string" ? error.detail.hint : undefined;
  return new CLIError(error.code, error.message, EXIT_BY_CODE[error.code], hint === undefined ? undefined : { hint });
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    // Every replica command needs the runtime's built-in SQLite; fail the same way on all of them.
    await loadSqlite();
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

function replicasRoot(profile: string): string {
  return join(profilePath(profile), "replicas");
}

async function replicaNames(profile: string): Promise<string[]> {
  const names: string[] = [];
  for (const name of await readdir(replicasRoot(profile)).catch(() => [] as string[])) {
    if (!NAME.test(name)) continue;
    const exists = await stat(join(replicasRoot(profile), name, "replica.db")).then(
      () => true,
      () => false,
    );
    if (exists) names.push(name);
  }
  return names.sort();
}

function assertName(name: string): string {
  if (!NAME.test(name)) {
    throw new CLIError("USAGE_ERROR", `Replica names use letters, digits, '.', '_' and '-' (got ${JSON.stringify(name)}).`, ExitCode.USAGE_ERROR);
  }
  return name;
}

/** `--replica`, or the profile's only replica. */
async function existingReplicaName(profile: string, option: string | undefined): Promise<string> {
  if (option !== undefined) return assertName(option);
  const names = await replicaNames(profile);
  if (names.length === 1) return names[0]!;
  if (names.length === 0) {
    throw new ReplicaError(ReplicaErrorCode.NOT_FOUND, `Profile "${profile}" has no replicas. Create one with: tc replica sync --prefix <prefix>`);
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

async function openReplica(profile: string, name: string): Promise<SqliteReplicaStore> {
  return SqliteReplicaStore.open(join(replicasRoot(profile), name), { create: false, guard: profileGuard(profile) });
}

/**
 * Create a replica (or open the one a concurrent sync just created) inside
 * the profile guard: a profile deleted before or during this gets nothing.
 */
export async function createReplica(profile: string, config: ReplicaConfig): Promise<SqliteReplicaStore> {
  const guard = profileGuard(profile);
  return guard(async () => {
    const store = await SqliteReplicaStore.open(join(replicasRoot(profile), config.name), { create: true, guard });
    if ((await store.open()) === null) await store.init(config);
    return store;
  });
}

/** The compact JWTs this profile holds: its session and every imported delegation. */
async function storedGrants(profile: string): Promise<ParsedUcanGrant[]> {
  const authorizations: string[] = [];
  const session = await readSession<{ delegationHeader?: { Authorization?: unknown } }>(profile).catch(() => null);
  if (typeof session?.delegationHeader?.Authorization === "string") authorizations.push(session.delegationHeader.Authorization);
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
    `  device: tc auth request --cap tinycloud.kv:${space}:${prefix}:get,list,metadata,sync --expiry 30d --emit req.json`,
    "  owner:  tc auth grant req.json > grant.json",
    "  device: tc auth import grant.json",
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
    formatField("Purge", status.purgePending ? "incomplete: content files remain; the next tc replica command retries" : null),
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

async function readReplicationEvents(profile: string, sinceMs: number): Promise<ReplicationEvent[]> {
  const root = join(profilePath(profile), "replication");
  const events: ReplicationEvent[] = [];
  for (const name of ["events.jsonl.1", "events.jsonl"]) {
    const data = await readFile(join(root, name), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
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

async function replicationPartitions(profile: string): Promise<ReplicationPartitionSummary[]> {
  const root = join(profilePath(profile), "replication");
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const partitions: ReplicationPartitionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z2-7]{26}$/.test(entry.name)) continue;
    const directory = join(root, entry.name);
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) continue;
    const identity = await readFile(join(directory, "identity.json"), "utf8").then((value) => JSON.parse(value) as { host?: unknown; space?: unknown })
      .catch(() => null);
    const pending = await readFile(join(directory, "pending.json"), "utf8").then((value) => JSON.parse(value) as { records?: Array<{ state?: string }> })
      .catch(() => null);
    const pinned = pending?.records?.filter((record) => record.state === "in_flight" || record.state === "ambiguous").length ?? 0;
    partitions.push({
      idHash: entry.name,
      host: typeof identity?.host === "string" ? identity.host : null,
      space: typeof identity?.space === "string" ? identity.space : null,
      pinned,
    });
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
    .description("Report replication reads, syncs, pending writes and local identity partitions")
    .option("--since <duration>", "Include events from the last duration (default: 24h)", "24h")
    .option("--purge", "Purge configured replicas for the current identity")
    .option("--clear-pending", "Clear ambiguous and likely orphaned in-flight writes")
    .action((options, cmd: Command) =>
      run(async () => {
        const globals = cmd.optsWithGlobals();
        const context = await ProfileManager.resolveContext(globals);
        const node = context.replication ? await ensureAuthenticated(context) : undefined;
        const profile = await profileName(cmd);
        let durationMs: number;
        try {
          durationMs = parseDuration(options.since);
        } catch (error) {
          throw new CLIError("USAGE_ERROR", error instanceof Error ? error.message : String(error), ExitCode.USAGE_ERROR);
        }
        const control: ReplicationControl | undefined = node?.replication ?? replicationForProfile(profile);
        let cleared: number | undefined;
        let purged: unknown;
        let warning: string | undefined;
        if (options.clearPending || options.purge) {
          if (!control) throw new CLIError("REPLICATION_UNAVAILABLE", "No replication runtime is registered for this profile.", ExitCode.ERROR);
          warning = CLEAR_PENDING_WARNING;
          process.stderr.write(`Warning: ${warning}\n`);
          if (options.clearPending) cleared = await control.clearPending();
          if (options.purge) purged = await control.purge();
        }
        const sinceMs = Date.now() - durationMs;
        const [events, partitions, replicas] = await Promise.all([
          readReplicationEvents(profile, sinceMs),
          replicationPartitions(profile),
          node?.replication ? node.replication.status() : control ? control.status() : Promise.resolve([]),
        ]);
        const report = createReplicationReport(options.since, events, replicas, partitions, warning);
        if (shouldOutputJson()) {
          outputJson({
            ...report,
            ...(cleared === undefined ? {} : { cleared }),
            ...(purged === undefined ? {} : { purged }),
          });
        } else {
          process.stdout.write(`${renderReplicationReport(report)}\n`);
          if (cleared !== undefined) process.stdout.write(`Cleared ${cleared} pending write record(s).\n`);
          if (purged !== undefined) process.stdout.write(`Purge: ${JSON.stringify(purged)}\n`);
        }
      }),
    );

  replica
    .command("sync")
    .description("Create or update a replica from its source host")
    .option("--replica <name>", "Replica name (default: the profile's only replica, or one named after the prefix)")
    .option("--space <id|name>", "Space to replicate (first sync; default: the space of the sync grant)")
    .option("--prefix <prefix>", "KV prefix to replicate, e.g. notes/ (first sync)")
    .option("--retention-grant <cid>", "CID of a tinycloud.kv/retain grant: keep local reads after the sync grant expires")
    .option("--limit <n>", "Feed page size (1-1000)", (value) => Number.parseInt(value, 10))
    .option("--allow-secrets", "Opt in to copying ciphertext under a secrets prefix; replica grants do not include decrypt")
    .action((options, cmd: Command) =>
      run(async () => {
        const profile = await profileName(cmd);
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
        let store: SqliteReplicaStore;

        if (existing.includes(name)) {
          store = await openReplica(profile, name);
          const state = (await store.open())!;
          const differs = syncOptionsDiffer(state.config, {
            ...(options.space === undefined ? {} : { space: options.space }),
            ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
            ...(globals.host === undefined ? {} : { host: globals.host }),
          });
          if (differs !== undefined) {
            await store.close();
            throw new ReplicaError(
              ReplicaErrorCode.CONFIG_MISMATCH,
              `Replica ${name} already follows ${differs}. Use another --replica name, or tc replica reset --replica ${name} --purge first.`,
            );
          }
        } else {
          const prefix: string | undefined = options.prefix;
          if (prefix === undefined || prefix === "") {
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
          // Choose the grant before writing anything, so a missing grant leaves no replica behind.
          chooseGrant(grants, deviceDid, space, prefix);
          store = await createReplica(profile, {
            name,
            replicaId: randomBytes(16).toString("hex"),
            host,
            space,
            prefix,
            deviceDid,
            allowSecrets: options.allowSecrets === true,
            localReadPolicy: "whileGrantValid",
            retentionGrantCid: null,
          });
        }

        try {
          const state = (await store.open())!;
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
          if (warning !== undefined) process.stderr.write(`Warning: ${warning}\n`);
          const report = await new Replica({ store, transportFor }).sync(options.limit === undefined ? {} : { limit: options.limit });
          const status = await store.status();
          if (shouldOutputJson()) {
            outputJson({ replica: current.config.name, sync: report, status, ...(warning === undefined ? {} : { warning }) });
          } else {
            process.stdout.write(
              `${theme.success("✓")} Synced ${report.changes} change(s) in ${report.pages} page(s), fetched ${report.fetched} value(s).\n${describeStatus(status)}\n`,
            );
          }
        } finally {
          await store.close();
        }
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
        const store = await openReplica(profile, await existingReplicaName(profile, options.replica));
        let result: ReplicaReadResult;
        try {
          result = await new Replica({ store }).get(key, { verify: options.verify !== false });
        } finally {
          await store.close();
        }
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
        const store = await openReplica(profile, await existingReplicaName(profile, options.replica));
        try {
          const { entries, meta } = await new Replica({ store }).list({
            ...(prefix === undefined ? {} : { prefix }),
            ...(options.after === undefined ? {} : { after: options.after }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          });
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
        } finally {
          await store.close();
        }
      }),
    );

  replica
    .command("status")
    .description("Show one replica's sync state, authority and counts, or all of them")
    .option("--replica <name>", "Replica name")
    .action((options, cmd: Command) =>
      run(async () => {
        const profile = await profileName(cmd);
        const names = options.replica === undefined ? await replicaNames(profile) : [assertName(options.replica)];
        const statuses: ReplicaStatus[] = [];
        for (const name of names) {
          const store = await openReplica(profile, name);
          try {
            statuses.push(await new Replica({ store }).status());
          } finally {
            await store.close();
          }
        }
        if (shouldOutputJson()) {
          outputJson(options.replica === undefined ? { replicas: statuses } : statuses[0]);
        } else if (statuses.length === 0) {
          process.stdout.write(theme.muted(`Profile "${profile}" has no replicas.`) + "\n");
        } else {
          process.stdout.write(statuses.map(describeStatus).join("\n\n") + "\n");
        }
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
        const name = await existingReplicaName(profile, options.replica);
        const store = await openReplica(profile, name);
        try {
          if (options.purge) {
            // The removal is fenced by this lease and the database identity
            // this store opened, so it never removes a replica another process
            // took over or recreated. A revoked replica is removed too.
            const lease = await store.acquireSyncLease(60_000);
            if (lease === null) throw new ReplicaError(ReplicaErrorCode.BUSY, "Another process is syncing this replica.");
            await store.destroy(lease);
          } else {
            await new Replica({ store }).reset("manual");
          }
        } finally {
          await store.close();
        }
        outputJson({ replica: name, reset: true, purged: options.purge === true });
      }),
    );
}
