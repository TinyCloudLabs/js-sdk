import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtefactIndex, NodeHandle, ResourceRef } from "../contracts/lifecycle";
import type { TopologySpec } from "../contracts/topology";
import type { Toxiproxy } from "./toxiproxy";

export async function collectTopologyArtefacts(input: { dir: string; resources: readonly ResourceRef[]; nodes: Map<string, NodeHandle>; spec: TopologySpec; proxies?: Toxiproxy; deadlineMs: number }): Promise<ArtefactIndex> {
  const deadline = Date.now() + input.deadlineMs;
  await mkdir(join(input.dir, "nodes"), { recursive: true });
  const safeSpec = {
    name: input.spec.name,
    nodes: input.spec.nodes.map(({ env: _env, ...node }) => node),
    clients: input.spec.clients.map(({ deviceProof: _proof, ...client }) => client),
    links: input.spec.links ?? [],
  };
  await writeFile(join(input.dir, "topology.json"), `${JSON.stringify({ spec: safeSpec, resources: input.resources }, null, 2)}\n`, { mode: 0o600 });
  for (const [id, node] of input.nodes) {
    if (Date.now() >= deadline) break;
    await writeFile(join(input.dir, "nodes", `${id}.log`), await node.logs({ tailBytes: 2_000_000 }), { mode: 0o600 });
  }
  if (input.proxies) {
    const proxyState: Record<string, unknown> = {};
    for (const [name, proxy] of input.proxies.handles) {
      if (Date.now() >= deadline) break;
      proxyState[name] = { listenUrl: proxy.listenUrl, ...await proxy.state() };
    }
    await writeFile(join(input.dir, "toxiproxy.json"), `${JSON.stringify(proxyState, null, 2)}\n`, { mode: 0o600 });
  }
  const files: ArtefactIndex["files"] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else {
        const data = await readFile(full);
        files.push({ path: full.slice(input.dir.length + 1), bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
      }
    }
  }
  await visit(input.dir);
  return { dir: input.dir, files };
}
