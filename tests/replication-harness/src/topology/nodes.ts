import type { Backend, CallOptions } from "../contracts/common";
import { HarnessError } from "../contracts/common";
import type { NodeHandle, NodeInfo, ResolvedImage, ResourceRef } from "../contracts/lifecycle";
import type { NodeSpec } from "../contracts/topology";
import { waitFor } from "../contracts/clock";
import type { RunEnvironment } from "../contracts/lifecycle";
import { Docker, labels, remainingMs } from "./docker";
import { ResourceLedger } from "./ledger";

export interface RunningNode { handle: NodeHandle; volume: string; container: string }
export async function createNode(input: { docker: Docker; env: RunEnvironment; ledger: ResourceLedger; spec: NodeSpec; backend: Backend; topoId: string; deadlineAt: number; image: ResolvedImage; network: string; networkAlias?: string; containerName?: string; pgDatabase?: string; signal?: AbortSignal }): Promise<RunningNode> {
  const { docker, env, ledger, spec, backend, topoId, image, network } = input;
  const name = input.containerName ?? `tc893-${topoId}-${spec.id}`;
  const volume = `tc893-${topoId}-${spec.id}`;
  const resourceLabels = { "tc893.run": env.runId, "tc893.topo": topoId };
  await ledger.intent("volume", volume, resourceLabels);
  await docker.run(["volume", "create", ...labels(env.runId, topoId), volume], { signal: input.signal, deadlineMs: remainingMs(env.clock, input.deadlineAt) });
  await ledger.created({ kind: "volume", name: volume, labels: resourceLabels });
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
  const environment = new Map(Object.entries(spec.env ?? {}));
  environment.set("TINYCLOUD_STORAGE__DATADIR", "/data");
  environment.set("TINYCLOUD_KEYS__TYPE", "Static");
  environment.set("TINYCLOUD_KEYS__SECRET", secret);
  environment.set("TINYCLOUD_PORT", "8000");
  environment.set("ROCKET_PORT", "8000");
  if (backend !== "sqlite") environment.set("TINYCLOUD_STORAGE__DATABASE", `postgres://postgres:postgres@pg:5432/${input.pgDatabase ?? `node_${spec.id}`}`);
  const redactions = [...environment.values()].filter((value) => value.length > 0);
  const args = ["run", "-d", "--name", name, "--network", network, "--network-alias", input.networkAlias ?? spec.id, ...labels(env.runId, topoId), "-v", `${volume}:/data`, "-p", "127.0.0.1::8000"];
  for (const [key, value] of environment) args.push("-e", `${key}=${value}`);
  args.push(image.pinned);
  await ledger.intent("container", name, resourceLabels);
  const container = (await docker.run(args, { signal: input.signal, deadlineMs: remainingMs(env.clock, input.deadlineAt) })).stdout.trim();
  await ledger.created({ kind: "container", name, labels: resourceLabels });
  const port = (await docker.run(["port", container, "8000/tcp"], { deadlineMs: remainingMs(env.clock, input.deadlineAt) })).stdout.trim();
  const diagnosticsUrl = `http://127.0.0.1:${port.slice(port.lastIndexOf(":") + 1)}`;
  const handle = new DockerNodeHandle(docker, spec.id, backend, image, container, volume, diagnosticsUrl, env, redactions);
  try { await handle.ready({ signal: input.signal, deadlineMs: Math.min(60_000, remainingMs(env.clock, input.deadlineAt)) }); }
  catch (error) {
    if (error instanceof HarnessError && (error.code === "ABORTED" || (error.code === "DEADLINE_EXCEEDED" && input.deadlineAt <= env.clock.now()))) throw error;
    let text = "";
    if (input.deadlineAt > env.clock.now()) {
      try {
        const logs = await docker.tryRun(["logs", "--tail", "100", container], { deadlineMs: Math.min(2000, input.deadlineAt - env.clock.now()) });
        text = `${logs.stdout}${logs.stderr}`;
      } catch { }
    }
    for (const value of redactions) text = text.replaceAll(value, "[REDACTED]");
    throw new HarnessError("READINESS_TIMEOUT", `node ${spec.id} failed readiness: ${text.slice(-2048)}`, error);
  }
  return { handle, volume, container };
}
export class DockerNodeHandle implements NodeHandle {
  constructor(private readonly docker: Docker, readonly id: string, readonly backend: Backend, readonly image: ResolvedImage, private container: string, private readonly volume: string, public diagnosticsUrl: string, private readonly env: RunEnvironment, private readonly redactions: string[]) {}
  async info(options: CallOptions = {}): Promise<NodeInfo> {
    try { const response = await fetch(`${this.diagnosticsUrl}/info`, { signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(options.deadlineMs ?? 10_000, 10_000))]) : AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return await response.json() as NodeInfo; }
    catch (error) {
      if (options.signal?.aborted) throw new HarnessError("ABORTED", String(options.signal.reason ?? "aborted"));
      if (error instanceof DOMException && error.name === "TimeoutError") throw new HarnessError("DEADLINE_EXCEEDED", `node ${this.id} /info timed out`, error);
      throw new HarnessError("DOCKER_FAILED", `node ${this.id} /info failed`, error);
    }
  }
  async ready(options: CallOptions): Promise<void> {
    const deadlineAt = this.env.clock.now() + (options.deadlineMs ?? 60_000);
    await waitFor(this.env.clock, async () => { try { const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000); const response = await fetch(`${this.diagnosticsUrl}/healthz`, { signal }); return response.status === 200 ? true : undefined; } catch { return undefined; } }, { deadlineMs: remainingMs(this.env.clock, deadlineAt), intervalMs: 250, describe: `${this.id} /healthz`, signal: options.signal });
    const info = await this.info({ ...options, deadlineMs: Math.min(10_000, remainingMs(this.env.clock, deadlineAt)) });
    if (info.version !== this.image.nodeVersion) throw new HarnessError("READINESS_TIMEOUT", `${this.id} version ${info.version} does not match ${this.image.nodeVersion}`);
    if (info.inTEE === true) throw new HarnessError("READINESS_TIMEOUT", `${this.id} unexpectedly reports inTEE=true`);
  }
  async stop(options: CallOptions = {}): Promise<void> { await this.docker.run(["stop", "-t", "10", this.container], options); }
  async start(options: CallOptions = {}): Promise<void> {
    const deadlineAt = this.env.clock.now() + (options.deadlineMs ?? 60_000);
    const callOptions = { signal: options.signal, deadlineMs: remainingMs(this.env.clock, deadlineAt) };
    await this.docker.run(["start", this.container], callOptions);
    await this.refreshPort(callOptions);
    await this.ready({ ...callOptions, deadlineMs: Math.min(60_000, remainingMs(this.env.clock, deadlineAt)) });
  }
  async restart(options: { hard?: boolean } & CallOptions = {}): Promise<void> {
    const deadlineAt = this.env.clock.now() + (options.deadlineMs ?? 60_000);
    const callOptions = { signal: options.signal, deadlineMs: remainingMs(this.env.clock, deadlineAt) };
    if (options.hard) {
      await this.docker.run(["kill", "-s", "KILL", this.container], callOptions);
      await this.docker.run(["start", this.container], { ...callOptions, deadlineMs: remainingMs(this.env.clock, deadlineAt) });
    } else await this.docker.run(["restart", "-t", "10", this.container], callOptions);
    await this.refreshPort({ ...callOptions, deadlineMs: remainingMs(this.env.clock, deadlineAt) });
    await this.ready({ ...callOptions, deadlineMs: Math.min(60_000, remainingMs(this.env.clock, deadlineAt)) });
  }
  async upgrade(): Promise<never> { throw new HarnessError("NOT_IMPLEMENTED", "upgrade belongs to S6a"); }
  async sql(): Promise<never> { throw new HarnessError("NOT_IMPLEMENTED", "sql belongs to S6a"); }
  async scanVolume(): Promise<never> { throw new HarnessError("NOT_IMPLEMENTED", "scanVolume is outside S1"); }
  async logs(options: { tailBytes?: number; deadlineMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    const result = await this.docker.tryRun(["logs", this.container], { deadlineMs: options.deadlineMs, signal: options.signal });
    let text = `${result.stdout}${result.stderr}`;
    for (const value of this.redactions) text = text.replaceAll(value, "[REDACTED]");
    return text.slice(-(options.tailBytes ?? 1_048_576));
  }
  private async refreshPort(options: CallOptions = {}): Promise<void> { const port = (await this.docker.run(["port", this.container, "8000/tcp"], options)).stdout.trim(); this.diagnosticsUrl = `http://127.0.0.1:${port.slice(port.lastIndexOf(":") + 1)}`; }
}

export async function createPostgres(input: { docker: Docker; env: RunEnvironment; ledger: ResourceLedger; topoId: string; network: string; nodes: readonly NodeSpec[]; variantC?: boolean; deadlineAt: number; signal?: AbortSignal }): Promise<{ container: string; volume: string }> {
  const { docker, env, ledger, topoId, network } = input;
  const name = `tc893-${topoId}-pg`, volume = `tc893-${topoId}-pgdata`, resourceLabels = { "tc893.run": env.runId, "tc893.topo": topoId };
  await ledger.intent("volume", volume, resourceLabels);
  await docker.run(["volume", "create", ...labels(env.runId, topoId), volume], { signal: input.signal, deadlineMs: remainingMs(env.clock, input.deadlineAt) });
  await ledger.created({ kind: "volume", name: volume, labels: resourceLabels });
  await ledger.intent("container", name, resourceLabels);
  const image = input.variantC ? "postgres:16-alpine" : "postgres:16";
  const args = ["run", "-d", "--name", name, "--network", network, "--network-alias", "pg", ...labels(env.runId, topoId), "-v", `${volume}:/var/lib/postgresql/data`, "-e", "POSTGRES_PASSWORD=postgres"];
  if (input.variantC) args.push("-e", "POSTGRES_INITDB_ARGS=--locale=C");
  args.push(image);
  await docker.run(args, { signal: input.signal, deadlineMs: remainingMs(env.clock, input.deadlineAt) });
  await ledger.created({ kind: "container", name, labels: resourceLabels });
  const readyDeadline = Math.min(input.deadlineAt, env.clock.now() + 60_000);
  while (env.clock.now() < readyDeadline) {
    try { await docker.run(["exec", name, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres"], { deadlineMs: Math.min(5000, remainingMs(env.clock, readyDeadline)), signal: input.signal }); break; }
    catch {
      if (input.signal?.aborted) throw new HarnessError("ABORTED", String(input.signal.reason ?? "aborted"));
      if (env.clock.now() >= input.deadlineAt) throw new HarnessError("DEADLINE_EXCEEDED", "PostgreSQL startup exceeded topology deadline");
      const pauseMs = Math.min(500, Math.max(0, readyDeadline - env.clock.now()));
      if (pauseMs > 0) await env.clock.sleep(pauseMs, input.signal);
    }
  }
  if (env.clock.now() >= input.deadlineAt) remainingMs(env.clock, input.deadlineAt);
  if (env.clock.now() >= readyDeadline) throw new HarnessError("READINESS_TIMEOUT", "PostgreSQL TCP readiness timed out");
  const ready = await docker.tryRun(["exec", name, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres"], { deadlineMs: remainingMs(env.clock, readyDeadline), signal: input.signal });
  if (ready.code !== 0) throw new HarnessError("READINESS_TIMEOUT", "PostgreSQL TCP readiness timed out");
  const check = await docker.run(["exec", name, "psql", "-h", "127.0.0.1", "-U", "postgres", "-qtAc", "select 1"], { deadlineMs: remainingMs(env.clock, input.deadlineAt), signal: input.signal });
  if (check.stdout.trim() !== "1") throw new HarnessError("READINESS_TIMEOUT", "PostgreSQL query readiness failed");
  for (const node of input.nodes) await docker.run(["exec", name, "psql", "-h", "127.0.0.1", "-U", "postgres", "-c", `CREATE DATABASE node_${node.id}`], { deadlineMs: remainingMs(env.clock, input.deadlineAt), signal: input.signal });
  return { container: name, volume };
}
