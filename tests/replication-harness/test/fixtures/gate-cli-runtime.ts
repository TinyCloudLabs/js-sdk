import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureGateRuntime } from "../../bin/gate-adapters";
import { registerScenarios, scenarioRegistry } from "../../src/runner/registry";
import type { Scenario } from "../../src/contracts/scenario";
import type { RunEnvironment, Topology, TopologyFactory } from "../../src/contracts/lifecycle";
import { realClock } from "../../src/contracts/clock";
const sdkEntry = fileURLToPath(new URL("./sdk-entry.ts", import.meta.url));
const emptyTopology: Scenario["topology"] = () => ({ name: "fixture", nodes: [{ id: "n1" }], clients: [] });
async function fixturePreflight(ctx: Parameters<Scenario["run"]>[0]): Promise<void> {
  if (process.env.TC893_FIXTURE_INTERRUPT !== "1") return;
  process.kill(process.pid, "SIGINT");
  await ctx.clock.sleep(1000, ctx.signal);
}
scenarioRegistry.splice(0, scenarioRegistry.length);
registerScenarios(
  { id: "CORE-00", title: "Fixture preflight", tier: "core", timeoutMs: 10_000, topology: emptyTopology, run: fixturePreflight },
  { id: "EDGE-12", title: "Fixture companion", tier: "edge", sets: ["phase1-companion"], backends: ["sqlite"], timeoutMs: 10_000, topology: emptyTopology, run: async () => {} },
);

const digest = `sha256:${"a".repeat(64)}`;
const topologyFactory: TopologyFactory = {
  async create(env: RunEnvironment, spec, options) {
    if (env.image("default").role !== "prod") throw new Error("gate fixture did not use the resolved production image");
    const topology = {
      id: options.topoId, spec, backend: options.backend,
      node() { throw new Error("fixture node methods are unused"); }, client() { throw new Error("fixture client methods are unused"); },
      cli() { throw new Error("fixture client methods are unused"); }, sdk() { throw new Error("fixture client methods are unused"); },
      proxy() { throw new Error("fixture proxy methods are unused"); }, resources: () => [],
      async collectArtefacts(dir: string) {
        const files = [];
        for (const path of ["result.json", "topology.json", "nodes/n1.log"]) {
          const bytes = Buffer.from("{}\\n");
          const output = join(dir, path);
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output, bytes);
          files.push({ path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
        }
        return { dir, files };
      },
      async dispose() { return { removed: [], leaked: [], errors: [], clients: [] }; },
    };
    return topology as unknown as Topology;
  },
};

export function registerGateRuntime(configure: typeof configureGateRuntime): void {
  configure({
    sutResolver: async ({ mode, root }) => ({
      source: mode, ...(root ? { root } : {}), gitSha: "fixture-sut-sha", dirty: false, distSha256: "b".repeat(64),
      cli: { version: "1.2.3", packageJson: "/fixture/cli/package.json", entry: "/fixture/cli/index.js" },
      nodeSdk: { version: "3.2.1", packageJson: "/fixture/node-sdk/package.json", entry: sdkEntry, condition: "import" },
    }),
    imageResolver: async (requested) => {
      const ref = typeof requested === "string" ? requested : "ref" in requested ? requested.ref : requested.build.ref ?? requested.build.path;
      return { role: "default", ref, digest, pinned: `fixture-node@${digest}`, nodeVersion: "1.20.0", features: ["replication-v1"] };
    },
    exportSutArtifacts: async (outDir) => {
      await writeFile(join(outDir, "sut-dist.tgz"), "fixture build artefact");
    },
    topologyFactory,
    createRunEnvironment: (inputs, resultsDir) => ({
      runId: inputs.subject.runId ?? "fixture-run", resultsDir, clock: realClock, docker: ["fixture"], sut: inputs.sut,
      image: () => inputs.image, slackMs: 0, teardownMs: 100,
    }),
    fetchInfo: async () => ({ version: "1.20.0", features: ["replication-v1"] }),
    junitPrecondition: async (subject) => {
      if (subject.event === "pull_request") return {
        schema: "tc893.junit-precondition/v1", minimumsVersion: 1, testedSha: subject.headSha!,
        association: { prNumber: subject.prNumber!, headSha: subject.headSha!, baseSha: subject.baseSha! },
        suites: [
          { name: "cli-acceptance-sqlite", present: true, exitCode: 0, skipped: 0, tests: 1 },
          { name: "cli-acceptance-pg16", present: true, exitCode: 0, skipped: 0, tests: 1 },
          { name: "node-sdk-real-node-sqlite", present: true, exitCode: 0, skipped: 0, tests: 10 },
          { name: "node-sdk-real-node-pg16", present: true, exitCode: 0, skipped: 0, tests: 10 },
        ],
      };
      if (subject.event === "workflow_dispatch") return {
        schema: "tc893.junit-precondition/v1", minimumsVersion: 1, testedSha: subject.sha,
        association: { event: "workflow_dispatch", ref: subject.ref, sha: subject.sha },
        suites: [
          { name: "cli-acceptance-sqlite", present: true, exitCode: 0, skipped: 0, tests: 1 },
          { name: "cli-acceptance-pg16", present: true, exitCode: 0, skipped: 0, tests: 1 },
          { name: "node-sdk-real-node-sqlite", present: true, exitCode: 0, skipped: 0, tests: 10 },
          { name: "node-sdk-real-node-pg16", present: true, exitCode: 0, skipped: 0, tests: 10 },
        ],
      };
      return null;
    },
  });
}
