import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AggregateOptions, LegEvidence } from "./aggregate";
import { aggregate, aggregateExitCode } from "./aggregate";
import type { GateReasonCode, Manifest, RunInputs } from "../contracts/gate";
import { canonicalSha256, sha256 } from "./canonical-json";
import { VerifyAggregateError, verifyAggregate } from "./verify";
import { registerHarnessCommandHandlers, runCommand } from "../../bin/harness";
import { createManifest, type ManifestRegistry } from "./manifest";
import type { Scenario } from "../contracts/scenario";
import { runGateLocally } from "./local-run";

const rootDirs: string[] = [];
afterEach(async () => { await Promise.all(rootDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(options: { companionFails?: boolean } = {}): Promise<AggregateOptions> {
  const root = await mkdtemp(join(tmpdir(), "tc893-gate-"));
  rootDirs.push(root);
  const inputsBase = {
    schema: "tc893.inputs/v1" as const, gate: "tc858-phase1-workspace" as const, sets: ["phase1-companion"] as const,
    tiers: ["core"] as const, backends: ["sqlite", "pg16"] as const,
    subject: { repo: "TinyCloudLabs/js-sdk", event: "local" as const, ref: "refs/heads/test", sha: "test-sha", runId: "run-1" },
    harnessSha: "harness-sha",
    sut: { source: "workspace" as const, gitSha: "sut-sha", distSha256: "a".repeat(64), cli: { version: "1.2.3", packageJson: "/cli/package.json", entry: "/cli/index.js" }, nodeSdk: { version: "3.2.1", packageJson: "/sdk/package.json", entry: "/sdk/index.js", condition: "import" as const } },
    image: { role: "prod" as const, ref: "node:1.2.3", digest: `sha256:${"b".repeat(64)}`, pinned: `node@sha256:${"b".repeat(64)}`, nodeVersion: "1.2.3", features: ["kv-sync-v1"] },
    production: { url: "https://node/info", version: "1.2.3", features: ["kv-sync-v1"], capturedAt: "2026-10-10T00:00:00Z" },
    preflight: { passed: true, checks: [{ name: "sqliteReplicaStorage", ok: true }] }, junitPrecondition: null,
    resolvedAt: "2026-10-10T00:00:00Z",
  };
  const inputs = { ...inputsBase, inputsSha256: canonicalSha256(inputsBase) } as unknown as RunInputs;
  const captureFiles = ["result.json", "clients/owner/events.jsonl", "clients/owner/stderr.log"];
  const coreRows = ["sqlite", "pg16"].map((backend) => ({ key: `CORE-00@${backend}`, id: "CORE-00", variant: null, backend, tier: "core", requiredArtefacts: captureFiles })) as Manifest["rows"];
  const coreBody = { schema: "tc893.manifest/v1" as const, gate: inputs.gate, set: null, harnessSha: inputs.harnessSha, inputsSha256: inputs.inputsSha256, rows: coreRows };
  const coreManifest = { ...coreBody, manifestSha256: canonicalSha256(coreBody) } as Manifest;
  const companionRows = [{ key: "EDGE-12@sqlite", id: "EDGE-12", variant: null, backend: "sqlite", tier: "edge", requiredArtefacts: captureFiles }] as Manifest["rows"];
  const companionBody = { schema: "tc893.manifest/v1" as const, gate: inputs.gate, set: "phase1-companion" as const, harnessSha: inputs.harnessSha, inputsSha256: inputs.inputsSha256, rows: companionRows };
  const companionManifest = { ...companionBody, manifestSha256: canonicalSha256(companionBody) } as Manifest;
  const makeLeg = async (name: string, backend: "sqlite" | "pg16", set: "phase1-companion" | null, key: string, status: "pass" | "fail" = "pass"): Promise<LegEvidence> => {
    const directory = join(root, name);
    const artefactDir = `rows/${key.replaceAll("@", "-")}`;
    await mkdir(join(directory, artefactDir), { recursive: true });
    const artefacts = [];
    for (const path of captureFiles) {
      const bytes = path === "result.json" ? Buffer.from("{}\\n") : Buffer.alloc(0);
      const artefactPath = join(directory, artefactDir, path);
      await mkdir(dirname(artefactPath), { recursive: true });
      await writeFile(artefactPath, bytes);
      artefacts.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
    }
    const report = {
      schema: "tc893.report/v1", kind: "leg", runId: "run-1", startedAt: "2026-10-10T00:00:00Z", finishedAt: "2026-10-10T00:00:01Z", durationMs: 1, interrupted: false,
      invocation: { tiers: [set ? "edge" : "core"], set, only: null, backends: [backend], concurrency: 1, speedConcurrency: 1, argv: [] },
      filtered: false, subject: { ...inputs.subject }, harnessSha: inputs.harnessSha, harnessDirty: false, inputsSha256: inputs.inputsSha256, manifestSha256: set ? companionManifest.manifestSha256 : coreManifest.manifestSha256,
      environment: { runnerClass: "linux", os: "linux", cpus: 2, docker: "test", node: "22", bun: "1.3" }, sut: structuredClone(inputs.sut), image: { ...inputs.image },
      results: [{ key, id: key.split("@")[0], variant: null, backend, tier: set ? "edge" : "core", sets: set ? [set] : [], status, durationMs: 1, assertions: [], metrics: [], artefactDir,
        artefacts, teardown: { leaked: [], errors: [] } }],
      summary: { pass: status === "pass" ? 1 : 0, fail: status === "fail" ? 1 : 0, error: 0, skipped: 0, unsupported: 0, xfail: 0, xpass: 0 }, quarantined: [], teardown: { leaked: [] },
    };
    return { name, directory, report };
  };
  const legs = [
    await makeLeg("core-sqlite", "sqlite", null, "CORE-00@sqlite"),
    await makeLeg("core-pg16", "pg16", null, "CORE-00@pg16"),
    await makeLeg("companion-sqlite", "sqlite", "phase1-companion", "EDGE-12@sqlite", options.companionFails ? "fail" : "pass"),
  ];
  return {
    inputs, coreManifest, companionManifests: new Map([["phase1-companion", companionManifest]]),
    recomputedCoreManifest: coreManifest, recomputedCompanionManifests: new Map([["phase1-companion", companionManifest]]),
    legs, legCoreConclusion: "success", legCompanionConclusion: "success", producedAt: "2026-10-10T00:00:02Z",
  };
}

const cases: readonly [GateReasonCode, (options: AggregateOptions) => Promise<void> | void][] = [
  ["MISSING_LEG", async (options) => { options.legs = options.legs.filter((leg) => leg.name !== "core-pg16"); }],
  ["DUPLICATE_LEG", async (options) => { options.legs.push({ ...options.legs[0]!, name: "core-sqlite-duplicate" }); }],
  ["LEG_JOB_FAILED", (options) => { options.legCoreConclusion = "failure"; }],
  ["INPUTS_MISMATCH", (options) => { (options.legs[0]!.report as { inputsSha256: string }).inputsSha256 = "c".repeat(64); }],
  ["MANIFEST_MISMATCH", (options) => { options.recomputedCoreManifest = { ...options.coreManifest!, rows: [] }; }],
  ["FILTERED_LEG", (options) => { (options.legs[0]!.report as { filtered: boolean }).filtered = true; }],
  ["MISSING_ROW", (options) => { (options.legs[0]!.report as { results: unknown[] }).results = []; }],
  ["EXTRA_ROW", (options) => { (options.legs[0]!.report as { results: unknown[] }).results.push({ ...(options.legs[0]!.report as { results: Record<string, unknown>[] }).results[0], key: "UNLISTED@sqlite" }); }],
  ["ROW_NOT_PASS", (options) => { (options.legs[0]!.report as { results: { status: string }[] }).results[0]!.status = "fail"; }],
  ["QUARANTINED", (options) => { (options.legs[0]!.report as { quarantined: string[] }).quarantined.push("CORE-00@sqlite"); }],
  ["MISSING_ARTEFACT", async (options) => { await rm(join(options.legs[0]!.directory, "rows/CORE-00-sqlite/result.json")); }],
  ["SUT_SOURCE_MISMATCH", (options) => { (options.inputs as { sut: unknown }).sut = { ...options.inputs.sut, source: "published", lockfileSha256: "d".repeat(64) }; }],
  ["SUT_IDENTITY_MISMATCH", (options) => { (options.legs[0]!.report as { sut: { gitSha: string } }).sut.gitSha = "other"; }],
  ["IMAGE_MISMATCH", (options) => { (options.legs[0]!.report as { image: { digest: string } }).image.digest = `sha256:${"e".repeat(64)}`; }],
  ["PROD_VERSION_MISMATCH", (options) => { (options.inputs as { production: { version: string } }).production.version = "1.2.4"; }],
  ["SUBJECT_MISMATCH", (options) => { (options.legs[0]!.report as { subject: { sha: string } }).subject.sha = "other"; }],
  ["TEARDOWN_LEAK", (options) => { (options.legs[0]!.report as { teardown: { leaked: unknown[] } }).teardown.leaked.push({ kind: "volume", name: "leak", labels: {} }); }],
];

describe("aggregate fixture-leg gate rules", () => {
  test.each(cases)("emits %s for its failing fixture", async (code, mutate) => {
    const options = await fixture();
    await mutate(options);
    const aggregateReport = await aggregate(options);
    
    expect(aggregateReport.gate?.reasons.map((item) => item.code)).toContain(code);
    expect(aggregateExitCode(aggregateReport)).toBe(3);
  });

  test("core passes while a failing companion remains separate", async () => {
    const options = await fixture({ companionFails: true });
    options.legCompanionConclusion = "failure";
    const report = await aggregate(options);
    expect(report.gate?.passed).toBe(true);
    expect(report.companion[0]?.passed).toBe(false);
    expect(aggregateExitCode(report)).toBe(0);
  });
  test("an empty companion manifest requires no synthetic leg", async () => {
    const options = await fixture();
    const current = options.companionManifests.get("phase1-companion")!;
    const { manifestSha256: _, ...body } = current;
    const emptyBody = { ...body, rows: [] };
    const emptyManifest = { ...emptyBody, manifestSha256: canonicalSha256(emptyBody) } as Manifest;
    options.companionManifests = new Map(options.companionManifests).set("phase1-companion", emptyManifest);
    options.recomputedCompanionManifests = new Map(options.recomputedCompanionManifests).set("phase1-companion", emptyManifest);
    options.legs = options.legs.filter((leg) => leg.name !== "companion-sqlite");
    options.legCompanionConclusion = "failure";
    const report = await aggregate(options);
    expect(report.gate?.passed).toBe(true);
    expect(report.companion[0]?.passed).toBe(true);
  });
  test("a matching empty core manifest cannot pass a gate", async () => {
    const options = await fixture();
    const current = options.coreManifest!;
    const { manifestSha256: _, ...body } = current;
    const emptyBody = { ...body, rows: [] };
    const emptyManifest = { ...emptyBody, manifestSha256: canonicalSha256(emptyBody) } as Manifest;
    options.coreManifest = emptyManifest;
    options.recomputedCoreManifest = emptyManifest;
    for (const leg of options.legs.filter((item) => item.name.startsWith("core-"))) {
      (leg.report as { results: unknown[] }).results = [];
    }
    const report = await aggregate(options);
    expect(report.gate?.passed).toBe(false);
    expect(report.gate?.reasons.some((item) => item.code === "MANIFEST_MISMATCH" && item.detail.includes("empty"))).toBe(true);
    expect(aggregateExitCode(report)).toBe(3);
  });

  test("a gate manifest must have rows on SQLite and PG while an empty companion manifest is valid", async () => {
    const options = await fixture();
    const context: ManifestRegistry["context"] = {
      tiers: ["core"], backends: ["sqlite", "pg16"],
      sut: options.inputs.sut, image: options.inputs.image, ciPinImage: "ci-pin",
    };
    expect(() => createManifest(options.inputs, { scenarios: [], context })).toThrow(/must not be empty/);
    const sqliteOnlyScenario = {
      id: "CORE-00", title: "Core preflight", tier: "core", backends: ["sqlite"], timeoutMs: 1,
      topology: () => ({ nodes: [], clients: [] }), run: async () => {},
    } as unknown as Scenario;
    expect(() => createManifest(options.inputs, { scenarios: [sqliteOnlyScenario], context })).toThrow(/no pg16 rows/);
    expect(createManifest(options.inputs, { scenarios: [], context }, "phase1-companion").rows).toEqual([]);
    const { inputsSha256: _, ...originalInputs } = options.inputs;
    const adhocBody: Omit<RunInputs, "inputsSha256"> = { ...originalInputs, gate: null, tiers: ["edge"], backends: ["pg16"] };
    const adhocInputs: RunInputs = { ...adhocBody, inputsSha256: canonicalSha256(adhocBody) };
    const edgeScenario = {
      id: "EDGE-12", title: "Edge case", tier: "edge", timeoutMs: 1000, backends: ["pg16"],
      topology: () => ({ nodes: [], clients: [] }), run: async () => {},
    } as unknown as Scenario;
    const adhocManifest = createManifest(adhocInputs, {
      scenarios: [sqliteOnlyScenario, edgeScenario],
      context: { ...context, tiers: ["edge"], backends: ["pg16"] },
    });
    expect(adhocManifest.rows.map((row) => row.key)).toEqual(["EDGE-12@pg16"]);
  });
  test("a matching core manifest with rows on only one backend cannot pass", async () => {
    const options = await fixture();
    const current = options.coreManifest!;
    const { manifestSha256: _, ...body } = current;
    const sqliteOnlyBody = { ...body, rows: current.rows.filter((row) => row.backend === "sqlite") };
    const sqliteOnly = { ...sqliteOnlyBody, manifestSha256: canonicalSha256(sqliteOnlyBody) } as Manifest;
    options.coreManifest = sqliteOnly;
    options.recomputedCoreManifest = sqliteOnly;
    const report = await aggregate(options);
    expect(report.gate?.passed).toBe(false);
    expect(report.gate?.reasons.some((item) => item.code === "MANIFEST_MISMATCH" && item.detail.includes("no pg16 rows"))).toBe(true);
  });
  test("local run --gate resolves, runs each leg, recomputes manifests, and writes its diagnostic aggregate", async () => {
    const options = await fixture();
    const resultsDir = join(options.legs[0]!.directory, "local");
    const events: string[] = [];
    const result = await runGateLocally({
      resolve: async () => {
        events.push("resolve");
        return {
          inputs: options.inputs, coreManifest: options.coreManifest!, companionManifests: options.companionManifests,
          matrix: [
            { name: "core-sqlite", backend: "sqlite", set: null },
            { name: "core-pg16", backend: "pg16", set: null },
            { name: "companion-sqlite", backend: "sqlite", set: "phase1-companion" },
          ],
          resultsDir,
        };
      },
      runLeg: async (entry) => {
        events.push(`leg:${entry.name}`);
        return options.legs.find((leg) => leg.name === entry.name)!;
      },
      recomputeManifest: async (set) => {
        events.push(`manifest:${set ?? "core"}`);
        return set === null ? options.recomputedCoreManifest! : options.recomputedCompanionManifests.get(set)!;
      },
    });
    expect(events).toEqual(["resolve", "leg:core-sqlite", "leg:core-pg16", "leg:companion-sqlite", "manifest:core", "manifest:phase1-companion"]);
    expect(result.aggregate.gate?.passed).toBe(true);
    expect(JSON.parse(await readFile(join(resultsDir, "aggregate.json"), "utf8")).gate.passed).toBe(true);
  });
  test("verify-aggregate selects an exact CLI SemVer after core and companion pass", async () => {
    const report = await aggregate(await fixture());
    expect(verifyAggregate(report, { gate: "tc858-phase1-workspace", print: "cli.version" }).output).toBe("1.2.3");
  });
  test("verify-aggregate CLI prints only the exact version to stdout", async () => {
    const options = await fixture();
    const cliReport = await aggregate(options);
    const aggregatePath = join(options.legs[0]!.directory, "aggregate.json");
    await writeFile(aggregatePath, JSON.stringify(cliReport));
    const originalFetch = globalThis.fetch;
    const originalStdout = process.stdout.write.bind(process.stdout);
    const originalStderr = process.stderr.write.bind(process.stderr);
    let stdout = "";
    let stderr = "";
    globalThis.fetch = (async () => new Response(JSON.stringify({ version: "1.2.3" }))) as unknown as typeof fetch;
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      await runCommand(["verify-aggregate", aggregatePath, "--gate", "tc858-phase1-workspace", "--print", "cli.version"]);
      expect(stdout).toBe("1.2.3\n");
      expect(stderr).toContain("gate=passed companion=passed");
    } finally {
      globalThis.fetch = originalFetch;
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    }
  });

  test("an interrupted core leg fails the local gate command even when all of its rows pass", async () => {
    const options = await fixture();
    const root = await mkdtemp(join(tmpdir(), "tc893-local-interrupted-"));
    rootDirs.push(root);
    const legs = options.legs.map((leg) => leg.name === "core-sqlite"
      ? { ...leg, report: { ...(leg.report as Record<string, unknown>), interrupted: true } }
      : leg);
    const hooks = {
      resolve: async () => ({
        inputs: options.inputs, coreManifest: options.coreManifest!, companionManifests: options.companionManifests,
        matrix: legs.map((leg) => {
          const report = leg.report as { invocation: { backends: ("sqlite" | "pg16")[]; set: "phase1-companion" | null } };
          return { name: leg.name, backend: report.invocation.backends[0]!, set: report.invocation.set };
        }), resultsDir: root,
      }),
      runLeg: async (entry: { name: string }) => legs.find((leg) => leg.name === entry.name)!,
      recomputeManifest: async (set: "phase1-companion" | null) => set ? options.companionManifests.get(set)! : options.coreManifest!,
    };
    const originalExitCode = process.exitCode;
    process.exitCode = 0;
    registerHarnessCommandHandlers({ gateHooks: async () => hooks });
    try {
      await runCommand(["run", "--gate", "tc858-phase1-workspace"]);
      const report = JSON.parse(await readFile(join(root, "aggregate.json"), "utf8"));
      expect(report.gate.passed).toBe(false);
      expect(report.legCoreConclusion).toBe("cancelled");
      expect(report.gate.rows.every((row: { status: string }) => row.status === "pass")).toBe(true);
      expect(process.exitCode).toBe(3);
    } finally {
      registerHarnessCommandHandlers({ gateHooks: undefined });
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("aggregate-checkout recomputation catches a core manifest row omitted at resolve", async () => {
    const options = await fixture();
    options.coreManifest = { ...options.coreManifest!, rows: options.coreManifest!.rows.slice(0, 1) };
    const report = await aggregate(options);
    expect(report.gate?.reasons.some((item) => item.code === "MANIFEST_MISMATCH")).toBe(true);
    expect(report.gate?.rows).toHaveLength(2);
  });

  test("recomputation catches a core row omitted from the leg report", async () => {
    const options = await fixture();
    (options.legs[0]!.report as { results: unknown[] }).results = [];
    const report = await aggregate(options);
    expect(report.gate?.reasons.some((item) => item.code === "MISSING_ROW" && item.key === "CORE-00@sqlite")).toBe(true);
  });
  test("rejects a PG manifest row whose result declares the SQLite backend", async () => {
    const options = await fixture();
    const pgReport = options.legs.find((leg) => leg.name === "core-pg16")!.report as { results: { backend: string }[] };
    pgReport.results[0]!.backend = "sqlite";
    const report = await aggregate(options);
    expect(report.gate?.passed).toBe(false);
    expect(report.gate?.reasons.some((item) => item.code === "EXTRA_ROW" && item.leg === "core-pg16")).toBe(true);
    expect(report.gate?.reasons.some((item) => item.code === "MISSING_ROW" && item.key === "CORE-00@pg16")).toBe(true);
  });

  test("a SQLite leg cannot supply the PG row when the PG leg is empty", async () => {
    const options = await fixture();
    const sqliteReport = options.legs.find((leg) => leg.name === "core-sqlite")!.report as { results: Record<string, unknown>[] };
    const pgReport = options.legs.find((leg) => leg.name === "core-pg16")!.report as { results: unknown[] };
    sqliteReport.results.push({ ...structuredClone(sqliteReport.results[0]!), key: "CORE-00@pg16", backend: "pg16" });
    pgReport.results = [];
    const report = await aggregate(options);
    expect(report.gate?.passed).toBe(false);
    expect(report.gate?.reasons.some((item) => item.code === "EXTRA_ROW" && item.leg === "core-sqlite")).toBe(true);
    expect(report.gate?.reasons.some((item) => item.code === "MISSING_ROW" && item.key === "CORE-00@pg16")).toBe(true);
  });
  test("rejects a capture whose bytes no longer match the leg SHA-256", async () => {
    const options = await fixture();
    (options.legs[0]!.report as { results: { artefacts: { sha256: string }[] }[] }).results[0]!.artefacts[0]!.sha256 = "f".repeat(64);
    const report = await aggregate(options);
    expect(report.gate?.reasons.some((item) => item.code === "MISSING_ARTEFACT" && item.key === "CORE-00@sqlite")).toBe(true);
  });
});
