import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  profilePath,
  readAdditionalDelegations,
  readSession,
  refuseWriteToDeletedProfile,
  withProfileLock,
} from "@tinycloud/operations/state";
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
  type KVSyncClient,
  type ParsedUcanGrant,
  type ReplicaReadResult,
  type ReplicaStatus,
} from "@tinycloud/replica";
import { SqliteReplicaStore, loadSqlite } from "@tinycloud/replica/sqlite";

import { ProfileManager } from "../config/profiles.js";
import { DEFAULT_PROFILE, ExitCode } from "../config/constants.js";
import { CLIError, handleError } from "../output/errors.js";
import { formatBytes, formatField, formatTable, outputJson, shouldOutputJson } from "../output/formatter.js";
import { theme } from "../output/theme.js";

/** Replica error → exit code. Mirrors `ExitCode`; see `tc replica --help`. */
const EXIT_BY_CODE: Record<ReplicaErrorCode, number> = {
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
    handleError(toCliError(error));
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

async function openReplica(profile: string, name: string): Promise<SqliteReplicaStore> {
  return SqliteReplicaStore.open(join(replicasRoot(profile), name), { create: false });
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

/** A KV service that invokes with exactly this grant and the device key, against the pinned host. */
async function grantBoundKv(input: { host: string; space: string; grant: { cid: string; bytes: Uint8Array }; deviceDid: string; jwk: object }) {
  const [{ KVService, ServiceContext }, wasm] = await Promise.all([import("@tinycloud/sdk-core"), import("@tinycloud/node-sdk-wasm")]);
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
    delegationHeader: { Authorization: new TextDecoder().decode(input.grant.bytes) },
    delegationCid: input.grant.cid,
    spaceId: input.space,
    verificationMethod: input.deviceDid,
    jwk: input.jwk,
  });
  const client: KVSyncClient = kv;
  return client;
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

export function registerReplicaCommand(program: Command): void {
  const replica = program
    .command("replica")
    .description("Durable read-only local replicas of a KV prefix (sync online, read offline)")
    .addHelpText(
      "after",
      `
A replica keeps the latest state of one KV prefix on this device. \`sync\` pulls
the tinycloud.kv/sync feed from the replica's pinned host under a device grant;
\`get\`, \`list\`, \`status\` and \`reset\` never touch the network.

Exit codes: 0 ok; 1 busy, runtime or storage error; 2 usage, NOT_COVERED,
SECRETS_OPT_IN_REQUIRED; 3 grant missing; 4 key absent, deleted, content missing
or coverage incomplete; 5 grant expired, revoked or not yet valid; 6 network;
7 node, protocol or integrity error; 10 storage full.`,
    );

  replica
    .command("sync")
    .description("Create or update a replica from its source host")
    .option("--replica <name>", "Replica name (default: the profile's only replica, or one named after the prefix)")
    .option("--space <id|name>", "Space to replicate (first sync; default: the space of the sync grant)")
    .option("--prefix <prefix>", "KV prefix to replicate, e.g. notes/ (first sync)")
    .option("--retention-grant <cid>", "CID of a tinycloud.kv/retain grant: keep local reads after the sync grant expires")
    .option("--limit <n>", "Feed page size (1-1000)", (value) => Number.parseInt(value, 10))
    .option("--allow-secrets", "Allow replicating the secrets space or the vault namespace")
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
          const dir = join(replicasRoot(profile), name);
          store = await withProfileLock(profile, async () => {
            await refuseWriteToDeletedProfile(profile);
            const created = await SqliteReplicaStore.open(dir, { create: true });
            if ((await created.open()) === null) {
              await created.init({
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
            return created;
          });
        }

        try {
          const state = (await store.open())!;
          const { space, prefix, host } = state.config;
          if (requiresSecretsOptIn(space, prefix) && !state.config.allowSecrets && options.allowSecrets !== true) {
            throw new ReplicaError(ReplicaErrorCode.SECRETS_OPT_IN_REQUIRED, `Replicating ${space}/kv/${prefix} needs --allow-secrets.`);
          }
          const grant = chooseGrant(grants, state.config.deviceDid, space, prefix);
          await store.installGrant(grant);
          if (options.retentionGrant !== undefined && options.retentionGrant !== state.config.retentionGrantCid) {
            await store.setRetentionGrant(options.retentionGrant === "" ? null : options.retentionGrant);
          }
          const current = (await store.open())!;
          const active = current.pendingGrant ?? current.grant!;
          const kv = await grantBoundKv({ host, space, grant: active, deviceDid: current.config.deviceDid, jwk });
          const report = await new Replica({ store, transport: kvSyncTransport(kv) }).sync(
            options.limit === undefined ? {} : { limit: options.limit },
          );
          const status = await store.status();
          if (shouldOutputJson()) {
            outputJson({ replica: current.config.name, sync: report, status });
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
            // Hold the lease so no sync writes while the directory goes away.
            const lease = await store.acquireSyncLease(60_000);
            if (lease === null) throw new ReplicaError(ReplicaErrorCode.BUSY, "Another process is syncing this replica.");
            await store.reset(lease, "purge");
          } else {
            await new Replica({ store }).reset("manual");
          }
        } finally {
          await store.close();
        }
        if (options.purge) await rm(join(replicasRoot(profile), name), { recursive: true, force: true });
        outputJson({ replica: name, reset: true, purged: options.purge === true });
      }),
    );
}
