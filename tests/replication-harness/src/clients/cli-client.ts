import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { appendFile, copyFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { HarnessError } from "../contracts/common";
import type { EventEnvelope, EventQuery } from "../contracts/events";
import type { BatchPutItem, BatchPutResult, CliCallOptions, CliClient, CliResult, GetOptions, GetResult, ListOptions, ListResult, OpOptions, PurgeResult, PutOptions, ReadView, StatusEntry, SyncOptions, SyncResult, WriteResult } from "../contracts/client";

import type { ClientConstructionOptions } from "../contracts/frozen";
import type { GrantCap, ReplicationSpec } from "../contracts/topology";
import { registerSdkIdentityPrivateKey } from "./identity";
const REPLICATION_ENV: Record<string, true> = {
  TC_REPLICATION_MAX_STALENESS_MS: true,
  TC_REPLICATION_SYNC_TIMEOUT_MS: true,
  TC_REPLICATION_VERIFY: true,
};
const CLI_ENV_ALLOWLIST: Record<string, true> = {
  PATH: true,
  LANG: true,
  LC_ALL: true,
  LC_CTYPE: true,
  LC_MESSAGES: true,
  LC_COLLATE: true,
  LC_NUMERIC: true,
  LC_MONETARY: true,
  LC_TIME: true,
  LANGUAGE: true,
  LC_PAPER: true,
  LC_NAME: true,
  LC_ADDRESS: true,
  LC_TELEPHONE: true,
  LC_MEASUREMENT: true,
  LC_IDENTIFICATION: true,
  TZ: true,
};
const now = () => performance.now();

export function scrubClientEnvironment(ambient: NodeJS.ProcessEnv, home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (value !== undefined && Object.hasOwn(CLI_ENV_ALLOWLIST, key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && Object.hasOwn(REPLICATION_ENV, key)) env[key] = value;
  }
  env.HOME = home;
  env.TC_HOME = home;
  return env;
}
const nodeVersionChecks = new Map<string, Promise<void>>();
function verifyNodeVersion(nodeExecutable: string, home: string): Promise<void> {
  const checked = nodeVersionChecks.get(nodeExecutable);
  if (checked) return checked;
  const { promise, resolve: resolveCheck, reject: rejectCheck } = Promise.withResolvers<void>();
  nodeVersionChecks.set(nodeExecutable, promise);
  let child: ChildProcess;
  try {
    child = spawn(nodeExecutable, ["--version"], {
      cwd: home,
      env: scrubClientEnvironment(process.env, home),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    rejectCheck(new HarnessError("PREFLIGHT_FAILED", "Unable to start the configured harness Node executable", {
      nodeExecutable,
      error: error instanceof Error ? error.message : String(error),
    }));
    return promise;
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.once("error", (error) => rejectCheck(new HarnessError("PREFLIGHT_FAILED", "Unable to start the configured harness Node executable", {
    nodeExecutable,
    error: error.message,
  })));
  child.once("close", (code, signal) => {
    const version = Buffer.concat(stdout).toString("utf8").trim();
    if (code !== 0 || signal !== null) {
      rejectCheck(new HarnessError("PREFLIGHT_FAILED", "The configured harness Node executable failed its --version preflight", {
        nodeExecutable,
        exit: code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
      return;
    }
    const parts = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!parts || Number(parts[1]) < 22 || (Number(parts[1]) === 22 && Number(parts[2]) < 13)) {
      rejectCheck(new HarnessError("PREFLIGHT_FAILED", "The replication harness CLI requires Node v22.13.0 or newer", { nodeExecutable, version }));
      return;
    }
    resolveCheck();
  });
  return promise;
}

interface CliEventState {
  opSequence: number;
  eventSequence: number;
  allEvents: EventEnvelope[];
  artifactDirectory?: string;
}
const processRunId = randomUUID();
function clientHome(runId: string, topologyId: string, clientId: string): string {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return join(tmpdir(), "tc893-client-homes", `${process.pid}-${processRunId}`, hash(runId), hash(topologyId), hash(clientId));
}
async function ensureClientArtifacts(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ["stderr.log", "events.jsonl"]) {
    const file = join(directory, name);
    const handle = await open(file, "a", 0o600);
    await handle.close();
  }
}
type CliOperation = "get" | "put" | "del" | "list" | "sync" | "other";
interface CliInvocation {
  clientId: string;
  state: CliEventState;
  opSeq: number;
  operation: CliOperation;
  key?: string;
  prefix?: string;
  events: EventEnvelope[];
}
interface EventFileCursor { offset: number }

function eventFileIdentity(path: string, info: Stats): string {
  return info.ino ? `${info.dev}:${info.ino}` : path;
}

async function eventFiles(replicaDirectory: string): Promise<string[]> {
  try {
    const names = await readdir(replicaDirectory);
    return [".1", ""].flatMap((suffix) => {
      const name = `events.jsonl${suffix}`;
      return names.includes(name) ? [join(replicaDirectory, name)] : [];
    });
  } catch { return []; }
}

function eventRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function matchesInvocation(invocation: CliInvocation, event: Record<string, unknown>): boolean {
  if (event.type === "replication.read") {
    if (!["get", "list", "sync"].includes(invocation.operation)) return false;
    const eventOp = event.op;
    if (typeof eventOp === "string" && eventOp !== invocation.operation && !(invocation.operation === "sync" && eventOp === "list")) return false;
    if (typeof event.key === "string" && invocation.key !== undefined && event.key !== invocation.key) return false;
    if (typeof event.prefix === "string" && invocation.prefix !== undefined && event.prefix !== invocation.prefix) return false;
    return true;
  }
  if (event.type === "replication.write") {
    if (invocation.operation !== "put" && invocation.operation !== "del") return false;
    if (typeof event.op === "string" && event.op !== invocation.operation && !(invocation.operation === "del" && event.op === "delete")) return false;
    if (Array.isArray(event.keys) && invocation.key !== undefined && !event.keys.includes(invocation.key)) return false;
    return true;
  }
  if (event.type === "replication.sync") {
    if (event.trigger === "interval" || event.trigger === "start") return false;
    return ["get", "list", "sync"].includes(invocation.operation);
  }
  return false;
}

class ProfileEventCoordinator {
  private readonly active = new Set<CliInvocation>();
  private readonly cursors = new Map<string, EventFileCursor>();
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly replicaDirectory: string) {}

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    const { promise: next, resolve } = Promise.withResolvers<void>();
    this.queue = next;
    await previous;
    try { return await action(); } finally { resolve(); }
  }

  private async initializeCursors(): Promise<void> {
    for (const path of await eventFiles(this.replicaDirectory)) {
      let handle;
      try {
        handle = await open(path, "r");
        const info = await handle.stat();
        const contents = await handle.readFile();
        const identity = eventFileIdentity(path, info);
        const lastNewline = contents.lastIndexOf(0x0a);
        this.cursors.set(identity, { offset: lastNewline < 0 ? 0 : lastNewline + 1 });
      } catch { /* a log file may be rotated or removed during discovery */ }
      finally { await handle?.close().catch(() => undefined); }
    }
  }

  async begin(state: CliEventState, clientId: string, opSeq: number, operation: CliOperation, key?: string, prefix?: string): Promise<CliInvocation> {
    return this.exclusive(async () => {
      if (!this.initialized) {
        await this.initializeCursors();
        this.initialized = true;
      }
      const invocation: CliInvocation = { clientId, state, opSeq, operation, key, prefix, events: [] };
      this.active.add(invocation);
      return invocation;
    });
  }

  private async readNewEvents(): Promise<unknown[]> {
    const found: unknown[] = [];
    for (const path of await eventFiles(this.replicaDirectory)) {
      let handle;
      try {
        handle = await open(path, "r");
        const info = await handle.stat();
        const identity = eventFileIdentity(path, info);
        let offset = this.cursors.get(identity)?.offset ?? 0;
        if (offset > info.size) offset = 0;
        const appended = Buffer.allocUnsafe(info.size - offset);
        const { bytesRead } = await handle.read(appended, 0, appended.length, offset);
        const lastNewline = appended.lastIndexOf(0x0a, bytesRead - 1);
        if (lastNewline < 0) {
          this.cursors.set(identity, { offset });
          continue;
        }
        const end = lastNewline + 1;
        for (const line of appended.subarray(0, end).toString("utf8").split("\n")) {
          const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (!trimmed) continue;
          try { found.push(JSON.parse(trimmed) as unknown); } catch { /* Ignore malformed lines without manufacturing evidence. */ }
        }
        this.cursors.set(identity, { offset: offset + end });
      } catch { /* a log file may disappear as rotation completes */ }
      finally { await handle?.close().catch(() => undefined); }
    }
    return found;
  }

  async finish(invocation: CliInvocation): Promise<EventEnvelope[]> {
    return this.exclusive(async () => {
      if (!this.active.has(invocation)) return [];
      for (const value of await this.readNewEvents()) {
        const event = eventRecord(value);
        if (!event || typeof event.type !== "string") continue;
        const candidates = [...this.active].filter((active) => matchesInvocation(active, event));
        const background = event.type === "replication.sync" && ["interval", "start"].includes(String(event.trigger));
        const owner = candidates.length === 1 ? candidates[0] : !background && candidates.length === 0 && this.active.size === 1 ? [...this.active][0] : undefined;
        const ambiguous = !background && !owner;
        const target = owner ?? invocation;
        const envelope: EventEnvelope = {
          clientId: target.clientId,
          seq: ++target.state.eventSequence,
          opSeq: owner ? owner.opSeq : null,
          attribution: background ? "background" : ambiguous ? "ambiguous" : "op",
          recvMono: now(),
          event: event as EventEnvelope["event"],
        };
        if (target.state.artifactDirectory) await appendFile(join(target.state.artifactDirectory, "events.jsonl"), `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
        target.state.allEvents.push(envelope);
        target.events.push(envelope);
      }
      this.active.delete(invocation);
      return invocation.events;
    });
  }
}
function describeInvocation(args: string[], options: CliCallOptions): { operation: CliOperation; key?: string; prefix?: string } {
  if (args[0] !== "kv") return { operation: "other" };
  if (args[1] === "get") return { operation: "get", key: args[2] };
  if (args[1] === "put") return { operation: "put", key: args[2] };
  if (args[1] === "delete") return { operation: "del", key: args[2] };
  if (args[1] === "list") {
    const prefixIndex = args.indexOf("--prefix");
    return { operation: options.replication?.maxStalenessMs === 0 ? "sync" : "list", prefix: prefixIndex >= 0 ? args[prefixIndex + 1] : undefined };
  }
  return { operation: "other" };
}

const profileCoordinators = new Map<string, ProfileEventCoordinator>();
function profileDirectory(home: string, profile: string): string {
  return join(resolve(home), ".tinycloud", "profiles", profile);
}
function coordinatorFor(home: string, profile: string): ProfileEventCoordinator {
  const directory = profileDirectory(home, profile);
  let coordinator = profileCoordinators.get(directory);
  if (!coordinator) {
    coordinator = new ProfileEventCoordinator(join(directory, "replication"));
    profileCoordinators.set(directory, coordinator);
  }
  return coordinator;
}
export async function terminateWithLadder(child: ChildProcess, signal: AbortSignal | undefined, deadlineMs: number | undefined): Promise<void> {
  if (signal && !signal.aborted && deadlineMs === undefined) return;
  const wait = (ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  };
  const stop = async (sig: NodeJS.Signals, grace: number) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const { promise: exited, resolve } = Promise.withResolvers<void>();
    child.once("exit", () => resolve());
    child.kill(sig);
    await Promise.race([exited, wait(grace)]);
  };
  await stop("SIGINT", 2_000);
  await stop("SIGTERM", 2_000);
  await stop("SIGKILL", 100);
}

function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return undefined; }
}
function unsupportedOption(option: string): never {
  throw new HarnessError("CLIENT_UNSUPPORTED_OPTION", `CLI client does not support ${option}`);
}
function rejectFault(options: OpOptions): void {
  if (options.fault !== undefined) unsupportedOption("fetch faults");
}
export function resolveCliAuthPaths(home: string, args: string[]): string[] {
  if (args[0] !== "auth") return args;
  const resolved = [...args];
  const command = args[1];
  if (command === "request") {
    for (let index = 2; index < args.length; index++) {
      const argument = args[index]!;
      if (argument === "--emit" && args[index + 1] && !args[index + 1]!.startsWith("-")) {
        resolved[index + 1] = resolve(home, args[index + 1]!);
        break;
      }
      if (argument.startsWith("--emit=")) {
        resolved[index] = `--emit=${resolve(home, argument.slice("--emit=".length))}`;
        break;
      }
    }
  } else if (command === "grant" || command === "import") {
    const takesValue: Record<string, true> = { "--request": true, "--space": true };
    for (let index = 2; index < args.length; index++) {
      const argument = args[index]!;
      if (argument.startsWith("-")) {
        if (takesValue[argument]) index++;
        continue;
      }
      resolved[index] = resolve(home, argument);
      break;
    }
  }
  return resolved;
}

export interface CliDelegationWorkflowOptions {
  owner: CliClient;
  device: CliClient;
  ownerReady?: boolean;
  space: string;
  prefix: string;
  actions: GrantCap["actions"];
  expiry?: string;
}
export interface CliDelegationWorkflowResult {
  requestPath: string;
  grantPath: string;
  request: CliResult;
  grant: CliResult;
  imported: CliResult;
}

function requireCliSuccess(step: string, result: CliResult): void {
  if (result.exit !== 0) {
    throw new HarnessError("PREFLIGHT_FAILED", `CLI delegation preflight failed during ${step}`, {
      exit: result.exit,
      signal: result.signal,
      stderr: result.stderr,
    });
  }
}

function pathContains(parent: string, candidate: string): boolean {
  const distance = relative(parent, candidate);
  return distance === "" || (!isAbsolute(distance) && distance !== ".." && !distance.startsWith(`..${sep}`));
}

/** Create separate local identities and exercise the request → owner grant → device import flow. */
export async function createCliDelegation(options: CliDelegationWorkflowOptions): Promise<CliDelegationWorkflowResult> {
  const ownerHome = resolve(options.owner.home());
  const deviceHome = resolve(options.device.home());
  if (pathContains(ownerHome, deviceHome) || pathContains(deviceHome, ownerHome)) {
    throw new HarnessError("PREFLIGHT_FAILED", "CLI owner and device must use disjoint isolated homes");
  }
  if (!options.space || !options.prefix || !options.actions.length) {
    throw new HarnessError("PREFLIGHT_FAILED", "CLI delegation preflight requires a space, prefix, and at least one action");
  }
  if (options.ownerReady) {
    try {
      await Promise.all([
        stat(join(ownerHome, ".tinycloud", "profiles", options.owner.profile(), "profile.json")),
        stat(join(ownerHome, ".tinycloud", "profiles", options.owner.profile(), "session.json")),
      ]);
    } catch {
      throw new HarnessError("PREFLIGHT_FAILED", "CLI ownerReady requires an initialized profile and saved owner session");
    }
    if ((await options.owner.authority()).posture !== "owner") {
      throw new HarnessError("PREFLIGHT_FAILED", "CLI ownerReady requires an owner profile");
    }
    const ownerRegistrar = options.owner as CliClient & { registerOwnerIdentity?: () => Promise<void> };
    await ownerRegistrar.registerOwnerIdentity?.();
  } else {
    requireCliSuccess("owner key-only initialization", await options.owner.tc(["init", "--name", options.owner.profile(), "--key-only"]));
    requireCliSuccess("owner local sign-in", await options.owner.tc(["auth", "login", "--method", "local"]));
  }
  requireCliSuccess("device delegate-profile creation", await options.device.tc(["profile", "create", options.device.profile(), "--posture", "delegate-session"]));

  const requestPath = join(deviceHome, `.tc893-auth-request-${randomUUID()}.json`);
  const grantPath = join(ownerHome, `.tc893-auth-grant-${randomUUID()}.json`);
  const capability = `tinycloud.kv:${options.space}:${options.prefix}:${options.actions.join(",")}`;
  const request = await options.device.tc(["auth", "request", "--cap", capability, "--expiry", options.expiry ?? "30d", "--emit", requestPath]);
  requireCliSuccess("device request creation", request);
  try { await stat(requestPath); } catch {
    throw new HarnessError("PREFLIGHT_FAILED", "CLI device request succeeded without emitting its absolute request artifact");
  }
  const grant = await options.owner.tc(["auth", "grant", "--yes", requestPath]);
  requireCliSuccess("owner request grant", grant);
  if (!grant.stdout.byteLength) throw new HarnessError("PREFLIGHT_FAILED", "CLI owner grant emitted no portable grant artifact");
  await writeFile(grantPath, grant.stdout, { mode: 0o600, flag: "wx" });
  const deviceProfilePath = join(deviceHome, ".tinycloud", "profiles", options.device.profile(), "profile.json");
  const deviceProfile = JSON.parse(await readFile(deviceProfilePath, "utf8")) as Record<string, unknown>;
  deviceProfile.authMethod = "openkey";
  deviceProfile.replication = { prefixes: [options.prefix] };
  await writeFile(deviceProfilePath, JSON.stringify(deviceProfile), { mode: 0o600 });
  const imported = await options.device.tc(["auth", "import", grantPath]);
  requireCliSuccess("device grant import", imported);
  let importedResult: { expiry?: unknown };
  try { importedResult = JSON.parse(Buffer.from(imported.stdout).toString("utf8")) as { expiry?: unknown }; } catch {
    throw new HarnessError("PREFLIGHT_FAILED", "CLI grant import returned no parseable expiry metadata");
  }
  const expiresAt = typeof importedResult.expiry === "string" ? Date.parse(importedResult.expiry) : Number.NaN;
  if (!Number.isFinite(expiresAt)) throw new HarnessError("PREFLIGHT_FAILED", "CLI grant import returned no valid expiry metadata");
  await writeFile(join(deviceHome, ".tc893-authority.json"), JSON.stringify({ grantExpiresAt: expiresAt }), { mode: 0o600 });
  await writeFile(join(deviceHome, ".tc893-delegation.json"), grant.stdout, { mode: 0o600 });
  return { requestPath, grantPath, request, grant, imported };
}
interface CliOwnerProfileRef { home: string; profile: string }
const cliOwnerProfiles = new Map<string, CliOwnerProfileRef>();
export async function reuseCliOwnerIdentity(home: string, profileName: string, runId: string, identity: string): Promise<void> {
  const source = cliOwnerProfiles.get(`${runId}\u0000${identity}`);
  if (!source) return;
  const sourceDirectory = join(source.home, ".tinycloud", "profiles", source.profile);
  const targetDirectory = join(home, ".tinycloud", "profiles", profileName);
  const [sourceKey, sourceProfileText, targetProfileText] = await Promise.all([
    readFile(join(sourceDirectory, "key.json")),
    readFile(join(sourceDirectory, "profile.json"), "utf8"),
    readFile(join(targetDirectory, "profile.json"), "utf8"),
  ]);
  const sourceProfile = JSON.parse(sourceProfileText) as Record<string, unknown>;
  const targetProfile = JSON.parse(targetProfileText) as Record<string, unknown>;
  for (const field of ["did", "privateKey", "address", "chainId", "authMethod", "posture"] as const) {
    if (sourceProfile[field] !== undefined) targetProfile[field] = sourceProfile[field];
  }
  await Promise.all([
    writeFile(join(targetDirectory, "key.json"), sourceKey, { mode: 0o600 }),
    writeFile(join(targetDirectory, "profile.json"), JSON.stringify(targetProfile), { mode: 0o600 }),
  ]);
}

export interface CliClientOptions {
  id: string;
  home?: string;
  artifactDirectory?: string;
  cliEntry: string;
  node?: string;
  host: string;
  hostAliases?: Record<string, string>;
  profile?: string;
  replication?: ReplicationSpec | false;
  preloads?: string[];
  clock?: { now(): number };
  runId?: string;
  identity?: string;
  ownerPosture?: boolean;
  hostProfileSource?: string;
}

const DEADLINE_EXCEEDED = Symbol("deadlineExceeded");
interface InternalCliResult extends CliResult { [DEADLINE_EXCEEDED]?: true }
export class CliClientImpl implements CliClient {
  readonly kind = "cli" as const;
  readonly capabilities = new Set(["perCallReplication"] as const);
  readonly id: string;
  private readonly homePath: string;
  private readonly profilePath: string;
  private readonly entry: string;
  private readonly nodeExecutable: string;
  private readonly host: string;
  private readonly hostAliases: Record<string, string>;
  private readonly profileName: string;
  private readonly runId?: string;
  private readonly identity?: string;
  private readonly ownerPosture: boolean;
  private readonly eventState: CliEventState;
  private readonly artifactDirectory: string;
  private replication?: ReplicationSpec | false;
  private readonly children = new Set<ChildProcess>();
  private readonly hostProfileSource?: string;
  private hostProfilePromise?: Promise<void>;
  constructor(options: CliClientOptions, sharedEventState?: CliEventState) {
    this.id = options.id;
    this.homePath = resolve(options.home ?? join(tmpdir(), "tc893-client-homes", `${process.pid}-${processRunId}`, createHash("sha256").update(options.id).digest("hex")));
    this.artifactDirectory = resolve(options.artifactDirectory ?? this.homePath);
    this.profileName = options.profile ?? options.id;
    this.profilePath = profileDirectory(this.homePath, this.profileName);
    this.entry = resolve(options.cliEntry);
    this.nodeExecutable = options.node ?? process.env.HARNESS_NODE ?? "node";
    this.host = options.host;
    this.hostAliases = options.hostAliases ?? {};
    this.runId = options.runId;
    this.identity = options.identity;
    this.ownerPosture = options.ownerPosture === true;
    this.hostProfileSource = options.hostProfileSource;
    this.replication = options.replication;
    if (options.preloads?.length) throw new HarnessError("CLIENT_UNSUPPORTED_OPTION", "CLI preload execution is not available in the S2 client");
    this.eventState = sharedEventState ?? { opSequence: 0, eventSequence: 0, allEvents: [] };
    this.eventState.artifactDirectory = this.artifactDirectory;
  }
  home(): string { return this.homePath; }
  artifactDirectoryPath(): string { return this.artifactDirectory; }
  profile(): string { return this.profileName; }
  eventsFile(): string { return join(this.profilePath, "replication", "events.jsonl"); }
  eventCursor(): number { return this.eventState.allEvents.at(-1)?.seq ?? 0; }
  events(query: EventQuery = {}): EventEnvelope[] {
    return this.eventState.allEvents.filter((item) => (query.since === undefined || item.seq > query.since) && (query.opSeq === undefined || item.opSeq === query.opSeq) && (query.type === undefined || (Array.isArray(query.type) ? query.type : [query.type]).includes(item.event.type)));
  }
  replicaDir(): string { return join(this.profilePath, "replication"); }
  async scanReplica(needle: Uint8Array): Promise<string[]> {
    const found: string[] = [];
    const visit = async (dir: string) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) {
          const content = await readFile(path);
          if (Buffer.from(content).includes(Buffer.from(needle))) found.push(path);
        }
      }
    };
    await visit(this.replicaDir());
    return found;
  }
  withHost(alias: string): CliClient {
    const host = this.hostAliases[alias] ?? alias;
    return new CliClientImpl({
      id: this.id,
      home: this.homePath,
      artifactDirectory: this.artifactDirectory,
      cliEntry: this.entry,
      node: this.nodeExecutable,
      host,
      profile: `host-${createHash("sha256").update(host).digest("hex").slice(0, 16)}`,
      hostProfileSource: this.profileName,
      hostAliases: this.hostAliases,
      replication: this.replication,
      runId: this.runId,
      identity: this.identity,
      ownerPosture: this.ownerPosture,
    }, this.eventState);
  }

  async registerOwnerIdentity(): Promise<void> {
    if (!this.ownerPosture || !this.runId || !this.identity) {
      throw new HarnessError("PREFLIGHT_FAILED", "CLI owner identity registration requires owner posture, runId, and identity");
    }
    let profile: Record<string, unknown>;
    try { profile = JSON.parse(await readFile(join(this.profilePath, "profile.json"), "utf8")) as Record<string, unknown>; }
    catch {
      throw new HarnessError("PREFLIGHT_FAILED", "CLI owner identity profile is missing or unreadable");
    }
    if (typeof profile.privateKey !== "string") {
      throw new HarnessError("PREFLIGHT_FAILED", "CLI owner key-only profile has no private key");
    }
    registerSdkIdentityPrivateKey(this.runId, this.identity, profile.privateKey);
    cliOwnerProfiles.set(`${this.runId}\u0000${this.identity}`, { home: this.homePath, profile: this.profileName });
  }

  private async registerAfterOwnerKeySetup(args: string[], exitCode: number | null): Promise<void> {
    if (!this.ownerPosture || exitCode !== 0 || !this.runId || !this.identity) return;
    const localLogin = args[0] === "auth" && args[1] === "login" && args.some((arg, index) => arg === "--method" && args[index + 1] === "local");
    if (localLogin) await this.registerOwnerIdentity();
  }

  private ensureHostProfile(): Promise<void> {
    this.hostProfilePromise ??= this.prepareHostProfile();
    return this.hostProfilePromise;
  }
  private async prepareHostProfile(): Promise<void> {
    const sessionPath = join(this.profilePath, "session.json");
    try { await stat(sessionPath); return; } catch { /* Bootstrap this host-specific profile once. */ }
    const sourceDirectory = profileDirectory(this.homePath, this.hostProfileSource!);
    try {
      await Promise.all([stat(join(sourceDirectory, "key.json")), stat(join(sourceDirectory, "profile.json"))]);
    } catch {
      if (!this.ownerPosture) return;
      throw new HarnessError("PREFLIGHT_FAILED", "CLI owner host switch is missing its source profile key or configuration");
    }
    await mkdir(this.profilePath, { recursive: true, mode: 0o700 });
    await Promise.all([
      copyFile(join(sourceDirectory, "key.json"), join(this.profilePath, "key.json")),
      copyFile(join(sourceDirectory, "profile.json"), join(this.profilePath, "profile.json")),
    ]);
    await rm(sessionPath, { force: true });
    if (this.ownerPosture) {
      const args = ["auth", "login", "--method", "local"];
      if (this.replication) {
        for (const prefix of this.replication.prefixes) args.push("--replication-prefix", prefix);
        if (this.replication.allowSecrets) args.push("--replication-allow-secrets");
      }
      const result = await this.run(args, { profile: this.profileName }, true);
      requireCliSuccess("host-specific owner sign-in", result);
      return;
    }
    const grantPath = join(this.homePath, ".tc893-delegation.json");
    try { await stat(grantPath); } catch {
      throw new HarnessError("CLIENT_UNSUPPORTED_OPTION", "CLI delegate withHost requires its portable grant so it can establish authority on the target host");
    }
    const imported = await this.run(["auth", "import", grantPath], { profile: this.profileName }, true);
    requireCliSuccess("host-specific delegate import", imported);
    let result: { expiry?: unknown };
    try { result = JSON.parse(Buffer.from(imported.stdout).toString("utf8")) as { expiry?: unknown }; } catch {
      throw new HarnessError("PREFLIGHT_FAILED", "Host-specific CLI grant import returned no parseable expiry metadata");
    }
    const expiresAt = typeof result.expiry === "string" ? Date.parse(result.expiry) : Number.NaN;
    if (!Number.isFinite(expiresAt)) throw new HarnessError("PREFLIGHT_FAILED", "Host-specific CLI grant import returned no valid expiry metadata");
    await writeFile(join(this.homePath, ".tc893-authority.json"), JSON.stringify({ grantExpiresAt: expiresAt }), { mode: 0o600 });
  }
  private async run(args: string[], options: CliCallOptions = {}, skipHostProfile = false): Promise<InternalCliResult> {
    if (!skipHostProfile && this.hostProfileSource) await this.ensureHostProfile();
    rejectFault(options);
    const startedMono = now();
    await mkdir(this.homePath, { recursive: true, mode: 0o700 });
    await ensureClientArtifacts(this.artifactDirectory);
    await verifyNodeVersion(this.nodeExecutable, this.homePath);
    const state = this.eventState;
    const opSeq = ++state.opSequence;
    const activeProfile = options.profile ?? this.profileName;
    const coordinator = coordinatorFor(this.homePath, activeProfile);
    const description = describeInvocation(args, options);
    const invocation = await coordinator.begin(state, this.id, opSeq, description.operation, description.key, description.prefix);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    let finished = false;
    try {
      const spawnArgs = [this.entry, "-q", "--json", "--profile", activeProfile];
      if (!options.omitHost) spawnArgs.push("--host", this.host);
      if (options.flag === "on") spawnArgs.push("--replication");
      else if (options.flag === "off") spawnArgs.push("--no-replication");
      else if (this.replication) spawnArgs.push("--replication");
      if (options.debug) spawnArgs.push("--replication-debug");
      const env = scrubClientEnvironment(process.env, this.homePath, {
        TC_REPLICATION_MAX_STALENESS_MS: options.replication?.maxStalenessMs === undefined ? undefined : String(options.replication.maxStalenessMs),
        TC_REPLICATION_SYNC_TIMEOUT_MS: options.replication?.staleSyncTimeoutMs === undefined ? undefined : String(options.replication.staleSyncTimeoutMs),
        TC_REPLICATION_VERIFY: options.replication?.verify ? "1" : undefined,
      });
      const child = spawn(this.nodeExecutable, spawnArgs.concat(args), { cwd: this.homePath, env, stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
      this.children.add(child);
      child.once("close", () => this.children.delete(child));
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      if (options.stdin) child.stdin?.end(Buffer.from(options.stdin));

      let deadlineExceeded = false;
      let terminationCause: "abort" | "deadline" | undefined;
      let childExited = false;
      const { promise: exit, resolve: resolveExit } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
      child.once("close", (code, signal) => resolveExit({ code, signal }));
      child.once("error", (error) => stderr.push(Buffer.from(error.message)));
      const { promise: terminated, resolve: resolveTerminated } = Promise.withResolvers<void>();
      const onAbort = () => {
        if (terminationCause || childExited) return;
        terminationCause = "abort";
        clearTimeout(deadlineTimer);
        void terminateWithLadder(child, options.signal, undefined).finally(resolveTerminated);
      };
      if (options.signal?.aborted) onAbort();
      else if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      if (options.deadlineMs !== undefined && !terminationCause) {
        deadlineTimer = setTimeout(() => {
          if (terminationCause || childExited) return;
          terminationCause = "deadline";
          deadlineExceeded = true;
          removeAbortListener?.();
          void terminateWithLadder(child, undefined, options.deadlineMs).finally(resolveTerminated);
        }, options.deadlineMs);
      }
      child.once("exit", () => {
        childExited = true;
        clearTimeout(deadlineTimer);
        removeAbortListener?.();
        resolveTerminated();
      });
      await Promise.race([exit, terminated]);
      clearTimeout(deadlineTimer);
      removeAbortListener?.();
      const processResult = await exit;
      const events = await coordinator.finish(invocation);
      finished = true;
      await appendFile(join(this.artifactDirectory, "stderr.log"), Buffer.concat(stderr), { mode: 0o600 });
      const output = Buffer.concat(stdout);
      const result: InternalCliResult = {
        opSeq,
        startedMono,
        durationMs: now() - startedMono,
        events,
        exit: processResult.code,
        signal: processResult.signal,
        stdout: output,
        stderr: Buffer.concat(stderr).toString("utf8"),
        json: parseJson(output),
      };
      if (deadlineExceeded) Object.defineProperty(result, DEADLINE_EXCEEDED, { value: true });
      if (activeProfile === this.profileName) await this.registerAfterOwnerKeySetup(args, processResult.code);
      return result;
    } finally {
      clearTimeout(deadlineTimer);
      removeAbortListener?.();
      if (!finished) await coordinator.finish(invocation);
    }
  }

  async tc(args: string[], options?: CliCallOptions): Promise<CliResult> { return this.run(resolveCliAuthPaths(this.homePath, args), options); }
  private async op(args: string[], options: CliCallOptions = {}): Promise<InternalCliResult> { return this.run(args, options); }
  async get(key: string, options: CliCallOptions & GetOptions = {}): Promise<GetResult> {
    if (options.source !== undefined) unsupportedOption("network-only reads");
    if (options.maxResponseBytes !== undefined) unsupportedOption("maxResponseBytes");
    if (options.space !== undefined) unsupportedOption("space selection");
    const result = await this.op(["kv", "get", key, "--raw"], options);
    if (result[DEADLINE_EXCEEDED]) {
      return { ...result, ok: false, found: false, code: "DEADLINE_EXCEEDED" };
    }
    const found = result.exit === 0;
    const event = result.events.map((item) => item.event).find((item) => item.type === "replication.read");
    const read = event as ReadView | undefined;
    const code = found ? undefined : result.exit === 4 ? "NOT_FOUND" : result.signal ? `SIGNAL_${result.signal}` : `EXIT_${result.exit}`;
    return { ...result, ok: found || result.exit === 4, found, ...(found ? { value: result.stdout } : {}), ...(read ? { read, readEvent: read as GetResult["readEvent"] } : {}), ...(code ? { code } : {}) };
  }
  async put(key: string, value: string | Uint8Array, options: CliCallOptions & PutOptions = {}): Promise<WriteResult> {
    if (options.contentType !== undefined) unsupportedOption("contentType");
    const result = await this.op(["kv", "put", key, "--stdin"], { ...options, stdin: value instanceof Uint8Array ? value : Buffer.from(value) });
    return { ...result, ok: result.exit === 0, ...(result.exit === 0 ? { outcome: "committed" } : { outcome: "failed", code: `EXIT_${result.exit}` }) };
  }
  async del(key: string, options?: OpOptions & CliCallOptions): Promise<WriteResult> {
    const result = await this.op(["kv", "delete", key], options);
    return { ...result, ok: result.exit === 0, outcome: result.exit === 0 ? "committed" : "failed" };
  }
  async list(prefix: string, options: CliCallOptions & ListOptions = {}): Promise<ListResult> {
    if (options.source !== undefined) unsupportedOption("network-only lists");
    if (options.limit !== undefined || options.cursor !== undefined) unsupportedOption("list paging");
    const result = await this.op(["kv", "list", "--prefix", prefix], options);
    const json = result.json as { keys?: string[]; nextCursor?: string } | undefined;
    const read = result.events.map((item) => item.event).find((event) => event.type === "replication.read");
    return { ...result, ok: result.exit === 0, keys: json?.keys ?? [], nextCursor: json?.nextCursor, ...(read ? { read: read as ReadView } : {}) };
  }
  async batchPut(_items: BatchPutItem[], _options?: OpOptions): Promise<BatchPutResult> { return unsupportedOption("batchPut"); }
  async sync(options: SyncOptions & CliCallOptions = {}): Promise<SyncResult> {
    const result = await this.op(["kv", "list", "--prefix", options.prefix ?? ""], { ...options, replication: { maxStalenessMs: 0, staleSyncTimeoutMs: options.replication?.staleSyncTimeoutMs, verify: options.replication?.verify } });
    const syncs = result.events.filter((item) => item.attribution === "op" && item.opSeq === result.opSeq).map((item) => item.event).filter((event) => event.type === "replication.sync");
    return { ...result, ok: result.exit === 0 && syncs.length > 0 && syncs.every((event) => event.outcome === "ok"), syncs: syncs as SyncResult["syncs"] };
  }
  async status(options?: CliCallOptions): Promise<StatusEntry[]> { const result = await this.op(["replica", "report", "--json"], options); return ((result.json as { replicas?: StatusEntry[] } | undefined)?.replicas ?? []); }
  async purge(options?: CliCallOptions): Promise<PurgeResult> { const result = await this.op(["auth", "logout"], options); return { ...result, ok: result.exit === 0, purged: [], failed: [] }; }
  async clearPending(options?: CliCallOptions): Promise<{ opSeq: number; startedMono: number; durationMs: number; events: EventEnvelope[]; ok: boolean; cleared: number }> { const result = await this.op(["replica", "report", "--clear-pending", "--json"], options); return { ...result, ok: result.exit === 0, cleared: Number((result.json as { cleared?: number } | undefined)?.cleared ?? 0) }; }
  async authority(): Promise<{ posture: "owner" | "delegate-session"; sessionExpiresAt: number | null; grantExpiresAt: number | null }> {
    const profilePath = join(this.homePath, ".tinycloud", "profiles", this.profileName);
    try {
      const [profileBytes, sessionBytes, metadataBytes] = await Promise.all([
        readFile(join(profilePath, "profile.json"), "utf8"),
        readFile(join(profilePath, "session.json"), "utf8"),
        readFile(join(this.homePath, ".tc893-authority.json"), "utf8").catch(() => "{}"),
      ]);
      const profile = JSON.parse(profileBytes) as Record<string, unknown>;
      const persisted = JSON.parse(sessionBytes) as Record<string, unknown>;
      const metadata = JSON.parse(metadataBytes) as Record<string, unknown>;
      const session = persisted.session && typeof persisted.session === "object" ? persisted.session as Record<string, unknown> : persisted;
      const grantValue = session.delegation ?? session.grant ?? profile.delegation ?? profile.grant;
      const grant = grantValue && typeof grantValue === "object" ? grantValue as Record<string, unknown> : {};
      const expiry = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
      const siweExpiry = typeof session.siwe === "string" ? session.siwe.match(/^Expiration Time: (.+)$/m)?.[1] : undefined;
      const posture = profile.posture === "delegate-session" ? "delegate-session" : "owner";
      const sessionExpiry = session.expiresAt ?? session.expiry ?? session.expirationTime ?? siweExpiry;
      const grantExpiry = session.grantExpiresAt ?? session.delegationExpiry ?? grant.expiresAt ?? grant.expiry ?? profile.grantExpiresAt ?? metadata.grantExpiresAt ?? (posture === "delegate-session" ? sessionExpiry : undefined);
      return { posture, sessionExpiresAt: expiry(sessionExpiry), grantExpiresAt: posture === "delegate-session" ? expiry(grantExpiry) : null };
    } catch {
      return { posture: "owner", sessionExpiresAt: null, grantExpiresAt: null };
    }
  }
  async restart(options: { auth?: "restore" | "fresh-sign-in"; replication?: ReplicationSpec | false } & OpOptions = {}): Promise<void> {
    if (options.auth === "fresh-sign-in") unsupportedOption("CLI fresh sign-in restart");
    this.replication = options.replication ?? this.replication;
  }
  async kill(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void> { for (const child of this.children) child.kill(signal); }
  async close(_options: { deadlineMs: number }): Promise<{ graceful: boolean }> {
    await ensureClientArtifacts(this.artifactDirectory);
    const children = [...this.children];
    await Promise.all(children.map((child) => terminateWithLadder(child, undefined, 0)));
    return { graceful: children.every((child) => child.signalCode !== "SIGKILL" && child.exitCode !== null) };
  }
}

function clientHost(input: ClientConstructionOptions): string {
  return input.spec.endpoint ?? input.topology.proxy(`client:${input.spec.id}->${input.spec.node}`).listenUrl;
}

export async function createCliClient(input: ClientConstructionOptions): Promise<CliClientImpl> {
  const spec = input.spec;
  if (spec.kind !== "cli") throw new HarnessError("CLIENT_UNSUPPORTED_OPTION", `Client ${spec.id} is not a CLI client`);
  if (spec.preloads?.length) throw new HarnessError("CLIENT_UNSUPPORTED_OPTION", "CLI preload execution is not available in the S2 client");
  const home = clientHome(input.environment.runId, input.topology.id, spec.id);
  const artifactDirectory = resolve(input.environment.resultsDir, input.environment.runId, input.topology.id, "clients", spec.id);
  const profile = spec.auth.posture === "owner" ? "owner" : spec.id;
  const hostAliases = Object.fromEntries((spec.extraHosts ?? []).map((extra) => [
    extra.alias,
    input.topology.proxy(`client:${spec.id}->${extra.alias}`).listenUrl,
  ]));
  const client = new CliClientImpl({
    id: spec.id,
    home,
    artifactDirectory,
    cliEntry: input.sut.cli.entry,
    node: process.env.HARNESS_NODE,
    host: clientHost(input),
    hostAliases,
    profile,
    replication: spec.replication,
    runId: input.environment.runId,
    identity: spec.identity,
    ownerPosture: spec.auth.posture === "owner",
  });
  await ensureClientArtifacts(artifactDirectory);
  if (spec.auth.posture === "owner") {
    const init = await client.tc(["init", "--name", profile, "--key-only"]);
    if (init.exit !== 0) throw new HarnessError("PREFLIGHT_FAILED", "CLI owner key-only initialization failed", { exit: init.exit, signal: init.signal, stderr: init.stderr });
    const loginArgs = ["auth", "login", "--method", "local"];
    await reuseCliOwnerIdentity(home, profile, input.environment.runId, spec.identity);
    if (spec.replication) {
      for (const prefix of spec.replication.prefixes) loginArgs.push("--replication-prefix", prefix);
      if (spec.replication.allowSecrets) loginArgs.push("--replication-allow-secrets");
    }
    const login = await client.tc(loginArgs);
    if (login.exit !== 0) throw new HarnessError("PREFLIGHT_FAILED", "CLI owner local sign-in failed", { exit: login.exit, signal: login.signal, stderr: login.stderr });
  }
  return client;
}
