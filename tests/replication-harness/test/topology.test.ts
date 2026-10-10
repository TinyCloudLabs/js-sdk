import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { HarnessError } from "../src/contracts/common";
import { validateTopology } from "../src/contracts/topology";
import { prepareSharedEndpointStorageDeviceSpec } from "../src/contracts/frozen";
import { ResourceLedger } from "../src/topology/ledger";
import { Docker } from "../src/topology/docker";
import { disposeResources, DockerTopologyFactory, registerClientConstructor } from "../src/topology/factory";
import { NodeImageResolver } from "../src/topology/images";
import { realClock } from "../src/contracts/clock";
import type { RunEnvironment, ResolvedImage } from "../src/contracts/lifecycle";
import type { KvClient } from "../src/contracts/client";
import { DockerNodeHandle } from "../src/topology/nodes";
import { sharedProxyEndpoint } from "../src/topology/shared-endpoint";
import { collectTopologyArtefacts } from "../src/topology/artefacts";

const noopEnv = (root: string, docker: readonly string[] = ["sudo", "-n", "docker"]): RunEnvironment => ({
  runId: "unit", resultsDir: root, clock: realClock, docker,
  sut: { source: "workspace", cli: { version: "0.0.0", packageJson: "", entry: "" }, nodeSdk: { version: "0.0.0", packageJson: "", entry: "", condition: "import" } },
  image: () => { throw new Error("unexpected image lookup"); }, slackMs: 3000, teardownMs: 60_000,
});

describe("topology ledger and validation", () => {
  test("persists intent before created resources and replays only created refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc893-ledger-"));
    try {
      const ledger = new ResourceLedger(join(dir, "ledger.jsonl"));
      const labels = { "tc893.run": "r", "tc893.topo": "t" };
      await ledger.intent("network", "n", labels);
      await ledger.created({ kind: "network", name: "n", labels });
      await ledger.intent("volume", "partial", labels);
      const records = await ResourceLedger.read(join(dir, "ledger.jsonl"));
      expect(records.map((record) => record.op)).toEqual(["intent", "created", "intent"]);
      expect(ledger.resources()).toEqual([{ kind: "network", name: "n", labels }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("reports every topology validation violation together", () => {
    try {
      validateTopology({ name: "bad", nodes: [{ id: "Bad" }], clients: [{ id: "x", kind: "cli", node: "missing", identity: "i", auth: { posture: "owner", sessionExpiryMs: 60_000 } }] });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe("TOPOLOGY_INVALID");
      expect((error as HarnessError).detail).toEqual({ errors: expect.arrayContaining([expect.stringContaining("invalid node id"), expect.stringContaining("unknown node"), expect.stringContaining("session expiry")]) });
    }
  });
  test("disposes containers before volumes before the network", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc893-docker-"));
    try {
      const log = join(dir, "calls");
      const script = join(dir, "docker-fake");
      await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
      await chmod(script, 0o700);
      const resources = [
        { kind: "network" as const, name: "n", labels: { "tc893.topo": "t" } },
        { kind: "volume" as const, name: "v", labels: { "tc893.topo": "t" } },
        { kind: "container" as const, name: "c", labels: { "tc893.topo": "t" } },
      ];
      const result = await disposeResources(new Docker(["/bin/sh", script]), resources, [], 5000, false);
      expect(result.errors).toEqual([]);
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["rm -f -v c", "volume rm v", "network rm n"]);
    } finally { delete process.env.TC893_DOCKER_LOG; await rm(dir, { recursive: true, force: true }); }
  });
  test("reconciles a labelled network created before Docker create stalls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc893-create-stall-"));
    try {
      const statePath = join(dir, "network");
      const script = join(dir, "docker-fake");
      await writeFile(script, `#!/usr/bin/env bun
const [action, ...args] = Bun.argv.slice(2);
const state = ${JSON.stringify(statePath)};
if (action === "network" && args[0] === "create") { await Bun.write(state, args.at(-1)); const { promise } = Promise.withResolvers(); await promise; }
if (action === "network" && args[0] === "ls") { const name = await Bun.file(state).text().catch(() => ""); if (name) console.log(name); }
if (action === "network" && args[0] === "rm") await Bun.write(state, "");
`);
      await chmod(script, 0o700);
      const env = { ...noopEnv(dir, [script]), teardownMs: 5000 };
      let failure: unknown;
      try { await new DockerTopologyFactory().create(env, { name: "stall", nodes: [], clients: [] }, { topoId: "stalled", backend: "sqlite", deadlineMs: 250 }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(HarnessError);
      expect((failure as HarnessError).code).toBe("DEADLINE_EXCEEDED");
      expect(await readFile(statePath, "utf8")).toBe("");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("reconciles an image probe created before Docker run stalls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc893-image-stall-"));
    try {
      const statePath = join(dir, "container");
      const script = join(dir, "docker-fake");
      const repoDigest = `ghcr.io/tinycloudlabs/tinycloud-node@sha256:${"a".repeat(64)}`;
      await writeFile(script, `#!/usr/bin/env bun
const [action, ...args] = Bun.argv.slice(2);
const state = ${JSON.stringify(statePath)};
if (action === "image" && args[0] === "inspect") console.log(JSON.stringify([${JSON.stringify(repoDigest)}]));
if (action === "run") { await Bun.write(state, args[args.indexOf("--name") + 1]); const { promise } = Promise.withResolvers(); await promise; }
if (action === "ps") { const name = await Bun.file(state).text().catch(() => ""); if (name) console.log(name); }
if (action === "rm") await Bun.write(state, "");
`);
      await chmod(script, 0o700);
      let failure: unknown;
      try { await new NodeImageResolver(new Docker([script]), undefined, dir, 250).resolve("default"); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(HarnessError);
      expect((failure as HarnessError).code).toBe("IMAGE_RESOLVE_FAILED");
      expect(await readFile(statePath, "utf8")).toBe("");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("bounds artefact log collection when Docker logs stalls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tc893-log-stall-"));
    try {
      const script = join(dir, "docker-fake");
      await writeFile(script, `#!/usr/bin/env bun
const { promise } = Promise.withResolvers();
await promise;
`);
      await chmod(script, 0o700);
      const docker = new Docker([script]);
      const image: ResolvedImage = { role: "default", ref: "image", digest: "sha256:abc", pinned: "image@sha256:abc", nodeVersion: "1.20.0", features: [] };
      const node = new DockerNodeHandle(docker, "n", "sqlite", image, "stalled", "volume", "http://127.0.0.1:1", noopEnv(dir, [script]), []);
      let failure: unknown;
      const started = Date.now();
      try { await collectTopologyArtefacts({ dir: join(dir, "artifacts"), resources: [], nodes: new Map([["n", node]]), spec: { name: "logs", nodes: [{ id: "n" }], clients: [] }, deadlineMs: 150 }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(HarnessError);
      expect((failure as HarnessError).code).toBe("DEADLINE_EXCEEDED");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); reject(new Error("no loopback port assigned")); return; }
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
  return promise;
}

describe("real Docker topology", () => {
  test.skipIf(process.env.HARNESS_DOCKER !== "1")("uses SQLite, PG16 and a shared Toxiproxy endpoint, then tears every labelled resource down", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc893-integration-"));
    const command = process.env.DOCKER ? process.env.DOCKER.split(/\s+/) : ["sudo", "-n", "docker"];
    const docker = new Docker(command);
    const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
    const topoId = `i-${crypto.randomUUID()}`;
    const canonicalEndpoint = sharedProxyEndpoint(topoId, await unusedLoopbackPort());
    const clientEndpoints = new Map<string, string>();
    let topology: Awaited<ReturnType<DockerTopologyFactory["create"]>> | undefined;
    registerClientConstructor(async ({ spec }) => {
      clientEndpoints.set(spec.id, spec.endpoint!);
      return { id: spec.id, kind: spec.kind, capabilities: new Set(), close: async () => ({ graceful: true }) } as unknown as KvClient;
    });
    try {
      const image = await new NodeImageResolver(docker, undefined, root).resolve("default");
      const env = { ...noopEnv(root, command), runId, image: () => image };
      const spec = prepareSharedEndpointStorageDeviceSpec({
        spec: {
          name: "integration",
          nodes: [{ id: "sq", backend: "sqlite" }, { id: "pg", backend: "pg16" }],
          clients: [
            ...["c1", "c2"].map((id) => ({ id, kind: "sdk" as const, node: "sq", identity: "shared-identity", auth: { posture: "owner" as const }, replication: { prefixes: ["shared/"] } })),
            { id: "c3", kind: "sdk", node: "sq", identity: "override", endpoint: "https://node.example", auth: { posture: "owner" }, replication: { prefixes: ["override/"] } },
          ],
          links: [{ from: "sq", to: "pg" }, { from: "pg", to: "sq" }],
        },
        clientIds: ["c1", "c2"],
        canonicalEndpoint,
        replicaRoot: join(root, "shared-replica"),
        deviceProofs: [{ id: "device-1", proof: { device: 1 } }, { id: "device-2", proof: { device: 2 } }],
      });
      topology = await new DockerTopologyFactory().create(env, spec, { topoId, backend: "sqlite", deadlineMs: 120_000 });
      const endpointUrl = new URL(canonicalEndpoint);
      const sharedProxy = topology.proxy(`shared:${endpointUrl.hostname}:${endpointUrl.port}`);
      expect(clientEndpoints.get("c1")).toBe(canonicalEndpoint);
      expect(clientEndpoints.get("c2")).toBe(canonicalEndpoint);
      expect(clientEndpoints.get("c3")).toBe("https://node.example");
      expect(sharedProxy.listenUrl).toBe(canonicalEndpoint);
      await sharedProxy.disable();
      const clientResults = await Promise.all(["c1", "c2"].map(async (id) => {
        try { return (await fetch(`${clientEndpoints.get(id)}/healthz`, { signal: AbortSignal.timeout(3000) })).ok; }
        catch { return false; }
      }));
      expect(clientResults).toEqual([false, false]);
      await sharedProxy.enable();
      expect((await fetch(`${canonicalEndpoint}/healthz`)).status).toBe(200);
      const throughProxy = topology.proxy("link:sq->pg").listenUrl;
      expect((await fetch(`${throughProxy}/healthz`)).status).toBe(200);
      const proxy = topology.proxy("link:sq->pg");
      await proxy.disable();
      let failed = false;
      try { const response = await fetch(`${throughProxy}/healthz`, { signal: AbortSignal.timeout(3000) }); failed = !response.ok; }
      catch { failed = true; }
      expect(failed).toBe(true);
      await proxy.enable();
      expect((await fetch(`${throughProxy}/healthz`)).status).toBe(200);
      await topology.node("pg").restart();
      expect((await fetch(`${throughProxy}/healthz`)).status).toBe(200);
    } finally {
      registerClientConstructor(undefined);
      try {
        if (topology) {
          const report = await topology.dispose({ deadlineMs: 60_000 });
          expect(report.errors).toEqual([]);
        }
        const leftoverResources: string[] = [];
        for (const [args, format] of [
          [["ps", "-a"], "{{.Names}}"],
          [["volume", "ls"], "{{.Name}}"],
          [["network", "ls"], "{{.Name}}"],
        ] as const) {
          const listing = await docker.run([...args, "--filter", `label=tc893.run=${runId}`, "--format", format]);
          leftoverResources.push(...listing.stdout.split("\n").filter(Boolean));
        }
        expect(leftoverResources).toEqual([]);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }, 240_000);
  test.skipIf(process.env.HARNESS_DOCKER !== "1")("creates concurrent topologies on distinct topology-derived loopback endpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc893-concurrent-"));
    const command = process.env.DOCKER ? process.env.DOCKER.split(/\s+/) : ["sudo", "-n", "docker"];
    const docker = new Docker(command);
    const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
    const topologyIds = [`a-${crypto.randomUUID()}`, `b-${crypto.randomUUID()}`] as const;
    const sharedPort = await unusedLoopbackPort();
    const endpoints = topologyIds.map((id) => sharedProxyEndpoint(id, sharedPort));
    const clientIds = [["a1", "a2"], ["b1", "b2"]] as const;
    const clientEndpoints = new Map<string, string>();
    const topologies: (Awaited<ReturnType<DockerTopologyFactory["create"]>> | undefined)[] = [undefined, undefined];
    registerClientConstructor(async ({ spec }) => {
      clientEndpoints.set(spec.id, spec.endpoint!);
      return { id: spec.id, kind: spec.kind, capabilities: new Set(), close: async () => ({ graceful: true }) } as unknown as KvClient;
    });
    try {
      const image = await new NodeImageResolver(docker, undefined, root).resolve("default");
      const env = { ...noopEnv(root, command), runId, image: () => image };
      const makeSpec = (name: string, ids: readonly [string, string], endpoint: string) => prepareSharedEndpointStorageDeviceSpec({
        spec: {
          name,
          nodes: [{ id: "n", backend: "sqlite" as const }],
          clients: ids.map((id) => ({ id, kind: "sdk" as const, node: "n", identity: "shared", auth: { posture: "owner" as const }, replication: { prefixes: ["shared/"] } })),
        },
        clientIds: ids,
        canonicalEndpoint: endpoint,
        replicaRoot: join(root, `${name}-replica`),
        deviceProofs: [{ id: `${name}-device-1`, proof: { device: 1 } }, { id: `${name}-device-2`, proof: { device: 2 } }],
      });
      const factory = new DockerTopologyFactory();
      const specs = topologyIds.map((id, index) => makeSpec(id, clientIds[index], endpoints[index]));
      const outcomes = await Promise.allSettled(specs.map(async (spec, index) => {
        const topology = await factory.create(env, spec, { topoId: topologyIds[index], backend: "sqlite", deadlineMs: 120_000 });
        topologies[index] = topology;
        return topology;
      }));
      const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failures.length) throw failures[0].reason;
      expect(endpoints[0]).not.toBe(endpoints[1]);
      for (let index = 0; index < topologies.length; index++) {
        const topology = topologies[index]!;
        const url = new URL(endpoints[index]);
        const proxy = topology.proxy(`shared:${url.hostname}:${url.port}`);
        expect(proxy.listenUrl).toBe(endpoints[index]);
        expect((await fetch(`${endpoints[index]}/healthz`)).status).toBe(200);
        expect(clientEndpoints.get(clientIds[index][0])).toBe(endpoints[index]);
        expect(clientEndpoints.get(clientIds[index][1])).toBe(endpoints[index]);
      }
      const firstUrl = new URL(endpoints[0]);
      const firstProxy = topologies[0]!.proxy(`shared:${firstUrl.hostname}:${firstUrl.port}`);
      await firstProxy.disable();
      const firstResults = await Promise.all(clientIds[0].map(async (id) => {
        try { return (await fetch(`${clientEndpoints.get(id)}/healthz`, { signal: AbortSignal.timeout(3000) })).ok; }
        catch { return false; }
      }));
      expect(firstResults).toEqual([false, false]);
      expect((await fetch(`${endpoints[1]}/healthz`)).status).toBe(200);
      await firstProxy.enable();
    } finally {
      registerClientConstructor(undefined);
      try {
        for (const topology of topologies) {
          if (!topology) continue;
          const report = await topology.dispose({ deadlineMs: 60_000 });
          expect(report.errors).toEqual([]);
        }
        const leftovers: string[] = [];
        for (const [args, format] of [
          [["ps", "-a"], "{{.Names}}"],
          [["volume", "ls"], "{{.Name}}"],
          [["network", "ls"], "{{.Name}}"],
        ] as const) {
          const result = await docker.run([...args, "--filter", `label=tc893.run=${runId}`, "--format", format]);
          leftovers.push(...result.stdout.split("\n").filter(Boolean));
        }
        expect(leftovers).toEqual([]);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }, 240_000);
});
