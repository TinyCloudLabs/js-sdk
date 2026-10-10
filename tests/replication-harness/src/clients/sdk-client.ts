import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { HarnessError } from "../contracts/common";
import type { EventEnvelope, EventQuery } from "../contracts/events";
import type { CallOptions } from "../contracts/common";
import type { GetResult, KvClient, OpOptions, PutOptions, SdkClient, StatusEntry, WriteResult } from "../contracts/client";
import type { RpcOp, RpcOps, RpcResponse, DriverLine, SdkReplicationConfig } from "../contracts/rpc";
import type { ClientSpec, ReplicationSpec } from "../contracts/topology";

const driverPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../sdk-driver.mjs");
export interface SdkClientOptions {
  id: string; host: string; domain: string; home: string; storageDir: string; sdkLoader: string; node?: string; preloads?: string[];
  privateKeyHex?: string; sessionExpiryMs?: number; replication?: (ReplicationSpec & { storageDir: string }) | false;
  auth?: "restore" | "fresh-sign-in"; delegation?: unknown; hosts?: string[];
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
  private rpcId = 0;
  private pending = new Map<number, Pending>();
  private allEvents: EventEnvelope[] = [];
  private inFlight = new Map<number, number>();
  private initArgs?: RpcOps["init"]["args"];
  private proof?: unknown;
  constructor(options: SdkClientOptions) { this.id = options.id; this.options = options; }
  private async start(auth: "restore" | "fresh-sign-in" = this.options.auth ?? "fresh-sign-in"): Promise<void> {
    await mkdir(this.options.home, { recursive: true, mode: 0o700 });
    await mkdir(this.options.storageDir, { recursive: true, mode: 0o700 });
    const nodeBin = this.options.node ?? process.execPath;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, HOME: this.options.home, TC_HOME: this.options.home, TC893_LOADER: this.options.sdkLoader, TC893_HOME: this.options.home };
    const child = spawn(nodeBin, [...(this.options.preloads ?? []).flatMap((preload) => ["--require", preload]), driverPath], { cwd: this.options.home, env, stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    const outputStream = child.stdout;
    const errorStream = child.stderr;
    if (!outputStream || !errorStream) throw new HarnessError("CLIENT_CRASHED", "SDK driver streams are unavailable");
    let partial = "";
    outputStream.on("data", (chunk: Buffer) => {
      partial += chunk.toString("utf8");
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.length) this.receive(line);
    });
    errorStream.on("data", () => {});
    child.once("exit", (code, signal) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new HarnessError("CLIENT_CRASHED", `SDK driver exited (${code ?? signal})`, { id, op: pending.op }));
      }
      this.pending.clear();
      this.process = undefined;
    });
    const loaded = await this.rpc("hello", {});
    if (loaded.driver !== "tc893-sdk-driver" || loaded.protocol !== 1) throw new HarnessError("RPC_PROTOCOL", "Unexpected SDK driver hello response", loaded);
    if (!this.initArgs) this.initArgs = { host: this.options.host, domain: this.options.domain, privateKeyHex: this.options.privateKeyHex, sessionExpiryMs: this.options.sessionExpiryMs, replication: this.options.replication ? { ...this.options.replication, storageDir: this.options.storageDir } as SdkReplicationConfig : false };
    await this.rpc("init", this.initArgs);
    const sessionPath = `${this.options.home}/session.json`;
    if (auth === "restore") {
      try {
        const saved = JSON.parse(await readFile(sessionPath, "utf8")) as { posture?: string; session: unknown; deviceJwk?: unknown; verificationMethod?: unknown; delegation?: unknown };
        this.proof = saved;
        if (saved.posture === "delegate-session" || (!saved.posture && saved.delegation)) await this.rpc("session.useDelegation", { delegation: saved, hosts: this.options.hosts ?? [this.options.host] });
        else await this.rpc("session.restore", { session: saved.session, hosts: this.options.hosts ?? [this.options.host] });
      } catch (error) { throw new HarnessError("RPC_PROTOCOL", "Saved combined session proof is missing or invalid", String(error)); }
    } else if (this.options.delegation) {
      this.proof = this.options.delegation;
      await this.rpc("session.useDelegation", { delegation: this.options.delegation, hosts: this.options.hosts ?? [this.options.host] });
    } else {
      await this.rpc("signIn", {});
      const { session } = await this.rpc("session.export", {});
      const sessionRecord = typeof session === "object" && session !== null ? session as Record<string, unknown> : {};
      this.proof = { posture: "owner", session, deviceJwk: sessionRecord.jwk ?? null, verificationMethod: sessionRecord.verificationMethod ?? null, delegation: null };
      await mkdir(dirname(sessionPath), { recursive: true, mode: 0o700 });
      await writeFile(sessionPath, JSON.stringify(this.proof), { mode: 0o600 });
      await chmod(sessionPath, 0o600);
    }
  }
  private async ensureStarted(): Promise<void> {
    if (this.process) return;
    if (!this.startPromise) {
      const starting = this.start();
      this.startPromise = starting;
      try { await starting; } finally { if (this.startPromise === starting) this.startPromise = undefined; }
    } else await this.startPromise;
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
    if (!this.process && op !== "hello") await this.ensureStarted();
    const process = this.process;
    const stdin = process?.stdin;
    if (!stdin?.writable) throw new HarnessError("CLIENT_CRASHED", "SDK driver is not running");
    const id = ++this.rpcId;
    const requestSeq = ++this.sequence;
    const request = { v: 1, id, op, args };
    const result = new Promise<RpcOps[O]["value"]>((resolvePromise, rejectPromise) => {
      const pending: Pending = { resolve: resolvePromise, reject: rejectPromise, op };
      const cancel = () => { void this.rpc("cancel", { id }).catch(() => undefined); rejectPromise(new HarnessError("ABORTED", "SDK operation was aborted", options.signal?.reason)); };
      options.signal?.addEventListener("abort", cancel, { once: true });
      pending.timer = options.deadlineMs === undefined ? undefined : setTimeout(() => {
        void this.rpc("cancel", { id }).catch(() => undefined);
        rejectPromise(new HarnessError("DEADLINE_EXCEEDED", `SDK ${op} exceeded its deadline`));
      }, options.deadlineMs);
      pending.resolve = (value) => { options.signal?.removeEventListener("abort", cancel); resolvePromise(value as RpcOps[O]["value"]); };
      this.inFlight.set(id, requestSeq);
      pending.reject = (error) => { options.signal?.removeEventListener("abort", cancel); rejectPromise(error); };
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
  withHost(alias: string): KvClient { return new SdkClientImpl({ ...this.options, host: alias, home: this.options.home, storageDir: this.options.storageDir, auth: "restore" }); }
  async get(key: string, options: OpOptions & { source?: "network"; maxResponseBytes?: number; space?: string } = {}): Promise<GetResult> {
    assertSdkOptions(options);
    const result = await this.timed(() => this.rpc("kv.get", { key, source: options.source, maxResponseBytes: options.maxResponseBytes, timeoutMs: options.deadlineMs, space: options.space }, options));
    const readEvent = result.events.find((item) => item.event.type === "replication.read")?.event as GetResult["readEvent"];
    return {
      opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: true, found: result.value.found,
      ...(result.value.value !== undefined ? { value: new Uint8Array(Buffer.from(result.value.value.$b64, "base64")) } : {}),
      ...(readEvent ? { readEvent, read: readEvent } : {}),
    };
  }
  async put(key: string, value: string | Uint8Array, options: PutOptions = {}): Promise<WriteResult> {
    assertSdkOptions(options);
    const result = await this.timed(() => this.rpc("kv.put", { key, value: { $b64: Buffer.from(value).toString("base64") }, contentType: options.contentType, timeoutMs: options.deadlineMs }, options));
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: true, outcome: "committed" };
  }
  async del(key: string, options?: OpOptions): Promise<WriteResult> {
    if (options) assertSdkOptions(options);
    const result = await this.timed(() => this.rpc("kv.delete", { key, timeoutMs: options?.deadlineMs }, options));
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: true, outcome: "committed" };
  }
  async list(prefix: string, options: OpOptions & { source?: "network"; limit?: number; cursor?: string } = {}) {
    assertSdkOptions(options);
    const result = await this.timed(() => this.rpc("kv.list", { prefix, source: options.source, limit: options.limit, cursor: options.cursor, timeoutMs: options.deadlineMs }, options));
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: true, keys: result.value.keys, nextCursor: result.value.nextCursor };
  }
  async batchPut(items: { key: string; value: string | Uint8Array; contentType?: string }[], options?: OpOptions) {
    if (options) assertSdkOptions(options);
    const payload = items.map((item) => ({ ...item, value: { $b64: Buffer.from(item.value).toString("base64") } }));
    const result = await this.timed(() => this.rpc("kv.batchPut", { items: payload, timeoutMs: options?.deadlineMs }, options));
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: true, written: result.value.written };
  }
  async sync(options: OpOptions & { prefix?: string } = {}) {
    assertSdkOptions(options);
    const result = await this.timed(() => this.rpc("replication.sync", { prefix: options.prefix, timeoutMs: options.deadlineMs }, options));
    const syncs = Array.isArray(result.value) ? result.value : [];
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: true, syncs };
  }
  async status(options?: CallOptions): Promise<StatusEntry[]> {
    return await this.rpc("replication.status", {}, options) as StatusEntry[];
  }
  async purge(options?: CallOptions) {
    const result = await this.timed(() => this.rpc("replication.purge", {}, options));
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: result.value.failed.length === 0, purged: result.value.purged, failed: result.value.failed };
  }
  async clearPending(options?: { keys?: string[] } & CallOptions) {
    const result = await this.timed(() => this.rpc("replication.clearPending", { keys: options?.keys }, options));
    return { opSeq: result.opSeq, startedMono: result.startedMono, durationMs: result.durationMs, events: result.events, ok: true, cleared: result.value.cleared };
  }
  async authority() {
    let proof = this.proof && typeof this.proof === "object" ? this.proof as Record<string, unknown> : {};
    try { proof = JSON.parse(await readFile(`${this.options.home}/session.json`, "utf8")) as Record<string, unknown>; } catch { /* no persisted session yet */ }
    const session = proof.session && typeof proof.session === "object" ? proof.session as Record<string, unknown> : {};
    const delegation = proof.delegation && typeof proof.delegation === "object" ? proof.delegation as Record<string, unknown> : {};
    const toMillis = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
    return {
      posture: proof.posture === "delegate-session" || (!proof.posture && proof.delegation) ? "delegate-session" as const : "owner" as const,
      sessionExpiresAt: toMillis(session.expiresAt ?? session.expiry ?? session.expirationTime),
      grantExpiresAt: toMillis(delegation.expiresAt ?? delegation.expiry ?? delegation.expiration),
    };
  }
  async restart(options: { auth: "restore" | "fresh-sign-in"; replication?: ReplicationSpec | false } & OpOptions): Promise<void> {
    assertSdkOptions(options);
    if (options.signal?.aborted) throw new HarnessError("ABORTED", "SDK restart was aborted", options.signal.reason);
    await this.stopProcess(options.deadlineMs ?? 5_000, options.signal);
    if (options.signal?.aborted) throw new HarnessError("ABORTED", "SDK restart was aborted", options.signal.reason);
    if (options.replication !== undefined) {
      this.options.replication = options.replication ? { ...options.replication, storageDir: this.options.storageDir } : false;
      this.initArgs = undefined;
    }
    await this.start(options.auth);
  }
  private async stopProcess(deadlineMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.process) return true;
    const current = this.process;
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
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolvePromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exited: boolean) => { if (timer) clearTimeout(timer); child.off("exit", onExit); resolvePromise(exited); };
      const onExit = () => finish(true);
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) finish(true);
      else timer = setTimeout(() => finish(false), timeoutMs);
    });
  }
  async kill(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void> { this.process?.kill(signal); }
  async close(options: { deadlineMs: number }): Promise<{ graceful: boolean }> { return { graceful: await this.stopProcess(options.deadlineMs) }; }
}

export function createSdkClient(input: { id: string; host: string; spec: ClientSpec; home: string; sdkLoader: string; storageDir: string; domain?: string; privateKeyHex?: string }): SdkClient {
  const host = input.spec.endpoint ?? input.host;
  const storageDir = input.spec.storageRoot ?? input.storageDir;
  const delegation = input.spec.auth.posture === "delegate-session" ? input.spec.deviceProof : undefined;
  return new SdkClientImpl({
    id: input.id, host, domain: input.domain ?? new URL(host).hostname, home: input.home, storageDir, sdkLoader: input.sdkLoader,
    privateKeyHex: input.privateKeyHex, sessionExpiryMs: input.spec.auth.sessionExpiryMs,
    replication: input.spec.replication ? { ...input.spec.replication, storageDir } : false,
    auth: "fresh-sign-in", delegation,
  });
}
