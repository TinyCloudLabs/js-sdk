import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { HarnessError } from "../src/contracts/common";
import { validateTopology } from "../src/contracts/topology";
import { ResourceLedger } from "../src/topology/ledger";
import { Docker } from "../src/topology/docker";
import { disposeResources, DockerTopologyFactory } from "../src/topology/factory";
import { NodeImageResolver } from "../src/topology/images";
import { realClock } from "../src/contracts/clock";
import type { RunEnvironment } from "../src/contracts/lifecycle";
import { Toxiproxy } from "../src/topology/toxiproxy";

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
});

describe("real Docker topology", () => {
  test.skipIf(process.env.HARNESS_DOCKER !== "1")("uses SQLite and PG behind Toxiproxy and tears every labelled resource down", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc893-integration-"));
    const command = process.env.DOCKER ? process.env.DOCKER.split(/\s+/) : ["sudo", "-n", "docker"];
    const docker = new Docker(command);
    const runId = `test-${crypto.randomUUID().slice(0, 8)}`;
    let topology: Awaited<ReturnType<DockerTopologyFactory["create"]>> | undefined;
    try {
      const image = await new NodeImageResolver(docker).resolve("default");
      const env = { ...noopEnv(root, command), runId, image: () => image };
      topology = await new DockerTopologyFactory().create(env, {
        name: "integration",
        nodes: [{ id: "sq", backend: "sqlite" }, { id: "pg", backend: "pg16" }],
        clients: [],
        links: [{ from: "sq", to: "pg" }, { from: "pg", to: "sq" }],
      }, { topoId: `i-${crypto.randomUUID()}`, backend: "sqlite", deadlineMs: 120_000 });
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
});
