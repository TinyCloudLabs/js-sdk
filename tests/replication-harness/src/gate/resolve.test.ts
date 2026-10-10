import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JunitPrecondition, Subject } from "../contracts/gate";
import type { ResolvedImage, ResolvedSut } from "../contracts/lifecycle";
import { validateJunitPrecondition, resolveInputs } from "./resolve";
import type { Scenario } from "../contracts/scenario";

const subject: Subject = { repo: "TinyCloudLabs/js-sdk", event: "pull_request", ref: "refs/pull/12/merge", sha: "merge", headSha: "head-12", baseSha: "base-2", prNumber: 12 };
function evidence(): JunitPrecondition {
  return {
    schema: "tc893.junit-precondition/v1", minimumsVersion: 1, testedSha: "head-12",
    association: { prNumber: 12, headSha: "head-12", baseSha: "base-2" },
    suites: [
      { name: "cli-acceptance-sqlite", present: true, exitCode: 0, skipped: 0, tests: 1 },
      { name: "cli-acceptance-pg16", present: true, exitCode: 0, skipped: 0, tests: 1 },
      { name: "node-sdk-real-node-sqlite", present: true, exitCode: 0, skipped: 0, tests: 10 },
      { name: "node-sdk-real-node-pg16", present: true, exitCode: 0, skipped: 0, tests: 10 },
    ],
  };
}

describe("G1 junit precondition", () => {
  test("requires named SQLite and PG suites with versioned counts and zero skips", () => {
    expect(() => validateJunitPrecondition(evidence(), subject)).not.toThrow();
    const missingPg = evidence();
    missingPg.suites = missingPg.suites.filter((suite) => suite.name !== "node-sdk-real-node-pg16");
    expect(() => validateJunitPrecondition(missingPg, subject)).toThrow(/node-sdk-real-node-pg16/);
    const skippedRealNode = evidence();
    skippedRealNode.suites[2]!.skipped = 1;
    expect(() => validateJunitPrecondition(skippedRealNode, subject)).toThrow(/zero skips/);
  });

  test("rejects another PR's evidence even when its tested SHA is internally consistent", () => {
    const otherPr = evidence();
    otherPr.association = { prNumber: 99, headSha: "other-head", baseSha: "other-base" };
    otherPr.testedSha = "other-head";
    expect(() => validateJunitPrecondition(otherPr, subject)).toThrow(/different PR/);
  });

  test("resolves exact production image and rejects published SDK without sqliteReplicaStorage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc893-preflight-"));
    try {
      const sdkEntry = join(directory, "node-sdk.mjs");
      await writeFile(sdkEntry, "export const other = true;\\n");
      const sut: ResolvedSut = {
        source: "published", lockfileSha256: "a".repeat(64),
        cli: { version: "1.1.0-beta.24", packageJson: "/cli/package.json", entry: "/cli/index.js", integrity: "sha512-cli" },
        nodeSdk: { version: "3.1.0-beta.15", packageJson: "/sdk/package.json", entry: sdkEntry, condition: "import", integrity: "sha512-sdk" },
      };
      const image: ResolvedImage = { role: "custom", ref: "node", digest: `sha256:${"b".repeat(64)}`, pinned: `node@sha256:${"b".repeat(64)}`, nodeVersion: "1.20.0", features: ["kv-sync-v1"] };
      let sutResolutions = 0;
      let imageResolutions = 0;
      let productionReads = 0;
      await expect(resolveInputs({
        event: { repository: { full_name: "TinyCloudLabs/js-sdk" } }, eventName: "workflow_dispatch", ref: "refs/heads/main", sha: "dispatch-sha",
        gate: "tc858-phase1-beta", sets: ["phase1-companion"], mode: "published", cliVersion: "1.1.0-beta.24", nodeSdkVersion: "3.1.0-beta.15",
        harnessSha: "harness-sha", outDir: join(directory, "out"),
        sutResolver: async () => { sutResolutions++; return sut; },
        imageResolver: async (ref) => { imageResolutions++; expect(ref).toEqual({ ref: "ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack" }); return image; },
        registry: (resolvedSut, resolvedImage) => ({ scenarios: [], context: { tiers: ["core"], backends: ["sqlite", "pg16"], sut: resolvedSut, image: resolvedImage, ciPinImage: "ci-pin" } }),
        exportSutArtifacts: async () => {},
        fetchInfo: async () => { productionReads++; return { version: "1.20.0", features: ["kv-sync-v1"] }; },
      })).rejects.toThrow(/PREFLIGHT_FAILED/);
      expect(sutResolutions).toBe(1);
      expect(imageResolutions).toBe(1);
      expect(productionReads).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("resolves published inputs once and writes lockfile, digest, manifest, and matrix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc893-resolve-"));
    try {
      const sdkEntry = join(directory, "node-sdk.mjs");
      await writeFile(sdkEntry, "export function sqliteReplicaStorage() {}\n");
      const sut: ResolvedSut = {
        source: "published", lockfileSha256: "a".repeat(64),
        cli: { version: "1.2.3-beta.4", packageJson: "/cli/package.json", entry: "/cli/index.js", integrity: "sha512-cli" },
        nodeSdk: { version: "3.4.5-beta.6", packageJson: "/sdk/package.json", entry: sdkEntry, condition: "import", integrity: "sha512-sdk" },
      };
      const image: ResolvedImage = { role: "custom", ref: "prod-tag", digest: `sha256:${"b".repeat(64)}`, pinned: `node@sha256:${"b".repeat(64)}`, nodeVersion: "1.20.0", features: ["kv-sync-v1"] };
      const coreScenario = {
        id: "CORE-00", title: "Core preflight", tier: "core", timeoutMs: 1000,
        topology: () => ({ nodes: [], clients: [] }), run: async () => {},
      } as unknown as Scenario;
      let sutResolutions = 0;
      let imageResolutions = 0;
      let productionReads = 0;
      const result = await resolveInputs({
        event: { repository: { full_name: "TinyCloudLabs/js-sdk" } }, eventName: "workflow_dispatch", ref: "refs/heads/main", sha: "dispatch-sha",
        gate: "tc858-phase1-beta", sets: ["phase1-companion"], mode: "published", cliVersion: "1.2.3-beta.4", nodeSdkVersion: "3.4.5-beta.6",
        harnessSha: "harness-sha", outDir: join(directory, "out"),
        sutResolver: async () => { sutResolutions++; return sut; },
        imageResolver: async (ref) => { imageResolutions++; expect(ref).toEqual({ ref: "ghcr.io/tinycloudlabs/tinycloud-node:1.20.0-dstack" }); return image; },
        registry: (resolvedSut, resolvedImage) => ({ scenarios: [coreScenario], context: { tiers: ["core"], backends: ["sqlite", "pg16"], sut: resolvedSut, image: resolvedImage, ciPinImage: "ci-pin" } }),
        exportSutArtifacts: async (outDir) => { await writeFile(join(outDir, "package-lock.json"), "{}"); },
        fetchInfo: async () => { productionReads++; return { version: "1.20.0", features: ["kv-sync-v1"] }; },
      });
      expect(sutResolutions).toBe(1);
      expect(imageResolutions).toBe(1);
      expect(productionReads).toBe(1);
      expect(result.inputs.preflight).toMatchObject({ passed: true });
      expect(result.inputs.image).toMatchObject({ role: "prod", digest: image.digest });
      expect(result.matrix.include.map((entry) => entry.name)).toEqual(["core-sqlite", "core-pg16"]);
      expect(await readFile(join(directory, "out/package-lock.json"), "utf8")).toBe("{}");
      expect(JSON.parse(await readFile(join(directory, "out/manifest-core.json"), "utf8")).manifestSha256).toBe(result.manifests.core?.manifestSha256);
      expect(JSON.parse(await readFile(join(directory, "out/matrix.json"), "utf8"))).toEqual(result.matrix);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("non-gate resolve emits selected tier/backend legs and keeps speed separate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc893-adhoc-resolve-"));
    try {
      const sut: ResolvedSut = {
        source: "workspace", gitSha: "workspace-sha", distSha256: "c".repeat(64),
        cli: { version: "1.2.3", packageJson: "/cli/package.json", entry: "/cli/index.js" },
        nodeSdk: { version: "3.2.1", packageJson: "/sdk/package.json", entry: "/sdk/index.js", condition: "import" },
      };
      const image: ResolvedImage = { role: "custom", ref: "prod-tag", digest: `sha256:${"d".repeat(64)}`, pinned: `node@sha256:${"d".repeat(64)}`, nodeVersion: "1.20.0", features: ["kv-sync-v1"] };
      let capturedSelection: { tiers: string[]; backends: string[] } | undefined;
      const result = await resolveInputs({
        event: { repository: { full_name: "TinyCloudLabs/js-sdk" } }, eventName: "workflow_dispatch", ref: "refs/heads/main", sha: "dispatch-sha",
        gate: null, sets: [], tiers: ["core", "edge", "speed", "tc12"], backends: ["pg16-c", "sqlite"], mode: "workspace",
        harnessSha: "harness-sha", outDir: join(directory, "out"),
        sutResolver: async () => sut,
        imageResolver: async () => image,
        registry: (resolvedSut, resolvedImage, selection) => {
          capturedSelection = selection;
          return { scenarios: [], context: { tiers: selection.tiers, backends: selection.backends, sut: resolvedSut, image: resolvedImage, ciPinImage: "ci-pin" } };
        },
        exportSutArtifacts: async () => {},
        fetchInfo: async () => ({ version: "1.20.0", features: ["kv-sync-v1"] }),
      });
      expect(result.inputs.tiers).toEqual(["core", "edge", "speed", "tc12"]);
      expect(result.inputs.backends).toEqual(["pg16-c", "sqlite"]);
      expect(capturedSelection).toEqual({ tiers: result.inputs.tiers, backends: result.inputs.backends });
      expect(result.matrix.include).toEqual([
        { name: "adhoc-pg16-c", backend: "pg16-c", set: null, tiers: ["core", "edge", "tc12"] },
        { name: "speed-pg16-c", backend: "pg16-c", set: null, tiers: ["speed"] },
        { name: "adhoc-sqlite", backend: "sqlite", set: null, tiers: ["core", "edge", "tc12"] },
        { name: "speed-sqlite", backend: "sqlite", set: null, tiers: ["speed"] },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
