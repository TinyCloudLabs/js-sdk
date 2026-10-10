import { describe, expect, test } from "bun:test";
import { runCommand, exactSemver, parseArgs, type Command } from "../bin/harness";
import { HarnessError } from "../src/contracts/common";
import { realClock, waitFor } from "../src/contracts/clock";
import { validateTopology, type TopologySpec } from "../src/contracts/topology";
import { prepareSharedEndpointStorageDeviceSpec } from "../src/contracts/frozen";
import { isDivergence, isRead, isState, isSync, isWrite } from "../src/contracts/events";
import { AggregateReportSchema } from "../src/schemas/report";
import { JunitPreconditionSchema, ManifestSchema, RunInputsSchema } from "../src/schemas/gate";

describe("contract guards", () => {
  test("event guards narrow only the matching event discriminant", () => {
    const read = { type: "replication.read" };
    const write = { type: "replication.write" };
    const sync = { type: "replication.sync" };
    const state = { type: "replication.state" };
    const divergence = { type: "replication.divergence" };
    expect([isRead(read), isWrite(read), isSync(write), isState(sync), isDivergence(state), isDivergence(divergence)])
      .toEqual([true, false, false, false, false, true]);
  });

  test("topology reports multiple violations and requires earlier same-identity issuer", () => {
    const spec: TopologySpec = {
      name: "bad", nodes: [{ id: "a" }], clients: [
        { id: "device", kind: "sdk", node: "missing", identity: "x", auth: { posture: "delegate-session", grant: { issuer: "owner", caps: [], expiresInMs: 1 } }, replication: { prefixes: ["notes", "notes/a/"] } },
        { id: "owner", kind: "sdk", node: "a", identity: "x", auth: { posture: "owner" } },
      ],
    };
    try { validateTopology(spec); throw new Error("expected topology validation failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).code).toBe("TOPOLOGY_INVALID");
      expect((error as HarnessError).detail).toMatchObject({ errors: expect.arrayContaining([
        expect.stringContaining("unknown node"), expect.stringContaining("must end in /"), expect.stringContaining("overlapping prefixes"), expect.stringContaining("earlier owner"), expect.stringContaining("expiry must be at least 60000ms"),
      ]) });
    }
  });

  test("shared-device topology overrides endpoint and storage before client construction", () => {
    const spec: TopologySpec = {
      name: "shared-device", nodes: [{ id: "a" }], clients: [
        { id: "devicea", kind: "sdk", node: "a", identity: "owner", auth: { posture: "owner" }, replication: { prefixes: ["notes/"], mode: "background" } },
        { id: "deviceb", kind: "sdk", node: "a", identity: "owner", auth: { posture: "owner" }, replication: { prefixes: ["notes/"], mode: "background" } },
      ],
    };
    const deviceProofs = [{ id: "device-a", proof: { key: "proof-a" } }, { id: "device-b", proof: { key: "proof-b" } }] as const;
    const prepared = prepareSharedEndpointStorageDeviceSpec({
      spec, clientIds: ["devicea", "deviceb"], canonicalEndpoint: "https://node.example", replicaRoot: "/tmp/shared-replica", deviceProofs,
    });
    const [first, second] = prepared.clients;
    expect([first.endpoint, second.endpoint]).toEqual(["https://node.example", "https://node.example"]);
    expect([first.replication && first.replication.mode, second.replication && second.replication.mode]).toEqual(["foreground", "foreground"]);
    expect([first.deviceProof, second.deviceProof]).toEqual([deviceProofs[0].proof, deviceProofs[1].proof]);
    expect(first.deviceProof).not.toBe(second.deviceProof);
    expect(spec.clients[0].endpoint).toBeUndefined();
  });

  test("waitFor returns a later probe result and rejects stalled probes at deadline or abort", async () => {
    let attempts = 0;
    const result = await waitFor(realClock, async () => ++attempts === 2 ? "ready" : undefined, { deadlineMs: 500, intervalMs: 1, describe: "readiness" });
    expect(result).toBe("ready");
    const { promise: stalledProbe } = Promise.withResolvers<undefined>();
    await expect(waitFor(realClock, () => stalledProbe, { deadlineMs: 5, describe: "stalled probe" }))
      .rejects.toMatchObject({ code: "DEADLINE_EXCEEDED", message: "stalled probe" });
    const controller = new AbortController();
    const { promise: abortedProbe } = Promise.withResolvers<undefined>();
    await expect(waitFor(realClock, () => { controller.abort("cancelled"); return abortedProbe; }, { deadlineMs: 500, describe: "aborted probe", signal: controller.signal }))
      .rejects.toMatchObject({ code: "ABORTED" });
  });

});
const digest = "a".repeat(64);
const inputs = {
  schema: "tc893.inputs/v1" as const, gate: "tc858-phase1-workspace" as const, sets: ["phase1-companion"] as const,
  tiers: ["core", "edge"] as const, backends: ["sqlite", "pg16"] as const,
  subject: { repo: "TinyCloudLabs/js-sdk", event: "pull_request" as const, ref: "refs/pull/12/merge", sha: "merge-sha", headSha: "head-sha", baseSha: "base-sha", prNumber: 12 },
  harnessSha: "harness-sha",
  sut: { source: "workspace" as const, gitSha: "sut-sha", distSha256: digest, cli: { version: "1.2.3", packageJson: "/cli/package.json", entry: "/cli/index.js" }, nodeSdk: { version: "3.2.1", packageJson: "/sdk/package.json", entry: "/sdk/index.js", condition: "import" as const } },
  image: { role: "prod" as const, ref: "node:1.2.3", digest: `sha256:${digest}`, pinned: `node@sha256:${digest}`, nodeVersion: "1.2.3", features: ["kv-sync-v1"] },
  production: { url: "https://node/info", version: "1.2.3", features: ["kv-sync-v1"], capturedAt: "2026-10-10T00:00:00Z" },
  preflight: { passed: true, checks: [{ name: "node", ok: true }] },
  junitPrecondition: { schema: "tc893.junit-precondition/v1" as const, minimumsVersion: 1 as const, testedSha: "head-sha", association: { prNumber: 12, headSha: "head-sha", baseSha: "base-sha" }, suites: [
    { name: "cli-acceptance-sqlite", present: true, exitCode: 0, skipped: 0, tests: 1 },
    { name: "cli-acceptance-pg16", present: true, exitCode: 0, skipped: 0, tests: 1 },
    { name: "node-sdk-real-node-sqlite", present: true, exitCode: 0, skipped: 0, tests: 3 },
    { name: "node-sdk-real-node-pg16", present: true, exitCode: 0, skipped: 0, tests: 3 },
  ] },
  resolvedAt: "2026-10-10T00:00:00Z", inputsSha256: digest,
};
const coreManifest = { schema: "tc893.manifest/v1" as const, gate: "tc858-phase1-workspace" as const, set: null, harnessSha: "harness-sha", inputsSha256: digest, rows: [], manifestSha256: digest };
const coreRows = ["sqlite", "pg16"].map((backend) => ({
  key: `CORE-00@${backend}`, id: "CORE-00", variant: null, backend, tier: "core", requiredArtefacts: ["result.json"],
  status: "pass", durationMs: 1, artefactDir: `core/${backend}`, missingArtefacts: [], quarantined: false,
}));
const coreLegs = ["sqlite", "pg16"].map((backend) => ({
  name: `core-${backend}`, backend, set: null, runId: "run-1", reportSha256: digest, inputsSha256: digest,
  manifestSha256: digest, filtered: false, durationMs: 1, summary: { pass: 1 },
}));
const validGate = { id: "tc858-phase1-workspace", manifestSha256: digest, passed: true, reasons: [], rows: coreRows };
const validAggregate = {
  schema: "tc893.aggregate/v1", inputs, gate: validGate,
  companion: [{ set: "phase1-companion", manifestSha256: digest, passed: false, reasons: [{ code: "ROW_NOT_PASS", key: "EDGE-01@sqlite", detail: "companion row failed" }], rows: [] }],
  adhoc: null, legs: coreLegs, legCoreConclusion: "success", legCompanionConclusion: "failure", producedAt: "2026-10-10T00:00:00Z",
} as const;

describe("serialized contracts", () => {
  test("inputs and manifests validate; junit requires both backends and exact PR association", () => {
    expect(RunInputsSchema.safeParse(inputs).success).toBe(true);
    expect(ManifestSchema.parse(coreManifest)).toEqual(coreManifest);
    const junit = inputs.junitPrecondition;
    expect(JunitPreconditionSchema.safeParse({ ...junit, suites: junit.suites.filter((suite) => suite.name !== "cli-acceptance-pg16") }).success).toBe(false);
    expect(RunInputsSchema.safeParse({ ...inputs, junitPrecondition: { ...junit, association: { prNumber: 13, headSha: "other-head", baseSha: "other-base" }, testedSha: "other-head" } }).success).toBe(false);
    expect(RunInputsSchema.safeParse({ ...inputs, junitPrecondition: { ...junit, association: { ...junit.association, headSha: "other-head" }, testedSha: "other-head" } }).success).toBe(false);
    expect(RunInputsSchema.safeParse({ ...inputs, junitPrecondition: { ...junit, association: { ...junit.association, baseSha: "other-base" } } }).success).toBe(false);
  });

  test("aggregate pass requires complete serialized core evidence and ignores companion verdicts", () => {
    expect(AggregateReportSchema.safeParse(validAggregate).success).toBe(true);
    const noLegReports = { ...validAggregate, legs: [] };
    const missingCoreRow = {
      ...validAggregate,
      legs: [],
      gate: { ...validGate, rows: [{ ...coreRows[0], status: "missing" }] },
    };
    const backendLegWithFailingCoreRow = {
      ...validAggregate,
      gate: { ...validGate, rows: [{ ...coreRows[0], status: "fail" }] },
    };
    const skippedCoreRow = { ...validAggregate, gate: { ...validGate, rows: [{ ...coreRows[0], status: "skipped" }] } };
    const errorCoreRow = { ...validAggregate, gate: { ...validGate, rows: [{ ...coreRows[0], status: "error" }] } };
    const quarantinedCoreRow = { ...validAggregate, gate: { ...validGate, rows: [{ ...coreRows[0], quarantined: true }] } };
    const mismatchedLegInputs = {
      ...validAggregate,
      legs: [{ ...coreLegs[0], inputsSha256: "b".repeat(64) }, coreLegs[1]],
    };
    const cancelled = { ...validAggregate, legCoreConclusion: "cancelled" as const };
    const skipped = { ...validAggregate, legCoreConclusion: "skipped" as const };
    const coreSuccessWithoutReasonButFalse = { ...validAggregate, gate: { ...validGate, passed: false } };
    const failedCore = { ...validAggregate, legCoreConclusion: "failure" as const, gate: { ...validGate, passed: false, reasons: [{ code: "LEG_JOB_FAILED", detail: "core job failed" }] } };
    expect(AggregateReportSchema.safeParse(noLegReports).success).toBe(false);
    expect(AggregateReportSchema.safeParse(missingCoreRow).success).toBe(false);
    expect(AggregateReportSchema.safeParse(backendLegWithFailingCoreRow).success).toBe(false);
    expect(AggregateReportSchema.safeParse(skippedCoreRow).success).toBe(false);
    expect(AggregateReportSchema.safeParse(errorCoreRow).success).toBe(false);
    expect(AggregateReportSchema.safeParse(quarantinedCoreRow).success).toBe(false);
    expect(AggregateReportSchema.safeParse(mismatchedLegInputs).success).toBe(false);
    expect(AggregateReportSchema.safeParse(cancelled).success).toBe(false);
    expect(AggregateReportSchema.safeParse(skipped).success).toBe(false);
    expect(AggregateReportSchema.safeParse(coreSuccessWithoutReasonButFalse).success).toBe(false);
    expect(AggregateReportSchema.safeParse(failedCore).success).toBe(true);
    expect(validAggregate.gate.passed).toBe(true);
    expect(validAggregate.companion[0].passed).toBe(false);
  });

  test("CLI runs S3a list/run wiring and preserves S1/S3b command ownership", async () => {
    const owners = { manifest: "S3b", resolve: "S3b", aggregate: "S3b", "verify-aggregate": "S3b" };
    for (const [command, slice] of Object.entries(owners) as [Command, string][]) {
      expect(parseArgs([command]).command).toBe(command);
      await expect(runCommand([command])).rejects.toThrow(`${command} is owned by ${slice}`);
    }
    await expect(runCommand(["run"])).rejects.toThrow("run requires the topology runner to be configured");
    await expect(runCommand(["list"])).resolves.toBeUndefined();
    expect(parseArgs(["doctor"]).command).toBe("doctor");
    expect(parseArgs(["gc", "--older-than", "2h"])).toEqual({ command: "gc", positionals: [], options: { "older-than": "2h" } });
    expect(parseArgs(["verify-aggregate", "aggregate.json", "--gate", "tc858-phase1-beta", "--print", "cli.version"]))
      .toEqual({ command: "verify-aggregate", positionals: ["aggregate.json"], options: { gate: "tc858-phase1-beta", print: "cli.version" } });
  });

  test("CLI list executes successfully", () => {
    const result = Bun.spawnSync(["bun", "bin/harness.ts", "list"], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
});
