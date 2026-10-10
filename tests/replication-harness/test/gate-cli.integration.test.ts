import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
async function writeJunitFixtures(root: string): Promise<void> {
  const suites = [
    ["tc858-junit-sqlite", "cli-flag.xml", "cli-acceptance-sqlite", 1],
    ["tc858-junit-pg16", "cli-flag.xml", "cli-acceptance-pg16", 1],
    ["tc858-junit-sqlite", "cli-replica-e2e.xml", "cli-replica-sqlite", 1],
    ["tc858-junit-pg16", "cli-replica-e2e.xml", "cli-replica-pg16", 1],
    ["tc858-junit-sqlite", "node-sdk.xml", "node-sdk-real-node-sqlite", 10],
    ["tc858-junit-pg16", "node-sdk.xml", "node-sdk-real-node-pg16", 10],
  ] as const;
  for (const [artifact, fileName, name, count] of suites) {
    const file = join(root, artifact, fileName);
    const cases = Array.from({ length: count }, (_, index) => `<testcase name="case-${index}"/>`).join("");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `<testsuite name="${name}" tests="${count}" failures="0" errors="0" skipped="0">${cases}</testsuite>`);
  }
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
    const junitDir = join(root, "junit");
    const event = {
      repository: { full_name: "TinyCloudLabs/js-sdk" },
      pull_request: { number: 474, head: { sha: "a".repeat(40), ref: "feat/tc-893-harness-s3b" }, base: { sha: "b".repeat(40), ref: "master" } },
    };
    await writeFile(eventFile, JSON.stringify(event));
    await writeJunitFixtures(junitDir);
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

    const resolved = command(["resolve", "--event-file", eventFile, "--dispatch-inputs", dispatchInputs, "--junit-dir", junitDir, "--out", inputDir], env);
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
      for (const row of report.results) {
        const resultArtifact = row.artefacts.find((file: { path: string }) => file.path === "result.json");
        expect(resultArtifact).toBeDefined();
        const resultBytes = await readFile(join(legResults, row.artefactDir, "result.json"));
        expect(resultArtifact.sha256).toBe(createHash("sha256").update(resultBytes).digest("hex"));
      }
    }

    const aggregated = command(["aggregate", "--inputs", join(inputDir, "inputs.json"), "--legs", legsDir, "--leg-core-conclusion", "success", "--leg-companion-conclusion", "success", "--out", aggregateDir], env);
    expect(aggregated.exitCode).toBe(0);
    const aggregate = JSON.parse(await readFile(join(aggregateDir, "aggregate.json"), "utf8"));
    expect(aggregate.gate.passed).toBe(true);
    expect(aggregate.companion[0].passed).toBe(true);
    expect(aggregated.stdout?.toString() ?? "").toContain('"gatePassed":true');
    const obsolete = command(["aggregate", "--inputs", join(inputDir, "inputs.json"), "--legs", legsDir, "--leg-jobs-conclusion", "failure", "--out", join(root, "obsolete-aggregate")], env);
    expect(obsolete.exitCode).toBe(2);
    expect(obsolete.stderr?.toString()).toContain("usage: harness aggregate");

    const corruptLegsDir = join(root, "corrupt-legs");
    await cp(legsDir, corruptLegsDir, { recursive: true });
    await writeFile(join(corruptLegsDir, "core-sqlite", "report.json"), "not json");
    const corruptDir = join(root, "corrupt-aggregate");
    const corrupt = command(["aggregate", "--inputs", join(inputDir, "inputs.json"), "--legs", corruptLegsDir,
      "--leg-core-conclusion", "success", "--leg-companion-conclusion", "success", "--out", corruptDir], env);
    expect(corrupt.exitCode).toBe(3);
    const corruptReport = JSON.parse(await readFile(join(corruptDir, "aggregate.json"), "utf8"));
    expect(corruptReport.gate.passed).toBe(false);
    expect(corruptReport.legCoreConclusion).toBe("failure");
    expect(corruptReport.gate.reasons.some((item: { code: string; leg?: string }) => item.code === "MISSING_LEG" && item.leg === "core-sqlite")).toBe(true);

    for (const conclusion of ["failure", "cancelled", "skipped"] as const) {
      const failedDir = join(root, `aggregate-${conclusion}`);
      const failed = command(["aggregate", "--inputs", join(inputDir, "inputs.json"), "--legs", legsDir, "--leg-core-conclusion", conclusion,
        "--leg-companion-conclusion", "success", "--out", failedDir], env);
      expect(failed.exitCode).toBe(3);
      const failedReport = JSON.parse(await readFile(join(failedDir, "aggregate.json"), "utf8"));
      expect(failedReport.gate.passed).toBe(false);
      expect(failedReport.legCoreConclusion).toBe(conclusion);
      const verification = command(["verify-aggregate", join(failedDir, "aggregate.json"), "--gate", "tc858-phase1-workspace", "--run-id", "12345", "--print", "cli.version"], env);
      expect(verification.exitCode).toBe(3);
      expect(verification.stdout?.toString()).toBe("");
    }

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
  test("non-gate aggregation rejects failed conclusions and missing resolved matrix evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc893-adhoc-"));
    roots.push(root);
    const eventFile = join(root, "dispatch-event.json");
    const inputDir = join(root, "in");
    const legsDir = join(root, "legs");
    const outputDir = join(root, "aggregate");
    const event = { repository: { full_name: "TinyCloudLabs/js-sdk" }, ref: "refs/heads/adhoc", after: "d".repeat(40) };
    await writeFile(eventFile, JSON.stringify(event));
    await mkdir(legsDir, { recursive: true });
    const dispatchInputs = JSON.stringify({ gate: "none", clients: "workspace", tier: "all", backends: '["sqlite","pg16"]' });
    const adhocEnv = {
      TC893_RUNTIME_MODULE: runtimeModule,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: event.ref,
      GITHUB_SHA: event.after,
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
    };
    const resolved = command(["resolve", "--event-file", eventFile, "--dispatch-inputs", dispatchInputs, "--out", inputDir], adhocEnv);
    expect(resolved.exitCode).toBe(0);
    const matrix = JSON.parse(resolved.stdout?.toString() ?? "") as { include: { name: string }[] };
    expect(matrix.include.map(({ name }) => name)).toEqual(["adhoc-sqlite", "speed-sqlite", "adhoc-pg16", "speed-pg16"]);

    const partialLegsDir = join(root, "partial-legs");
    await mkdir(partialLegsDir, { recursive: true });
    for (const leg of matrix.include.filter(({ name }) => name !== "speed-pg16")) {
      const result = command(["run", "--inputs", join(inputDir, "inputs.json"), "--leg", leg.name, "--results", join(partialLegsDir, leg.name)], adhocEnv);
      expect(result.exitCode).toBe(0);
    }
    const partialOut = join(root, "partial-aggregate");
    const partialAggregate = command(["aggregate", "--inputs", join(inputDir, "inputs.json"), "--legs", partialLegsDir,
      "--leg-core-conclusion", "success", "--leg-companion-conclusion", "success", "--out", partialOut], adhocEnv);
    expect(partialAggregate.exitCode).toBe(1);
    const partialReport = JSON.parse(await readFile(join(partialOut, "aggregate.json"), "utf8"));
    expect(partialReport.legCoreConclusion).toBe("failure");
    expect(partialReport.adhoc.rows.length).toBeGreaterThan(0);
    expect(partialReport.adhoc.rows.every((row: { status: string }) => row.status === "pass")).toBe(true);

    const aggregateDir = command(["aggregate", "--inputs", join(inputDir, "inputs.json"), "--legs", legsDir,
      "--leg-core-conclusion", "failure", "--leg-companion-conclusion", "success", "--out", outputDir], adhocEnv);
    expect(aggregateDir.exitCode).toBe(1);
    const report = JSON.parse(await readFile(join(outputDir, "aggregate.json"), "utf8"));
    expect(report.adhoc.rows).toEqual([]);
    expect(report.legCoreConclusion).toBe("failure");
  });
  test("non-gate aggregation rejects extra legs and mismatched inputsSha256", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc893-extra-"));
    roots.push(root);
    const eventFile = join(root, "dispatch-event.json");
    const inputDir = join(root, "in");
    const legsDir = join(root, "legs");
    const event = { repository: { full_name: "TinyCloudLabs/js-sdk" }, ref: "refs/heads/adhoc", after: "e".repeat(40) };
    await writeFile(eventFile, JSON.stringify(event));
    await mkdir(legsDir, { recursive: true });
    const dispatchInputs = JSON.stringify({ gate: "none", clients: "workspace", tier: "core", backends: '["sqlite"]' });
    const env = {
      TC893_RUNTIME_MODULE: runtimeModule,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: event.ref,
      GITHUB_SHA: event.after,
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
    };
    const resolved = command(["resolve", "--event-file", eventFile, "--dispatch-inputs", dispatchInputs, "--out", inputDir], env);
    expect(resolved.exitCode).toBe(0);
    const matrix = JSON.parse(resolved.stdout?.toString() ?? "") as { include: { name: string }[] };
    expect(matrix.include.map(({ name }) => name)).toEqual(["core-sqlite"]);
    const inputs = JSON.parse(await readFile(join(inputDir, "inputs.json"), "utf8")) as { inputsSha256: string };

    const legResults = join(legsDir, "core-sqlite");
    const run = command(["run", "--inputs", join(inputDir, "inputs.json"), "--leg", "core-sqlite", "--results", legResults], env);
    expect(run.exitCode).toBe(0);

    const aggregateArgs = (outDir: string, legs: string) =>
      ["aggregate", "--inputs", join(inputDir, "inputs.json"), "--legs", legs,
        "--leg-core-conclusion", "success", "--leg-companion-conclusion", "success", "--out", outDir];
    const clean = command(aggregateArgs(join(root, "clean-aggregate"), legsDir), env);
    expect(clean.exitCode).toBe(0);

    const extraLegsDir = join(root, "extra-legs");
    await mkdir(extraLegsDir, { recursive: true });
    await cp(legResults, join(extraLegsDir, "core-sqlite"), { recursive: true });
    await mkdir(join(extraLegsDir, "rogue-sqlite"), { recursive: true });
    const rogue = JSON.parse(await readFile(join(legResults, "report.json"), "utf8")) as { subject: unknown };
    rogue.subject = { ...(rogue.subject as object), runId: "rogue" };
    await writeFile(join(extraLegsDir, "rogue-sqlite", "report.json"), JSON.stringify(rogue));
    const extra = command(aggregateArgs(join(root, "extra-aggregate"), extraLegsDir), env);
    expect(extra.exitCode).toBe(1);
    const extraReport = JSON.parse(await readFile(join(root, "extra-aggregate", "aggregate.json"), "utf8"));
    expect(extraReport.legCoreConclusion).toBe("failure");

    const unparseableDir = join(root, "unparseable-legs");
    await cp(extraLegsDir, unparseableDir, { recursive: true });
    await writeFile(join(unparseableDir, "rogue-sqlite", "report.json"), "not json");
    const unparseable = command(aggregateArgs(join(root, "unparseable-aggregate"), unparseableDir), env);
    expect(unparseable.exitCode).toBe(1);
    const unparseableReport = JSON.parse(await readFile(join(root, "unparseable-aggregate", "aggregate.json"), "utf8"));
    expect(unparseableReport.legCoreConclusion).toBe("failure");

    const driftLegsDir = join(root, "drift-legs");
    await mkdir(join(driftLegsDir, "core-sqlite"), { recursive: true });
    const drifted = JSON.parse(await readFile(join(legResults, "report.json"), "utf8")) as { inputsSha256: string };
    drifted.inputsSha256 = "0".repeat(64);
    expect(drifted.inputsSha256).not.toBe(inputs.inputsSha256);
    await writeFile(join(driftLegsDir, "core-sqlite", "report.json"), JSON.stringify(drifted));
    const drift = command(aggregateArgs(join(root, "drift-aggregate"), driftLegsDir), env);
    expect(drift.exitCode).toBe(1);
    const driftReport = JSON.parse(await readFile(join(root, "drift-aggregate", "aggregate.json"), "utf8"));
    expect(driftReport.legCoreConclusion).toBe("failure");
  });
  test("schema-invalid leg reports still write the aggregate and fail the conclusion", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc893-invalid-"));
    roots.push(root);
    const env = {
      TC893_RUNTIME_MODULE: runtimeModule,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/475/merge",
      GITHUB_SHA: "f".repeat(40),
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
    };
    const gateEvent = {
      repository: { full_name: "TinyCloudLabs/js-sdk" },
      pull_request: { number: 475, head: { sha: "a".repeat(40), ref: "feat/tc-893-harness-s3b" }, base: { sha: "b".repeat(40), ref: "master" } },
    };
    const gateEventFile = join(root, "gate-event.json");
    await writeFile(gateEventFile, JSON.stringify(gateEvent));
    const gateInputs = join(root, "gate-in");
    const gateResolved = command(["resolve", "--event-file", gateEventFile,
      "--dispatch-inputs", JSON.stringify({ gate: "tc858-phase1-workspace", clients: "workspace", set: "phase1-companion", tier: "core", backends: '["sqlite","pg16"]' }),
      "--out", gateInputs], env);
    expect(gateResolved.exitCode).toBe(0);
    const gateMatrix = JSON.parse(gateResolved.stdout?.toString() ?? "") as { include: { name: string }[] };
    const gateLegs = join(root, "gate-legs");
    for (const leg of gateMatrix.include) {
      const run = command(["run", "--inputs", join(gateInputs, "inputs.json"), "--leg", leg.name, "--results", join(gateLegs, leg.name)], env);
      expect(run.exitCode).toBe(0);
    }
    const adhocEventFile = join(root, "adhoc-event.json");
    await writeFile(adhocEventFile, JSON.stringify({ repository: { full_name: "TinyCloudLabs/js-sdk" }, ref: "refs/heads/adhoc", after: "0".repeat(40) }));
    const adhocEnv = { ...env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/adhoc", GITHUB_SHA: "0".repeat(40) };
    const adhocInputs = join(root, "adhoc-in");
    const adhocResolved = command(["resolve", "--event-file", adhocEventFile,
      "--dispatch-inputs", JSON.stringify({ gate: "none", clients: "workspace", tier: "core", backends: '["sqlite"]' }), "--out", adhocInputs], adhocEnv);
    expect(adhocResolved.exitCode).toBe(0);
    const adhocLegs = join(root, "adhoc-legs");
    const adhocRun = command(["run", "--inputs", join(adhocInputs, "inputs.json"), "--leg", "core-sqlite", "--results", join(adhocLegs, "core-sqlite")], adhocEnv);
    expect(adhocRun.exitCode).toBe(0);

    const gateReportPath = join(gateLegs, "core-sqlite", "report.json");
    const adhocReportPath = join(adhocLegs, "core-sqlite", "report.json");
    const mutations: { label: string; rewrite: (report: unknown) => string }[] = [
      { label: "results-string", rewrite: (report) => JSON.stringify({ ...(report as Record<string, unknown>), results: "bad" }) },
      { label: "results-null", rewrite: (report) => JSON.stringify({ ...(report as Record<string, unknown>), results: null }) },
      { label: "top-level-array", rewrite: () => "[]" },
      { label: "missing-interrupted", rewrite: (report) => { const clone = { ...(report as Record<string, unknown>) }; delete clone.interrupted; return JSON.stringify(clone); } },
      { label: "empty-backends", rewrite: (report) => { const clone = JSON.parse(JSON.stringify(report)) as { invocation: { backends: string[] } }; clone.invocation.backends = []; return JSON.stringify(clone); } },
    ];
    for (const [index, mutation] of mutations.entries()) {
      const gateCopy = join(root, `gate-invalid-${index}`);
      await cp(gateLegs, gateCopy, { recursive: true });
      const gateReport = JSON.parse(await readFile(gateReportPath, "utf8"));
      await writeFile(join(gateCopy, "core-sqlite", "report.json"), mutation.rewrite(gateReport));
      const gateOut = join(root, `gate-invalid-out-${index}`);
      const gateResult = command(["aggregate", "--inputs", join(gateInputs, "inputs.json"), "--legs", gateCopy,
        "--leg-core-conclusion", "success", "--leg-companion-conclusion", "success", "--out", gateOut], env);
      expect(gateResult.exitCode).toBe(3);
      const gateAggregate = JSON.parse(await readFile(join(gateOut, "aggregate.json"), "utf8"));
      expect(gateAggregate.gate.passed).toBe(false);
      expect(gateAggregate.legCoreConclusion).toBe("failure");
      expect(gateAggregate.gate.reasons.some((item: { code: string; leg?: string }) => item.code === "MISSING_LEG" && item.leg === "core-sqlite")).toBe(true);

      const adhocCopy = join(root, `adhoc-invalid-${index}`);
      await cp(adhocLegs, adhocCopy, { recursive: true });
      const adhocReport = JSON.parse(await readFile(adhocReportPath, "utf8"));
      await writeFile(join(adhocCopy, "core-sqlite", "report.json"), mutation.rewrite(adhocReport));
      const adhocOut = join(root, `adhoc-invalid-out-${index}`);
      const adhocResult = command(["aggregate", "--inputs", join(adhocInputs, "inputs.json"), "--legs", adhocCopy,
        "--leg-core-conclusion", "success", "--leg-companion-conclusion", "success", "--out", adhocOut], adhocEnv);
      expect(adhocResult.exitCode).toBe(1);
      const adhocAggregate = JSON.parse(await readFile(join(adhocOut, "aggregate.json"), "utf8"));
      expect(adhocAggregate.legCoreConclusion).toBe("failure");
    }
  });
  test("skipped companion conclusion passes without companion legs but fails when the matrix lists them", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc893-skipped-"));
    roots.push(root);
    const eventFile = join(root, "dispatch-event.json");
    const event = { repository: { full_name: "TinyCloudLabs/js-sdk" }, ref: "refs/heads/adhoc", after: "1".repeat(40) };
    await writeFile(eventFile, JSON.stringify(event));
    const env = {
      TC893_RUNTIME_MODULE: runtimeModule,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: event.ref,
      GITHUB_SHA: event.after,
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
    };

    // No companion legs in the matrix: a skipped leg-companion job is benign.
    const bareInputs = join(root, "bare-in");
    const bareResolved = command(["resolve", "--event-file", eventFile,
      "--dispatch-inputs", JSON.stringify({ gate: "none", clients: "workspace", tier: "core", backends: '["sqlite"]', set: "" }),
      "--out", bareInputs], env);
    expect(bareResolved.exitCode).toBe(0);
    const bareLegs = join(root, "bare-legs");
    const bareRun = command(["run", "--inputs", join(bareInputs, "inputs.json"), "--leg", "core-sqlite", "--results", join(bareLegs, "core-sqlite")], env);
    expect(bareRun.exitCode).toBe(0);
    const bare = command(["aggregate", "--inputs", join(bareInputs, "inputs.json"), "--legs", bareLegs,
      "--leg-core-conclusion", "success", "--leg-companion-conclusion", "skipped", "--out", join(root, "bare-aggregate")], env);
    expect(bare.exitCode).toBe(0);

    // Companion legs in the matrix: skipped still fails.
    const companionInputs = join(root, "companion-in");
    const companionResolved = command(["resolve", "--event-file", eventFile,
      "--dispatch-inputs", JSON.stringify({ gate: "none", clients: "workspace", tier: "core", backends: '["sqlite"]', set: "phase1-companion" }),
      "--out", companionInputs], env);
    expect(companionResolved.exitCode).toBe(0);
    const companionMatrix = JSON.parse(companionResolved.stdout?.toString() ?? "") as { include: { name: string; set: string | null }[] };
    expect(companionMatrix.include.some((leg) => leg.set !== null)).toBe(true);
    const companionLegs = join(root, "companion-legs");
    for (const leg of companionMatrix.include) {
      const run = command(["run", "--inputs", join(companionInputs, "inputs.json"), "--leg", leg.name, "--results", join(companionLegs, leg.name)], env);
      expect(run.exitCode).toBe(0);
    }
    const skipped = command(["aggregate", "--inputs", join(companionInputs, "inputs.json"), "--legs", companionLegs,
      "--leg-core-conclusion", "success", "--leg-companion-conclusion", "skipped", "--out", join(root, "companion-aggregate")], env);
    expect(skipped.exitCode).toBe(1);
    const skippedReport = JSON.parse(await readFile(join(root, "companion-aggregate", "aggregate.json"), "utf8"));
    expect(skippedReport.legCompanionConclusion).toBe("skipped");
  });
});
