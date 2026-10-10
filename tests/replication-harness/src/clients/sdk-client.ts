import { appendFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { HarnessError } from "../contracts/common";
import type { EventEnvelope, EventQuery } from "../contracts/events";
import type { CallOptions } from "../contracts/common";
import type { GetResult, KvClient, OpOptions, PutOptions, SdkClient, StatusEntry, WriteResult } from "../contracts/client";
import type { RpcOp, RpcOps, RpcResponse, DriverLine, SdkReplicationConfig } from "../contracts/rpc";
import type { ReplicationSpec } from "../contracts/topology";
import type { ClientConstructionOptions } from "../contracts/frozen";
import { registeredSdkIdentityPrivateKey, sdkIdentityPrivateKey } from "./identity";

const driverPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../sdk-driver.mjs");

function supportsNode(version: string): boolean {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || major === 22 && minor >= 13;
}
export interface SdkClientOptions {
  id: string; host: string; domain: string; home: string; storageDir: string; sdkLoader: string; node?: string; preloads?: string[];
  privateKeyHex?: string; sessionExpiryMs?: number; replication?: (ReplicationSpec & { storageDir: string }) | false;
  auth?: "restore" | "fresh-sign-in" | "session-only"; delegation?: unknown; hosts?: string[];
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>; op: RpcOp }
function assertSdkOptions(options: OpOptions): void {
  if (options.fault !== undefined) throw new HarnessError("CLIENT_UNSUPPORTED_OPTION", "SDK client does not support fetch faults");
  if (options.replication !== undefined || options.flag !== undefined || options.debug !== undefined) throw new HarnessError("CLIENT_UNSUPPORTED_OPTION", "SDK replication is configured per client, not per operation");
}

export class SdkClientImpl implements SdkClient {
  readonly kind = "sdk" as const;
  readonly capabilities = new Set(["callerDeadline", "maxResponseBytes", "listPaging", "batchPut", "backgroundSync", "grantIssue"] as const);
  readonly id: string;
  private options: SdkClientOptions;
  private process?: ChildProcess;
  private sequence = 0;
  private startPromise?: Promise<void>;
  private ready = false;
  private failure?: Error;
  private expectedExits = new WeakSet<ChildProcess>();
  private closeEvents = new WeakMap<ChildProcess, Promise<void>>();
  private exitEvents = new WeakMap<ChildProcess, Promise<void>>();
  private stderrOutput = "";
  private rpcId = 0;
  private pending = new Map<number, Pending>();
  private allEvents: EventEnvelope[] = [];
  private inFlight = new Map<number, number>();
  private initArgs?: RpcOps["init"]["args"];
  private proof?: unknown;
  constructor(options: SdkClientOptions) { this.id = options.id; this.options = options; }
  get stderr(): string { return this.stderrOutput; }
  get stderrArtifactPath(): string { return join(this.options.home, "driver.stderr.log"); }
  private async start(auth: "restore" | "fresh-sign-in" | "session-only" = this.options.auth ?? "fresh-sign-in"): Promise<void> {
    await mkdir(this.options.home, { recursive: true, mode: 0o700 });
    await mkdir(this.options.storageDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(this.options.home, "driver.stderr.log"), "", { mode: 0o600 });
    const nodeBin = this.options.node ?? process.env.HARNESS_NODE ?? "node";
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.options.home,
      TC_HOME: this.options.home,
      TC893_LOADER: this.options.sdkLoader,
      TC893_HOME: this.options.home,
    };
    for (const name of ["LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME", "LC_ADDRESS", "LC_IDENTIFICATION", "LC_MEASUREMENT", "LC_NAME", "LC_PAPER", "LC_TELEPHONE", "TZ"]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const child = spawn(nodeBin, [...(this.options.preloads ?? []).flatMap((preload) => ["--require", preload]), driverPath], { cwd: this.options.home, env, stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    const { promise: exitEvent, resolve: resolveExitEvent } = Promise.withResolvers<void>();
    child.once("exit", () => resolveExitEvent());
    this.exitEvents.set(child, exitEvent);
    const { promise: closeEvent, resolve: resolveCloseEvent } = Promise.withResolvers<void>();
    child.once("close", () => resolveCloseEvent());
    this.closeEvents.set(child, closeEvent);
    this.ready = false;
    const outputStream = child.stdout;
    const errorStream = child.stderr;
    if (!outputStream || !errorStream) {
      const failure = new HarnessError("CLIENT_CRASHED", "SDK driver streams are unavailable");
      this.failure = failure;
      throw failure;
    }
    let partial = "";
    outputStream.on("data", (chunk: Buffer) => {
      partial += chunk.toString("utf8");
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.length) this.receive(line);
    });
    errorStream.on("data", (chunk: Buffer) => {
      this.stderrOutput += chunk.toString("utf8");
      appendFileSync(this.stderrArtifactPath, chunk, { mode: 0o600 });
    });
    const failDriver = (message: string, detail?: unknown) => {
      const error = new HarnessError("CLIENT_CRASHED", message, detail);
      const expected = this.expectedExits.has(child);
      if (this.process === child) {
        this.process = undefined;
        this.ready = false;
        if (!expected) this.failure ??= error;
      }
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(this.failure ?? new HarnessError("CLIENT_CRASHED", message, { id, op: pending.op, detail }));
      }
      this.pending.clear();
    };
    child.once("error", (error) => failDriver("SDK driver process failed", error));
    child.once("exit", (code, signal) => failDriver(`SDK driver exited (${code ?? signal})`));
    try {
      const loaded = await this.rpcRaw("hello", {});
      if (loaded.driver !== "tc893-sdk-driver" || loaded.protocol !== 1 || !supportsNode(loaded.node) || loaded.node.includes("bun/")) {
        throw new HarnessError("PREFLIGHT_FAILED", "SDK driver requires Node >=22.13 and must not run under Bun", loaded);
      }
      if (!this.initArgs) this.initArgs = { host: this.options.host, domain: this.options.domain, privateKeyHex: this.options.privateKeyHex, sessionExpiryMs: this.options.sessionExpiryMs, replication: this.options.replication ? { ...this.options.replication, storageDir: this.options.storageDir } as SdkReplicationConfig : false };
      await this.rpcRaw("init", this.initArgs);
      const sessionPath = `${this.options.home}/session.json`;
      if (auth === "restore") {
        let saved: { posture?: string; session: unknown; deviceJwk?: unknown; verificationMethod?: unknown; delegation?: unknown };
        try { saved = JSON.parse(await readFile(sessionPath, "utf8")) as typeof saved; }
        catch (error) { throw new HarnessError("RPC_PROTOCOL", "Saved combined session proof is missing or invalid", String(error)); }
        this.proof = saved;
        if (saved.posture === "delegate-session" || (!saved.posture && saved.delegation)) await this.rpcRaw("session.useDelegation", { delegation: saved, hosts: this.options.hosts ?? [this.options.host] });
        else await this.rpcRaw("session.restore", { session: saved.session, hosts: this.options.hosts ?? [this.options.host] });
      } else if (this.options.delegation !== undefined) {
        this.proof = this.options.delegation;
        await this.rpcRaw("session.useDelegation", { delegation: this.options.delegation, hosts: this.options.hosts ?? [this.options.host] });
      } else if (auth !== "session-only") {
        await this.rpcRaw("signIn", {});
        const { session } = await this.rpcRaw("session.export", {});
        const sessionRecord = typeof session === "object" && session !== null ? session as Record<string, unknown> : {};
        this.proof = { posture: "owner", session, deviceJwk: sessionRecord.jwk ?? null, verificationMethod: sessionRecord.verificationMethod ?? null, delegation: null };
        await mkdir(dirname(sessionPath), { recursive: true, mode: 0o700 });
        await writeFile(sessionPath, JSON.stringify(this.proof), { mode: 0o600 });
        await chmod(sessionPath, 0o600);
      }
      this.ready = true;
    } catch (error) {
      this.ready = false;
      this.failure ??= error instanceof Error ? error : new Error(String(error));
      throw this.failure;
    }
  }
  private async ensureStarted(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.ready && this.process) return;
    if (!this.startPromise) {
      const starting = this.start();
      this.startPromise = starting;
      try { await starting; } finally { if (this.startPromise === starting) this.startPromise = undefined; }
    } else await this.startPromise;
    if (!this.ready || !this.process) throw this.failure ?? new HarnessError("CLIENT_CRASHED", "SDK driver is not running");
  }
  private receive(line: string): void {
    let message: DriverLine;
    try { message = JSON.parse(line) as DriverLine; } catch { return; }
    if (message.type === "event") {
      const sole = message.inFlight.length === 1;
      const background = !message.inFlight.length || message.event.type === "replication.sync" && ["interval", "start"].includes(String(message.event.trigger));
      const attribution = background ? "background" : sole ? "op" : "ambiguous";
      const opSeq = attribution === "op" ? this.inFlight.get(message.inFlight[0]) ?? null : null;
      this.allEvents.push({ clientId: this.id, seq: this.allEvents.length + 1, opSeq, attribution, recvMono: performance.now(), event: message.event });
      return;
    }
    if (message.type !== "response") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    const response = message as RpcResponse;
    if (response.ok) pending.resolve(response.value);
    else pending.reject(Object.assign(new Error(response.error.message), { code: response.error.code, meta: response.error.meta }));
  }
  async rpc<O extends RpcOp>(op: O, args: RpcOps[O]["args"], options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<RpcOps[O]["value"]> {
    if (options.signal?.aborted) throw new HarnessError("ABORTED", `SDK ${op} was aborted`, options.signal.reason);
    await this.ensureStarted();
    return this.rpcRaw(op, args, options);
  }
  private async rpcRaw<O extends RpcOp>(op: O, args: RpcOps[O]["args"], options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<RpcOps[O]["value"]> {
    if (options.signal?.aborted) throw new HarnessError("ABORTED", `SDK ${op} was aborted`, options.signal.reason);
    const process = this.process;
    const stdin = process?.stdin;
    if (!stdin?.writable) throw this.failure ?? new HarnessError("CLIENT_CRASHED", "SDK driver is not running");
    const id = ++this.rpcId;
    const requestSeq = ++this.sequence;
    const request = { v: 1, id, op, args };
    const result = new Promise<RpcOps[O]["value"]>((resolvePromise, rejectPromise) => {
      const pending: Pending = { resolve: resolvePromise, reject: rejectPromise, op };
      let settled = false;
      const cancel = () => {
        pending.reject(new HarnessError("ABORTED", "SDK operation was aborted", options.signal?.reason));
        void this.rpc("cancel", { id }).catch(() => undefined);
      };
      pending.resolve = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(pending.timer);
        options.signal?.removeEventListener("abort", cancel);
        resolvePromise(value as RpcOps[O]["value"]);
      };
      pending.reject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(pending.timer);
        options.signal?.removeEventListener("abort", cancel);
        rejectPromise(error);
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.deadlineMs !== undefined) {
        pending.timer = setTimeout(() => {
          void this.rpc("cancel", { id }).catch(() => undefined);
          pending.reject(new HarnessError("DEADLINE_EXCEEDED", `SDK ${op} exceeded its deadline`));
        }, Math.max(0, options.deadlineMs) + 10_000);
      }
      this.inFlight.set(id, requestSeq);
      this.pending.set(id, pending);
      stdin.write(`${JSON.stringify(request)}\n`);
    });
    return result.finally(() => this.inFlight.delete(id));
  }
  private async timed<T>(action: () => Promise<T>): Promise<{ value: T; opSeq: number; startedMono: number; durationMs: number; events: EventEnvelope[] }> {
    await this.ensureStarted();
    const opSeq = this.sequence + 1;
    const startedMono = performance.now();
    const since = this.eventCursor();
    const pending = action();
    const value = await pending;
    const durationMs = performance.now() - startedMono;
    const events = this.events({ since }).filter((event) => event.opSeq === opSeq);
    return { value, opSeq, startedMono, durationMs, events };
  }
  eventCursor(): number { return this.allEvents.at(-1)?.seq ?? 0; }
  events(query: EventQuery = {}): EventEnvelope[] { return this.allEvents.filter((event) => (query.since === undefined || event.seq > query.since) && (query.opSeq === undefined || event.opSeq === query.opSeq) && (query.type === undefined || (Array.isArray(query.type) ? query.type : [query.type]).includes(event.event.type))); }
  replicaDir(): string { return this.options.storageDir; }
  async scanReplica(needle: Uint8Array): Promise<string[]> {
    const matches: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let files; try { files = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const file of files) { const path = `${dir}/${file.name}`; if (file.isDirectory()) await walk(path); else if (file.isFile() && Buffer.from(await readFile(path)).includes(Buffer.from(needle))) matches.push(path); }
    };
    await walk(this.options.storageDir);
    return matches;
  }
  withHost(alias: string): KvClient {
    const hosts = [...new Set([...(this.options.hosts ?? [this.options.host]), alias])];
    return new SdkClientImpl({ ...this.options, host: alias, domain: new URL(alias).hostname, hosts, home: this.options.home, storageDir: this.options.storageDir, auth: "restore" });
  }
  async get(key: string, options: OpOptions & { source?: "network"; maxResponseBytes?: number; space?: string } = {}): Promise<GetResult> {
    assertSdkOptions(options);
    const result = await this.timed(() => this.rpc("kv.get", { key, source: options.source, maxResponseBytes: options.maxResponseBytes, timeoutMs: options.deadlineMs, space: options.space }, options));
    const readEvent = result.events.find((item) => item.event.type === "replication.read")?.event as GetResult["readEvent"];
    const sdkResult = result.value as unknown as { found?: boolean; value?: { $b64: string }; ok?: boolean; error?: { code?: string } };
    const failed = sdkResult.ok === false && sdkResult.error?.code !== "KV_NOT_FOUND";
    const found = !failed && sdkResult.found === true;
    return {
      opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events,
      ok: !failed, found,
      ...(found && sdkResult.value ? { value: new Uint8Array(Buffer.from(sdkResult.value.$b64, "base64")) } : {}),
      ...(failed && sdkResult.error?.code ? { code: sdkResult.error.code } : {}),
      ...(readEvent ? { readEvent, read: readEvent } : {}),
    };
  }
  async put(key: string, value: string | Uint8Array, options: PutOptions = {}): Promise<WriteResult> {
    assertSdkOptions(options);
    const result = await this.timed(() => this.rpc("kv.put", { key, value: { $b64: Buffer.from(value).toString("base64") }, contentType: options.contentType, timeoutMs: options.deadlineMs }, options));
    const sdkResult = result.value as unknown as { ok?: boolean; error?: { code?: string } };
    const failed = sdkResult.ok === false;
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: !failed, outcome: failed ? "failed" : "committed", ...(failed && sdkResult.error?.code ? { code: sdkResult.error.code } : {}) };
  }
  async del(key: string, options?: OpOptions): Promise<WriteResult> {
    if (options) assertSdkOptions(options);
    const result = await this.timed(() => this.rpc("kv.delete", { key, timeoutMs: options?.deadlineMs }, options));
    const sdkResult = result.value as unknown as { ok?: boolean; error?: { code?: string } };
    const failed = sdkResult.ok === false;
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: !failed, outcome: failed ? "failed" : "committed", ...(failed && sdkResult.error?.code ? { code: sdkResult.error.code } : {}) };
  }
  async list(prefix: string, options: OpOptions & { source?: "network"; limit?: number; cursor?: string } = {}) {
    assertSdkOptions(options);
    const result = await this.timed(() => this.rpc("kv.list", { prefix, source: options.source, limit: options.limit, cursor: options.cursor, timeoutMs: options.deadlineMs }, options));
    const sdkResult = result.value as unknown as { ok?: boolean; error?: { code?: string }; keys?: string[]; nextCursor?: string };
    const failed = sdkResult.ok === false;
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: !failed, ...(failed && sdkResult.error?.code ? { code: sdkResult.error.code } : {}), ...(failed ? {} : { keys: sdkResult.keys, nextCursor: sdkResult.nextCursor }) };
  }
  async batchPut(items: { key: string; value: string | Uint8Array; contentType?: string }[], options?: OpOptions) {
    if (options) assertSdkOptions(options);
    const payload = items.map((item) => ({ ...item, value: { $b64: Buffer.from(item.value).toString("base64") } }));
    const result = await this.timed(() => this.rpc("kv.batchPut", { items: payload, timeoutMs: options?.deadlineMs }, options));
    const sdkResult = result.value as unknown as { ok?: boolean; error?: { code?: string }; written?: string[] };
    const failed = sdkResult.ok === false;
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: !failed, ...(failed && sdkResult.error?.code ? { code: sdkResult.error.code } : {}), ...(failed ? {} : { written: sdkResult.written }) };
  }
  async sync(options: OpOptions & { prefix?: string } = {}) {
    assertSdkOptions(options);
    const result = await this.timed(() => this.rpc("replication.sync", { prefix: options.prefix, timeoutMs: options.deadlineMs }, options));
    const sdkResult = result.value as unknown as { ok?: boolean; error?: { code?: string } };
    const failed = sdkResult.ok === false;
    const syncs = Array.isArray(result.value) ? result.value : [];
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: !failed, ...(failed && sdkResult.error?.code ? { code: sdkResult.error.code } : {}), syncs };
  }
  async status(options?: CallOptions): Promise<StatusEntry[]> {
    return await this.rpc("replication.status", {}, options) as StatusEntry[];
  }
  async purge(options?: CallOptions) {
    const result = await this.timed(() => this.rpc("replication.purge", {}, options));
    const sdkResult = result.value as unknown as { ok?: boolean; error?: { code?: string }; purged?: string[]; failed?: { prefix: string; code: string }[] };
    const purged = sdkResult.purged ?? [];
    const failed = sdkResult.failed ?? [];
    const rejected = sdkResult.ok === false;
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: !rejected && failed.length === 0, purged, failed, ...(rejected && sdkResult.error?.code ? { code: sdkResult.error.code } : {}) };
  }
  async clearPending(options?: { keys?: string[] } & CallOptions) {
    const result = await this.timed(() => this.rpc("replication.clearPending", { keys: options?.keys }, options));
    const sdkResult = result.value as unknown as { ok?: boolean; error?: { code?: string }; cleared?: number };
    const failed = sdkResult.ok === false;
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: !failed, cleared: failed ? 0 : sdkResult.cleared ?? 0, ...(failed && sdkResult.error?.code ? { code: sdkResult.error.code } : {}) };
  }
  async authority() {
    let proof = this.proof && typeof this.proof === "object" ? this.proof as Record<string, unknown> : {};
    try { proof = JSON.parse(await readFile(`${this.options.home}/session.json`, "utf8")) as Record<string, unknown>; } catch { /* no persisted session yet */ }
    const session = proof.session && typeof proof.session === "object" ? proof.session as Record<string, unknown> : {};
    const delegation = proof.delegation && typeof proof.delegation === "object" ? proof.delegation as Record<string, unknown> : {};
    const toMillis = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
    const delegate = proof.posture === "delegate-session" || (!proof.posture && proof.delegation !== undefined) || this.options.auth === "session-only";
    return {
      posture: delegate ? "delegate-session" as const : "owner" as const,
      sessionExpiresAt: toMillis(session.expiresAt ?? session.expiry ?? session.expirationTime),
      grantExpiresAt: delegate ? toMillis(delegation.expiresAt ?? delegation.expiry ?? delegation.expiration) : null,
    };
  }
  async restart(options: { auth?: "restore" | "fresh-sign-in"; replication?: ReplicationSpec | false } & OpOptions = {}): Promise<void> {
    assertSdkOptions(options);
    if (options.signal?.aborted) throw new HarnessError("ABORTED", "SDK restart was aborted", options.signal.reason);
    await this.stopProcess(options.deadlineMs ?? 5_000, options.signal);
    if (options.signal?.aborted) throw new HarnessError("ABORTED", "SDK restart was aborted", options.signal.reason);
    if (options.replication !== undefined) {
      this.options.replication = options.replication ? { ...options.replication, storageDir: this.options.storageDir } : false;
      this.initArgs = undefined;
    }
    this.failure = undefined;
    this.ready = false;
    await this.start(options.auth ?? "restore");
  }
  private async stopProcess(deadlineMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.process) return true;
    const current = this.process;
    this.expectedExits.add(current);
    const deadlineAt = performance.now() + deadlineMs;
    try { await this.rpc("close", { timeoutMs: deadlineMs }, { deadlineMs, signal }); } catch { /* process ladder below */ }
    if (await this.waitForExit(current, Math.max(0, deadlineAt - performance.now()))) { this.process = undefined; return true; }
    current.kill("SIGTERM");
    if (await this.waitForExit(current, 2_000)) { this.process = undefined; return false; }
    current.kill("SIGKILL");
    await this.waitForExit(current, 5_000);
    this.process = undefined;
    return false;
  }
  private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    const exitEvent = this.exitEvents.get(child);
    if (!exitEvent) return child.exitCode !== null || child.signalCode !== null;
    const closeEvent = this.closeEvents.get(child);
    const terminated = closeEvent ? Promise.all([exitEvent, closeEvent]).then(() => undefined) : exitEvent;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    void terminated.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
    return await promise;
  }
  async kill(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void> {
    const child = this.process;
    if (!child) return;
    child.kill(signal);
    await this.waitForExit(child, 5_000);
  }
  async close(options: { deadlineMs: number }): Promise<{ graceful: boolean }> { return { graceful: await this.stopProcess(options.deadlineMs) }; }
}

function validateDeviceProof(deviceProof: unknown): void {
  const proof = typeof deviceProof === "object" && deviceProof !== null ? deviceProof as Record<string, unknown> : {};
  const grant = typeof proof.delegation === "object" && proof.delegation !== null ? proof.delegation as Record<string, unknown> : proof;
  const header = typeof grant.delegationHeader === "object" && grant.delegationHeader !== null ? grant.delegationHeader as Record<string, unknown> : {};
  if (!proof.deviceJwk || !proof.verificationMethod || !header.Authorization || !grant.cid || !grant.spaceId) {
    throw new HarnessError("CLIENT_UNSUPPORTED_OPTION", "SDK delegate-session deviceProof must include deviceJwk, verificationMethod, and a delegation grant");
  }
}

export async function createSdkClient(input: ClientConstructionOptions): Promise<SdkClientImpl> {
  const spec = input.spec;
  if (spec.kind !== "sdk") throw new HarnessError("CLIENT_UNSUPPORTED_OPTION", `Client ${spec.id} is not an SDK client`);
  const ownerPosture = spec.auth.posture === "owner";
  if (spec.deviceProof !== undefined) {
    if (ownerPosture) throw new HarnessError("CLIENT_UNSUPPORTED_OPTION", "SDK deviceProof requires delegate-session auth posture");
    validateDeviceProof(spec.deviceProof);
  }
  const host = spec.endpoint ?? input.topology.proxy(`client:${spec.id}->${spec.node}`).listenUrl;
  const home = resolve(input.environment.resultsDir, input.environment.runId, input.topology.id, "clients", spec.id, "home");
  const storageDir = resolve(spec.storageRoot ?? join(home, "replica"));
  const sdkLoader = join(input.sut.root ?? "", input.sut.source === "published" ? "tc893-load-node-sdk.mjs" : "node_modules/.tc893/load-node-sdk.mjs");
  if (!input.sut.root) throw new HarnessError("PREFLIGHT_FAILED", "SDK client requires a resolved SUT root");
  const nodeOwnerExists = input.topology.spec.clients.some((client) => client.kind === "cli" && client.identity === spec.identity && client.auth.posture === "owner");
  const privateKeyHex = ownerPosture
    ? nodeOwnerExists
      ? registeredSdkIdentityPrivateKey(input.environment.runId, spec.identity)
      : sdkIdentityPrivateKey(input.environment.runId, spec.identity)
    : undefined;
  if (ownerPosture && !privateKeyHex) {
    throw new HarnessError("TOPOLOGY_INVALID", `CLI owner identity ${spec.identity} must initialize before its SDK clients`);
  }
  const preloadDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../preloads");
  const hosts = [
    host,
    ...(spec.extraHosts ?? []).map((extra) => input.topology.proxy(`client:${spec.id}->${extra.node}`).listenUrl),
  ];
  return new SdkClientImpl({
    id: spec.id,
    host,
    domain: new URL(host).hostname,
    home,
    storageDir,
    sdkLoader,
    privateKeyHex,
    sessionExpiryMs: spec.auth.sessionExpiryMs,
    replication: spec.replication ? { ...spec.replication, storageDir } : false,
    auth: ownerPosture ? "fresh-sign-in" : "session-only",
    delegation: ownerPosture ? undefined : spec.deviceProof,
    hosts,
    preloads: spec.preloads?.map((preload) => join(preloadDirectory, preload === "fetch-faults" ? "fetch-faults.cjs" : "node20.cjs")),
  });
}
