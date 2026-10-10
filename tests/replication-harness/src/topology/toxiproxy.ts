import { waitFor } from "../contracts/clock";
import type { CallOptions } from "../contracts/common";
import type { ProxyHandle, ToxicSpec } from "../contracts/faults";
import type { RunEnvironment, ResourceRef } from "../contracts/lifecycle";
import { HarnessError } from "../contracts/common";
import { Docker, labels, remainingMs } from "./docker";
import { ResourceLedger } from "./ledger";

interface ProxyConfig { name: string; listen: string; upstream: string; enabled?: boolean; toxics?: { name: string; type: string; stream: string; toxicity: number; attributes: Record<string, number> }[] }
interface ProxyEdge { name: string; node: string; host?: string; hostPort?: number }
export class Toxiproxy {
  readonly handles = new Map<string, ProxyHandle>();
  private readonly api: string;
  constructor(private readonly docker: Docker, private readonly container: string, apiPort: number, private readonly ports: Map<string, number>) { this.api = `http://127.0.0.1:${apiPort}`; }
  static async create(input: { docker: Docker; env: RunEnvironment; ledger: ResourceLedger; topoId: string; network: string; edges: ProxyEdge[]; deadlineAt: number; signal?: AbortSignal }): Promise<Toxiproxy> {
    const { docker, env, ledger, topoId, network } = input;
    const name = `tc893-${topoId}-tp`, resourceLabels = { "tc893.run": env.runId, "tc893.topo": topoId };
    await ledger.intent("container", name, resourceLabels);
    const args = ["run", "-d", "--name", name, "--network", network, ...labels(env.runId, topoId), "-p", "127.0.0.1::8474"];
    for (let index = 0; index < input.edges.length; index++) {
      const edge = input.edges[index];
      const binding = edge.hostPort === undefined ? `127.0.0.1::${20001 + index}` : `${edge.host ?? "127.0.0.1"}:${edge.hostPort}:${20001 + index}`;
      args.push("-p", binding);
    }
    args.push("ghcr.io/shopify/toxiproxy:2.12.0");
    await docker.run(args, { signal: input.signal, deadlineMs: remainingMs(env.clock, input.deadlineAt) });
    await ledger.created({ kind: "container", name, labels: resourceLabels });
    const apiPort = hostPort(await docker.run(["port", name, "8474/tcp"], { deadlineMs: remainingMs(env.clock, input.deadlineAt) }));
    const toxiproxy = new Toxiproxy(docker, name, apiPort, new Map());
    await waitFor(env.clock, async () => {
      try { const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000); const response = await fetch(`${toxiproxy.api}/version`, { signal }); return response.ok ? true : undefined; }
      catch { if (input.signal?.aborted) throw input.signal.reason; return undefined; }
    }, { deadlineMs: Math.min(30_000, remainingMs(env.clock, input.deadlineAt)), intervalMs: 250, describe: "Toxiproxy API readiness", signal: input.signal });
    for (const [index, edge] of input.edges.entries()) {
      const proxyName = edge.name.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 200);
      const port = 20001 + index;
      await toxiproxy.request("POST", "/proxies", { name: proxyName, listen: `0.0.0.0:${port}`, upstream: `${edge.node}:8000`, enabled: true }, { signal: input.signal, deadlineMs: remainingMs(env.clock, input.deadlineAt) });
      const published = hostPort(await docker.run(["port", name, `${port}/tcp`], { deadlineMs: remainingMs(env.clock, input.deadlineAt) }));
      toxiproxy.ports.set(proxyName, published);
      toxiproxy.handles.set(edge.name, new DockerProxyHandle(toxiproxy, edge.name, proxyName, published, edge.host ?? "127.0.0.1"));
    }
    return toxiproxy;
  }
  async request(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<Response> {
    const deadline = options.deadlineMs ?? 10_000;
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(deadline)]) : AbortSignal.timeout(deadline);
    let response: Response;
    try { response = await fetch(`${this.api}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal }); }
    catch (error) {
      if (options.signal?.aborted) throw new HarnessError("ABORTED", String(options.signal.reason ?? "aborted"));
      throw new HarnessError("DEADLINE_EXCEEDED", `Toxiproxy ${method} ${path} timed out after ${deadline}ms`, error);
    }
    if (!response.ok) throw new HarnessError("DOCKER_FAILED", `Toxiproxy ${method} ${path}: ${response.status} ${await response.text()}`);
    return response;
}
}
function hostPort(result: { stdout: string }): number { return Number(result.stdout.trim().split("\n")[0].slice(result.stdout.trim().split("\n")[0].lastIndexOf(":") + 1)); }
class DockerProxyHandle implements ProxyHandle {
  readonly listenUrl: string;
  constructor(private readonly owner: Toxiproxy, readonly name: string, private readonly proxyName: string, port: number, host = "127.0.0.1") { this.listenUrl = `http://${host}:${port}`; }
  async disable(options: CallOptions = {}): Promise<void> { await this.owner.request("POST", `/proxies/${encodeURIComponent(this.proxyName)}`, { enabled: false }, options); }
  async enable(options: CallOptions = {}): Promise<void> { await this.owner.request("POST", `/proxies/${encodeURIComponent(this.proxyName)}`, { enabled: true }, options); }
  async addToxic(toxic: ToxicSpec, options: CallOptions = {}): Promise<string> {
    const mapping = toxic.type === "latency" ? { type: toxic.type, attributes: { latency: toxic.latencyMs, jitter: toxic.jitterMs ?? 0 } }
      : toxic.type === "bandwidth" ? { type: toxic.type, attributes: { rate: toxic.rateKBps } }
      : toxic.type === "reset_peer" ? { type: toxic.type, attributes: { timeout: toxic.timeoutMs } }
      : toxic.type === "limit_data" ? { type: toxic.type, attributes: { bytes: toxic.bytes } }
      : toxic.type === "timeout" ? { type: toxic.type, attributes: { timeout: toxic.timeoutMs } }
      : { type: toxic.type, attributes: { delay: toxic.delayMs } };
    const body = { name: `${this.proxyName}-${crypto.randomUUID()}`, type: mapping.type, stream: toxic.stream ?? "downstream", toxicity: toxic.toxicity ?? 1, attributes: mapping.attributes };
    await this.owner.request("POST", `/proxies/${encodeURIComponent(this.proxyName)}/toxics`, body, options);
    return body.name;
  }
  async removeToxic(name: string, options: CallOptions = {}): Promise<void> { await this.owner.request("DELETE", `/proxies/${encodeURIComponent(this.proxyName)}/toxics/${encodeURIComponent(name)}`, undefined, options); }
  async clear(options: CallOptions = {}): Promise<void> {
    const state = await this.state(options);
    for (const toxic of state.toxics) await this.removeToxic(toxic.name, options);
    await this.enable(options);
  }
  async state(options: CallOptions = {}): Promise<{ enabled: boolean; toxics: (ToxicSpec & { name: string })[] }> {
    const response = await this.owner.request("GET", `/proxies/${encodeURIComponent(this.proxyName)}`, undefined, options);
    const config = await response.json() as ProxyConfig;
    const toxics = (config.toxics ?? []).map((toxic): ToxicSpec & { name: string } => {
      const base = { stream: toxic.stream as ToxicSpec["stream"], toxicity: toxic.toxicity, name: toxic.name };
      if (toxic.type === "latency") return { ...base, type: "latency", latencyMs: toxic.attributes.latency, jitterMs: toxic.attributes.jitter };
      if (toxic.type === "bandwidth") return { ...base, type: "bandwidth", rateKBps: toxic.attributes.rate };
      if (toxic.type === "reset_peer") return { ...base, type: "reset_peer", timeoutMs: toxic.attributes.timeout };
      if (toxic.type === "limit_data") return { ...base, type: "limit_data", bytes: toxic.attributes.bytes };
      if (toxic.type === "timeout") return { ...base, type: "timeout", timeoutMs: toxic.attributes.timeout };
      return { ...base, type: "slow_close", delayMs: toxic.attributes.delay };
    });
    return { enabled: config.enabled ?? false, toxics };
  }
}
