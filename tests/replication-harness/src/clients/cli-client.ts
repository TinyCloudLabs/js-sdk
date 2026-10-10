import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { HarnessError } from "../contracts/common";
import type { EventEnvelope, EventQuery } from "../contracts/events";
import type { BatchPutItem, BatchPutResult, CliCallOptions, CliClient, CliResult, GetOptions, GetResult, ListOptions, ListResult, OpOptions, PurgeResult, PutOptions, ReadView, StatusEntry, SyncOptions, SyncResult, WriteResult } from "../contracts/client";

import type { RunEnvironment, Topology } from "../contracts/lifecycle";
import type { ClientSpec, ReplicationSpec } from "../contracts/topology";

const REPLICATION_ENV = new Set(["TC_REPLICATION_MAX_STALENESS_MS", "TC_REPLICATION_SYNC_TIMEOUT_MS", "TC_REPLICATION_VERIFY"]);
const now = () => performance.now();

export function scrubClientEnvironment(ambient: NodeJS.ProcessEnv, home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (value !== undefined && !key.startsWith("TC_")) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && (REPLICATION_ENV.has(key) || !key.startsWith("TC_"))) env[key] = value;
  }
  env.HOME = home;
  env.TC_HOME = home;
  return env;
}

export async function terminateWithLadder(child: ChildProcess, signal: AbortSignal | undefined, deadlineMs: number | undefined): Promise<void> {
  if (signal && !signal.aborted && deadlineMs === undefined) return;
  const wait = (ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));
  const stop = async (sig: NodeJS.Signals, grace: number) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(sig);
    await Promise.race([new Promise<void>((resolveWait) => child.once("exit", () => resolveWait())), wait(grace)]);
  };
  await stop("SIGINT", 2_000);
  await stop("SIGTERM", 2_000);
  await stop("SIGKILL", 100);
}

async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}
async function readNewLines(path: string, offset: number): Promise<unknown[]> {
  let text = "";
  try {
    const bytes = await readFile(path);
    text = bytes.subarray(offset > bytes.length ? 0 : offset).toString("utf8");
  } catch { return []; }
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as unknown]; } catch { return []; }
  });
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
    const emit = args.indexOf("--emit", 2);
    if (emit >= 0 && args[emit + 1] && !args[emit + 1]!.startsWith("-")) resolved[emit + 1] = resolve(home, args[emit + 1]!);
  } else if (command === "grant" || command === "import") {
    const input = args.findIndex((arg, index) => index >= 2 && !arg.startsWith("-"));
    if (input >= 0) resolved[input] = resolve(home, args[input]!);
  }
  return resolved;
}

export interface CliClientOptions {
  id: string;
  home?: string;
  cliEntry: string;
  host: string;
  profile?: string;
  replication?: ReplicationSpec | false;
  preloads?: string[];
  clock?: { now(): number };
}

export class CliClientImpl implements CliClient {
  readonly kind = "cli" as const;
  readonly capabilities = new Set(["perCallReplication"] as const);
  readonly id: string;
  private readonly homePath: string;
  private readonly entry: string;
  private readonly host: string;
  private readonly profileName: string;
  private replication?: ReplicationSpec | false;
  private readonly preloads: string[];
  private sequence = 0;
  private allEvents: EventEnvelope[] = [];
  private profileBusy = 0;
  private readonly children = new Set<ChildProcess>();
  constructor(options: CliClientOptions) {
    this.id = options.id;
    this.homePath = resolve(options.home ?? join(homedir(), ".cache", "tc893", options.id));
    this.entry = resolve(options.cliEntry);
    this.host = options.host;
    this.profileName = options.profile ?? options.id;
    this.replication = options.replication;
    this.preloads = options.preloads ?? [];
  }
  home(): string { return this.homePath; }
  profile(): string { return this.profileName; }
  eventsFile(): string { return join(this.homePath, ".tinycloud", "profiles", this.profileName, "replication", "events.jsonl"); }
  eventCursor(): number { return this.allEvents.at(-1)?.seq ?? 0; }
  events(query: EventQuery = {}): EventEnvelope[] {
    return this.allEvents.filter((item) => (query.since === undefined || item.seq > query.since) && (query.opSeq === undefined || item.opSeq === query.opSeq) && (query.type === undefined || (Array.isArray(query.type) ? query.type : [query.type]).includes(item.event.type)));
  }
  replicaDir(): string { return join(this.homePath, ".tinycloud", "profiles", this.profileName, "replication"); }
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
    return new CliClientImpl({ id: this.id, home: this.homePath, cliEntry: this.entry, host: alias, profile: this.profileName, replication: this.replication, preloads: this.preloads });
  }
  private async run(args: string[], options: CliCallOptions = {}): Promise<CliResult> {
    rejectFault(options);
    const startedMono = now();
    const opSeq = ++this.sequence;
    const overlap = this.profileBusy > 0;
    this.profileBusy++;
    const eventsPath = this.eventsFile();
    const eventsOffset = await fileSize(eventsPath);
    await mkdir(this.homePath, { recursive: true, mode: 0o700 });
    const spawnArgs = [...this.preloads.flatMap((preload) => ["--require", preload]), this.entry, "-q", "--json", "--profile", options.profile ?? this.profileName];
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
    const child = spawn(process.execPath, spawnArgs.concat(args), { cwd: this.homePath, env, stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    if (options.stdin) child.stdin?.end(Buffer.from(options.stdin));
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;
    const terminated = new Promise<void>((resolveTerminated) => {
      const onAbort = () => { aborted = true; void terminateWithLadder(child, options.signal, undefined).finally(resolveTerminated); };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.deadlineMs !== undefined) deadlineTimer = setTimeout(() => { aborted = true; void terminateWithLadder(child, undefined, options.deadlineMs).finally(resolveTerminated); }, options.deadlineMs);
      child.once("exit", () => { options.signal?.removeEventListener("abort", onAbort); resolveTerminated(); });
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("close", (code, signal) => resolveExit({ code, signal }));
      child.once("error", (error) => stderr.push(Buffer.from(error.message)));
    });
    await Promise.race([exit, terminated]);
    clearTimeout(deadlineTimer);
    const processResult = await exit;
    const newLines = await readNewLines(eventsPath, eventsOffset);
    const events = newLines.map((event) => ({ clientId: this.id, seq: ++this.sequence, opSeq: overlap ? null : opSeq, attribution: overlap ? "ambiguous" as const : "op" as const, recvMono: now(), event: event as EventEnvelope["event"] }));
    this.allEvents.push(...events);
    this.profileBusy--;
    const output = Buffer.concat(stdout);
    const err = Buffer.concat(stderr).toString("utf8");
    return { opSeq, startedMono, durationMs: now() - startedMono, events, exit: processResult.code, signal: processResult.signal, stdout: output, stderr: err, json: parseJson(output), ...(aborted ? { exit: options.deadlineMs === undefined ? 130 : null } : {}) };
  }
  async tc(args: string[], options?: CliCallOptions): Promise<CliResult> { return this.run(resolveCliAuthPaths(this.homePath, args), options); }
  private async op(args: string[], options: CliCallOptions = {}): Promise<CliResult> { return this.run(args, options); }
  async get(key: string, options: CliCallOptions & GetOptions = {}): Promise<GetResult> {
    if (options.source !== undefined) unsupportedOption("network-only reads");
    if (options.maxResponseBytes !== undefined) unsupportedOption("maxResponseBytes");
    if (options.space !== undefined) unsupportedOption("space selection");
    const result = await this.op(["kv", "get", key, "--raw"], options);
    const found = result.exit !== 4;
    const event = result.events.map((item) => item.event).find((item) => item.type === "replication.read");
    const read = event as ReadView | undefined;
    return { ...result, ok: found ? result.exit === 0 : true, found, ...(found ? { value: result.stdout } : {}), ...(read ? { read, readEvent: read as GetResult["readEvent"] } : {}), ...(found ? {} : { code: "NOT_FOUND" }) };
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
    const syncs = result.events.map((item) => item.event).filter((event) => event.type === "replication.sync");
    return { ...result, ok: result.exit === 0 && syncs.length > 0 && syncs.every((event) => event.outcome === "ok"), syncs: syncs as SyncResult["syncs"] };
  }
  async status(options?: CliCallOptions): Promise<StatusEntry[]> { const result = await this.op(["replica", "report", "--json"], options); return ((result.json as { replicas?: StatusEntry[] } | undefined)?.replicas ?? []); }
  async purge(options?: CliCallOptions): Promise<PurgeResult> { const result = await this.op(["auth", "logout"], options); return { ...result, ok: result.exit === 0, purged: [], failed: [] }; }
  async clearPending(options?: CliCallOptions): Promise<{ opSeq: number; startedMono: number; durationMs: number; events: EventEnvelope[]; ok: boolean; cleared: number }> { const result = await this.op(["replica", "report", "--clear-pending", "--json"], options); return { ...result, ok: result.exit === 0, cleared: Number((result.json as { cleared?: number } | undefined)?.cleared ?? 0) }; }
  async authority(): Promise<{ posture: "owner" | "delegate-session"; sessionExpiresAt: number | null; grantExpiresAt: number | null }> {
    const profilePath = join(this.homePath, ".tinycloud", "profiles", this.profileName);
    try {
      const [profileBytes, sessionBytes] = await Promise.all([readFile(join(profilePath, "profile.json"), "utf8"), readFile(join(profilePath, "session.json"), "utf8")]);
      const profile = JSON.parse(profileBytes) as Record<string, unknown>;
      const persisted = JSON.parse(sessionBytes) as Record<string, unknown>;
      const session = persisted.session && typeof persisted.session === "object" ? persisted.session as Record<string, unknown> : persisted;
      const grantValue = session.delegation ?? session.grant ?? profile.delegation ?? profile.grant;
      const grant = grantValue && typeof grantValue === "object" ? grantValue as Record<string, unknown> : {};
      const expiry = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
      const posture = profile.posture === "delegate-session" ? "delegate-session" : "owner";
      const sessionExpiry = session.expiresAt ?? session.expiry ?? session.expirationTime;
      const grantExpiry = session.grantExpiresAt ?? session.delegationExpiry ?? grant.expiresAt ?? grant.expiry ?? (posture === "delegate-session" ? sessionExpiry : undefined);
      return { posture, sessionExpiresAt: expiry(sessionExpiry), grantExpiresAt: expiry(grantExpiry) };
    } catch {
      return { posture: "owner", sessionExpiresAt: null, grantExpiresAt: null };
    }
  }
  async restart(options: { auth: "restore" | "fresh-sign-in"; replication?: ReplicationSpec | false } & OpOptions): Promise<void> { this.replication = options.replication ?? this.replication; }
  async kill(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void> { for (const child of this.children) child.kill(signal); }
  async close(_options: { deadlineMs: number }): Promise<{ graceful: boolean }> {
    const children = [...this.children];
    await Promise.all(children.map((child) => terminateWithLadder(child, undefined, 0)));
    return { graceful: children.every((child) => child.signalCode !== "SIGKILL" && child.exitCode !== null) };
  }
}

export function createCliClient(input: { id: string; home: string; cliEntry: string; host: string; spec: ClientSpec; environment: RunEnvironment; topology: Topology }): CliClient {
  void input.spec; void input.environment; void input.topology;
  return new CliClientImpl({ id: input.id, home: input.home, cliEntry: input.cliEntry, host: input.host, replication: input.spec.replication });
}
