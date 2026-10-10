import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(harnessRoot, "../..");
const runtimeModule = join(harnessRoot, "test/fixtures/gate-cli-runtime.ts");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function command(args: string[], env: Record<string, string>): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["bun", "run", "--cwd", "tests/replication-harness", "harness", ...args], {
    cwd: repoRoot, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
}

describe("executable gate CLI adapters", () => {
  test("runs resolve, manifests, core and companion legs, aggregate, verify, and run --gate on fixture topology", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc893-cli-"));
    roots.push(root);
    const eventFile = join(root, "event.json");
    const outputFile = join(root, "github-output");
    const inputDir = join(root, "in");
    const legsDir = join(root, "legs");
    const aggregateDir = join(root, "aggregate");
    const event = {
      repository: { full_name: "TinyCloudLabs/js-sdk" },
      pull_request: { number: 474, head: { sha: "a".repeat(40), ref: "feat/tc-893-harness-s3b" }, base: { sha: "b".repeat(40), ref: "master" } },
    };
    await writeFile(eventFile, JSON.stringify(event));
    const env = {
      TC893_RUNTIME_MODULE: runtimeModule,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/474/merge",
      GITHUB_SHA: "c".repeat(40),
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_OUTPUT: outputFile,
    };
    const dispatchInputs = JSON.stringify({ gate: "tc858-phase1-workspace", clients: "workspace", set: "phase1-companion", tier: "core", backends: '["sqlite","pg16"]' });

    const resolved = command(["resolve", "--event-file", eventFile, "--dispatch-inputs", dispatchInputs, "--out", inputDir], env);
    expect(resolved.exitCode).toBe(0);
    const matrix = JSON.parse(resolved.stdout?.toString() ?? "") as { include: { name: string; backend: string; set: string | null }[] };
    expect(matrix.include.map(({ name }) => name)).toEqual(["core-sqlite", "core-pg16", "companion-sqlite"]);
    expect(await readFile(join(outputFile), "utf8")).toContain(`matrix=${JSON.stringify(matrix)}`);
    for (const path of ["inputs.json", "manifest-core.json", "manifest-phase1-companion.json", "matrix.json", "sut-dist.tgz"]) {
      expect(await readFile(join(inputDir, path))).toBeTruthy();
    }

    const manifested = command(["manifest", "--inputs", join(inputDir, "inputs.json"), "--out", join(root, "manifest")], env);
    expect(manifested.exitCode).toBe(0);
    const standaloneManifest = JSON.parse(await readFile(join(root, "manifest", "manifest-core.json"), "utf8")) as { rows: unknown[] };
    expect(standaloneManifest.rows).toHaveLength(2);

    await mkdir(legsDir, { recursive: true });
    for (const leg of matrix.include) {
      const legResults = join(legsDir, leg.name);
      const result = command(["run", "--inputs", join(inputDir, "inputs.json"), "--leg", leg.name, "--results", legResults], env);
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(await readFile(join(legResults, "report.json"), "utf8"));
      expect(report.interrupted).toBe(false);
      expect(report.image.role).toBe("prod");
      expect(report.inputsSha256).toBe(JSON.parse(await readFile(join(inputDir, "inputs.json"), "utf8")).inputsSha256);
      expect(await readFile(join(legResults, "report.md"), "utf8")).toContain(event.pull_request.head.sha);
    }

    const aggregated = command(["aggregate", "--inputs", join(inputDir, "inputs.json"), "--legs", legsDir, "--leg-jobs-conclusion", "success", "--out", aggregateDir], env);
    expect(aggregated.exitCode).toBe(0);
    const aggregate = JSON.parse(await readFile(join(aggregateDir, "aggregate.json"), "utf8"));
    expect(aggregate.gate.passed).toBe(true);
    expect(aggregate.companion[0].passed).toBe(true);
    expect(aggregated.stdout?.toString() ?? "").toContain('"gatePassed":true');

    const verified = command(["verify-aggregate", join(aggregateDir, "aggregate.json"), "--gate", "tc858-phase1-workspace", "--run-id", "12345", "--print", "cli.version"], env);
    expect(verified.exitCode).toBe(0);
    expect(verified.stdout?.toString() ?? "").toBe("1.2.3\n");
    expect(verified.stderr?.toString() ?? "").toContain("gate=passed companion=passed");

    const localResults = join(root, "local-gate");
    const local = command(["run", "--gate", "tc858-phase1-workspace", "--results", localResults], env);
    expect(local.exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(localResults, "legs", "aggregate.json"), "utf8")).gate.passed).toBe(true);
    const interruptedDir = join(root, "interrupted-leg");
    const interrupted = command(["run", "--inputs", join(inputDir, "inputs.json"), "--leg", "core-sqlite", "--results", interruptedDir], {
      ...env, TC893_FIXTURE_INTERRUPT: "1",
    });
    expect(interrupted.exitCode).toBe(1);
    const interruptedReport = JSON.parse(await readFile(join(interruptedDir, "report.json"), "utf8"));
    expect(interruptedReport.interrupted).toBe(true);
    expect(interruptedReport.results[0].reason).toBe("INTERRUPTED");
  });
});
