import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Backend } from "../contracts/common";
import { HarnessError } from "../contracts/common";
import type { ClientConstructor } from "../contracts/frozen";
import type { DisposeOptions, DisposeReport, NodeHandle, ResourceRef, RunEnvironment, Topology, TopologyFactory } from "../contracts/lifecycle";
import type { KvClient, CliClient, SdkClient } from "../contracts/client";
import type { TopologySpec } from "../contracts/topology";
import { validateTopology } from "../contracts/topology";
import { Docker, labels, remainingMs } from "./docker";
import { ResourceLedger } from "./ledger";
import { createNode, createPostgres } from "./nodes";
import { Toxiproxy } from "./toxiproxy";
import { collectTopologyArtefacts } from "./artefacts";
import { sharedProxyEndpoint, sharedProxyEndpointDetails } from "./shared-endpoint";

let clientConstructor: ClientConstructor | undefined;
export function registerClientConstructor(constructor?: ClientConstructor): void { clientConstructor = constructor; }
export class DockerTopologyFactory implements TopologyFactory {
  async create(env: RunEnvironment, input: TopologySpec, options: { topoId: string; backend: Backend; signal?: AbortSignal; deadlineMs?: number }): Promise<Topology> {
    const deadlineAt = env.clock.now() + (options.deadlineMs ?? 120_000);
    let spec = input;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await this.createAttempt(env, spec, { ...options, deadlineMs: remainingMs(env.clock, deadlineAt) }); }
      catch (error) {
        if (attempt === 3 || !isRetryableBindConflict(error) || !spec.clients.some((client) => client.endpoint && sharedProxyEndpointDetails(client.endpoint))) throw error;
        spec = retrySharedEndpoints(spec, options.topoId, attempt + 1);
      }
    }
    throw new HarnessError("DEADLINE_EXCEEDED", "shared proxy bind retries exhausted");
  }
  private async createAttempt(env: RunEnvironment, input: TopologySpec, options: { topoId: string; backend: Backend; signal?: AbortSignal; deadlineMs?: number }): Promise<Topology> {
    const spec = validateTopology(input);
    const id = dockerSafe(options.topoId);
    const deadlineAt = env.clock.now() + (options.deadlineMs ?? 120_000);
    const docker = new Docker(env.docker);
    const ledger = new ResourceLedger(join(env.resultsDir, env.runId, id, "ledger.jsonl"));
    const resources = new Map<string, ResourceRef>();
    const nodes = new Map<string, NodeHandle>();
    const clients = new Map<string, KvClient>();
    let proxies: Toxiproxy | undefined;
    const network = `tc893-${id}`;
    const resourceLabels = { "tc893.run": env.runId, "tc893.topo": id };
    const add = (ref: ResourceRef) => resources.set(`${ref.kind}:${ref.name}`, ref);
    const createResource = async (kind: ResourceRef["kind"], name: string, command: string[]) => {
      await ledger.intent(kind, name, resourceLabels);
      await docker.run(command, { signal: options.signal, deadlineMs: remainingMs(env.clock, deadlineAt) });
      const ref = { kind, name, labels: resourceLabels };
      await ledger.created(ref); add(ref);
    };
    try {
      await createResource("network", network, ["network", "create", ...labels(env.runId, id), network]);
      const pgNodes = spec.nodes.filter((node) => (node.backend ?? options.backend) !== "sqlite");
      if (pgNodes.length) await createPostgres({ docker, env, ledger, topoId: id, network, nodes: pgNodes, variantC: pgNodes.some((node) => (node.backend ?? options.backend) === "pg16-c"), deadlineAt, signal: options.signal });
      const networkAlias = new Map(spec.nodes.map((node) => [node.id, node.id === "pg" && pgNodes.length ? "tc893-node-pg" : node.id]));
      for (const node of spec.nodes) {
        const backend = node.backend ?? options.backend;
        const image = env.image(node.image ?? "default");
        const collidesWithPostgres = node.id === "pg" && pgNodes.length > 0;
        const running = await createNode({ docker, env, ledger, spec: node, backend, topoId: id, deadlineAt, image, network, networkAlias: networkAlias.get(node.id), containerName: collidesWithPostgres ? `tc893-${id}-node-pg` : undefined, pgDatabase: backend === "sqlite" ? undefined : `node_${node.id}`, signal: options.signal });
        nodes.set(node.id, running.handle);
        for (const ref of ledger.resources()) add(ref);
      }
      const edgeList: { name: string; node: string; host?: string; hostPort?: number }[] = [];
      const clientProxy = new Map<string, string>();
      const directEndpoints = new Map<string, string>();
      const sharedEndpoints = new Map<string, { name: string; node: string; host: string; port: number }>();
      for (const clientSpec of spec.clients) {
        if (clientSpec.endpoint === undefined) {
          const edgeName = `client:${clientSpec.id}->${clientSpec.node}`;
          edgeList.push({ name: edgeName, node: networkAlias.get(clientSpec.node)! });
          clientProxy.set(clientSpec.id, edgeName);
        } else {
          const endpoint = sharedProxyEndpointDetails(clientSpec.endpoint);
          if (!endpoint) directEndpoints.set(clientSpec.id, clientSpec.endpoint);
          else {
            const previous = sharedEndpoints.get(endpoint.endpoint);
            if (previous && previous.node !== clientSpec.node) throw new HarnessError("TOPOLOGY_INVALID", `shared endpoint ${endpoint.endpoint} targets multiple nodes`);
            const edgeName = previous?.name ?? `shared:${endpoint.host}:${endpoint.port}`;
            if (!previous) {
              sharedEndpoints.set(endpoint.endpoint, { name: edgeName, node: clientSpec.node, host: endpoint.host, port: endpoint.port });
              edgeList.push({ name: edgeName, node: networkAlias.get(clientSpec.node)!, host: endpoint.host, hostPort: endpoint.port });
            }
            clientProxy.set(clientSpec.id, edgeName);
          }
        }
        for (const host of clientSpec.extraHosts ?? []) edgeList.push({ name: `client:${clientSpec.id}->${host.alias}`, node: networkAlias.get(host.node)! });
      }
      for (const link of spec.links ?? []) edgeList.push({ name: `link:${link.from}->${link.to}`, node: networkAlias.get(link.to)! });
      if (edgeList.length) {
        proxies = await Toxiproxy.create({ docker, env, ledger, topoId: id, network, edges: edgeList, deadlineAt, signal: options.signal });
        for (const ref of ledger.resources()) add(ref);
      }
      const topology = new DockerTopology(spec, id, options.backend, docker, ledger, resources, nodes, clients, proxies, resourceLabels);
      for (const clientSpec of spec.clients) {
        if (!clientConstructor) throw new HarnessError("NOT_IMPLEMENTED", "client constructor is not registered (S2)");
        const primaryEdge = clientProxy.get(clientSpec.id);
        const primary = primaryEdge ? proxies?.handles.get(primaryEdge) : undefined;
        const endpoint = directEndpoints.get(clientSpec.id) ?? primary?.listenUrl;
        if (!endpoint) throw new HarnessError("TOPOLOGY_INVALID", `missing proxy for client ${clientSpec.id}`);
        const node = spec.nodes.find((candidate) => candidate.id === clientSpec.node)!;
        const client = await clientConstructor({ topology, environment: env, spec: { ...clientSpec, endpoint }, image: env.image(node.image ?? "default"), sut: env.sut, signal: options.signal, deadlineMs: remainingMs(env.clock, deadlineAt) });
        clients.set(clientSpec.id, client);
      }
      return topology;
    } catch (error) {
      const teardownDeadline = env.clock.now() + env.teardownMs;
      const closedClients: DisposeReport["clients"] = [];
      for (const [id, client] of clients) {
        try { const result = await client.close({ deadlineMs: remainingMs(env.clock, teardownDeadline) }); closedClients.push({ id, graceful: result.graceful }); }
        catch { closedClients.push({ id, graceful: false }); }
      }
      const report = await disposeResources(docker, [...ledger.resources()], closedClients, Math.max(1, teardownDeadline - env.clock.now()), false, resourceLabels);
      if (error instanceof HarnessError) throw new HarnessError(error.code, error.message, { original: error.detail, teardown: report });
      throw new HarnessError("DOCKER_FAILED", "topology creation failed", { cause: error, teardown: report });
    }
  }
}
class DockerTopology implements Topology {
  constructor(readonly spec: TopologySpec, readonly id: string, readonly backend: Backend, private readonly docker: Docker, private readonly ledger: ResourceLedger, private readonly resourceMap: Map<string, ResourceRef>, private readonly nodeMap: Map<string, NodeHandle>, private readonly clientMap: Map<string, KvClient>, private readonly proxyMap: Toxiproxy | undefined, private readonly ownerLabels: Record<string, string>) {}
  node(id: string): NodeHandle { const node = this.nodeMap.get(id); if (!node) throw new HarnessError("TOPOLOGY_INVALID", `unknown node ${id}`); return node; }
  client(id: string): KvClient { const client = this.clientMap.get(id); if (!client) throw new HarnessError("TOPOLOGY_INVALID", `unknown client ${id}`); return client; }
  cli(id: string): CliClient { const client = this.client(id); if (client.kind !== "cli") throw new HarnessError("TOPOLOGY_INVALID", `${id} is not a CLI client`); return client as CliClient; }
  sdk(id: string): SdkClient { const client = this.client(id); if (client.kind !== "sdk") throw new HarnessError("TOPOLOGY_INVALID", `${id} is not an SDK client`); return client as SdkClient; }
  proxy(name: string) { const proxy = this.proxyMap?.handles.get(name); if (!proxy) throw new HarnessError("TOPOLOGY_INVALID", `unknown proxy ${name}`); return proxy; }
  resources(): readonly ResourceRef[] { return [...this.resourceMap.values()]; }
  async collectArtefacts(dir: string, options: { deadlineMs: number }) { return collectTopologyArtefacts({ dir, resources: this.resources(), nodes: this.nodeMap, spec: this.spec, proxies: this.proxyMap, deadlineMs: options.deadlineMs }); }
  private disposal?: Promise<DisposeReport>;
  dispose(options: DisposeOptions): Promise<DisposeReport> {
    this.disposal ??= this.disposeOnce(options);
    return this.disposal;
  }
  private async disposeOnce(options: DisposeOptions): Promise<DisposeReport> {
    if (options.keep) return { removed: [], leaked: [...this.resources()], errors: [], clients: [] };
    const deadline = Date.now() + options.deadlineMs;
    const clients: DisposeReport["clients"] = [];
    for (const [id, client] of this.clientMap) {
      if (Date.now() >= deadline) { clients.push({ id, graceful: false }); continue; }
      try { const result = await client.close({ deadlineMs: Math.max(1, deadline - Date.now()) }); clients.push({ id, graceful: result.graceful }); }
      catch { clients.push({ id, graceful: false }); }
    }
    const report = await disposeResources(this.docker, [...this.ledger.resources()], clients, Math.max(1, deadline - Date.now()), true, this.ownerLabels);
    for (const ref of report.removed) this.resourceMap.delete(`${ref.kind}:${ref.name}`);
    return report;
  }
}
export async function disposeResources(docker: Docker, resources: ResourceRef[], clients: DisposeReport["clients"], deadlineMs: number, checkLeaks: boolean, ownerLabels?: Record<string, string>): Promise<DisposeReport> {
  const deadline = Date.now() + deadlineMs, removed: ResourceRef[] = [], errors: string[] = [];
  const owners = ownerLabels ?? resources[0]?.labels;
  const reconciled = new Map(resources.map((ref) => [`${ref.kind}:${ref.name}`, ref]));
  if (owners?.["tc893.run"] && owners["tc893.topo"]) {
    for (const kind of ["container", "volume", "network"] as const) {
      if (Date.now() >= deadline) { errors.push("teardown deadline exceeded"); break; }
      const command = kind === "container" ? ["ps", "-a"] : [kind, "ls"];
      try {
        const result = await docker.run([...command, "--filter", `label=tc893.run=${owners["tc893.run"]}`, "--filter", `label=tc893.topo=${owners["tc893.topo"]}`, "--format", kind === "container" ? "{{.Names}}" : "{{.Name}}"], { deadlineMs: Math.max(1, deadline - Date.now()) });
        for (const name of result.stdout.split("\n").filter(Boolean)) reconciled.set(`${kind}:${name}`, { kind, name, labels: owners });
      } catch (error) { errors.push(`reconcile ${kind}: ${String(error)}`); }
    }
  }
  resources = [...reconciled.values()];
  const available = (kind: ResourceRef["kind"]) => resources.filter((resource) => resource.kind === kind).reverse();
  for (const ref of available("container")) {
    if (Date.now() >= deadline) { errors.push("teardown deadline exceeded"); break; }
    try { const result = await docker.tryRun(["rm", "-f", "-v", ref.name], { deadlineMs: Math.max(1, deadline - Date.now()) }); if (!result.code) removed.push(ref); else errors.push(`${ref.kind} ${ref.name} was not removed`); } catch (error) { errors.push(String(error)); }
  }
  for (const ref of available("volume")) {
    if (Date.now() >= deadline) { errors.push("teardown deadline exceeded"); break; }
    try { const result = await docker.tryRun(["volume", "rm", ref.name], { deadlineMs: Math.max(1, deadline - Date.now()) }); if (!result.code) removed.push(ref); else errors.push(`${ref.kind} ${ref.name} was not removed`); } catch (error) { errors.push(String(error)); }
  }
  for (const ref of available("network")) {
    if (Date.now() >= deadline) { errors.push("teardown deadline exceeded"); break; }
    try { const result = await docker.tryRun(["network", "rm", ref.name], { deadlineMs: Math.max(1, deadline - Date.now()) }); if (!result.code) removed.push(ref); else errors.push(`${ref.kind} ${ref.name} was not removed`); } catch (error) { errors.push(String(error)); }
  }
  const leaked: ResourceRef[] = [];
  if (checkLeaks && owners?.["tc893.topo"] && Date.now() < deadline) {
    for (const kind of ["container", "volume", "network"] as const) {
      const command = kind === "container" ? ["ps", "-a"] : [kind, "ls"];
      try {
        const filters = ["--filter", `label=tc893.topo=${owners["tc893.topo"]}`];
        if (owners["tc893.run"]) filters.push("--filter", `label=tc893.run=${owners["tc893.run"]}`);
        const result = await docker.run([...command, ...filters, "--format", kind === "container" ? "{{.Names}}" : "{{.Name}}"], { deadlineMs: Math.max(1, deadline - Date.now()) });
        const names = new Set(result.stdout.split("\n").filter(Boolean));
        leaked.push(...resources.filter((resource) => resource.kind === kind && names.has(resource.name)));
      } catch (error) { errors.push(String(error)); }
    }
  }
  if (leaked.length || errors.length) errors.push("TEARDOWN_FAILED");
  return { removed, leaked, errors, clients };
}
function dockerSafe(value: string): string { const safe = value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-"); return safe.length <= 48 ? safe : `${safe.slice(0, 39)}-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`; }
function isRetryableBindConflict(error: unknown): boolean {
  if (!(error instanceof HarnessError) || error.code !== "DOCKER_FAILED") return false;
  const detail = error.detail as { teardown?: DisposeReport } | undefined;
  if (detail?.teardown?.errors.length) return false;
  return /port is already allocated|address already in use|cannot assign requested address|bind: permission denied/i.test(error.message);
}
function retrySharedEndpoints(spec: TopologySpec, topoId: string, attempt: number): TopologySpec {
  return {
    ...spec,
    clients: spec.clients.map((client) => {
      if (!client.endpoint) return client;
      const shared = sharedProxyEndpointDetails(client.endpoint);
      return shared ? { ...client, endpoint: sharedProxyEndpoint(topoId, shared.port, attempt) } : client;
    }),
  };
}
