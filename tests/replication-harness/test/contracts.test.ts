import { runCommand, exactSemver, parseArgs } from "../bin/harness";
import { HarnessError } from "../src/contracts/common";
import { realClock, waitFor } from "../src/contracts/clock";
import { validateTopology, type TopologySpec } from "../src/contracts/topology";
import { isDivergence, isRead, isState, isSync, isWrite } from "../src/contracts/events";
import { AggregateReportSchema } from "../src/schemas/report";
import { JunitPreconditionSchema, ManifestSchema, RunInputsSchema } from "../src/schemas/gate";
import { exactSemver, parseArgs } from "../bin/harness";

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

  test("real clock waits and waitFor returns a later probe result", async () => {
    let attempts = 0;
    const result = await waitFor(realClock, async () => ++attempts === 2 ? "ready" : undefined, { deadlineMs: 500, intervalMs: 1, describe: "readiness" });
    expect(result).toBe("ready");
    await expect(waitFor(realClock, async () => undefined, { deadlineMs: 2, intervalMs: 1, describe: "never ready" }))
      .rejects.toMatchObject({ code: "DEADLINE_EXCEEDED", message: "never ready" });
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
    { name: "cli-acceptance", present: true, exitCode: 0, skipped: 0, tests: 1 },
    { name: "node-sdk-real-node", present: true, exitCode: 0, skipped: 0, tests: 3 },
  ] },
  resolvedAt: "2026-10-10T00:00:00Z", inputsSha256: digest,
};
const coreManifest = { schema: "tc893.manifest/v1" as const, gate: "tc858-phase1-workspace" as const, set: null, harnessSha: "harness-sha", inputsSha256: digest, rows: [], manifestSha256: digest };

describe("serialized contracts", () => {
  test("inputs, manifests, and versioned junit evidence validate", () => {
    expect(RunInputsSchema.parse(inputs)).toEqual(inputs);
    expect(ManifestSchema.parse(coreManifest)).toEqual(coreManifest);
    expect(JunitPreconditionSchema.safeParse({ ...inputs.junitPrecondition, suites: [{ ...inputs.junitPrecondition.suites[0], skipped: 1 }, inputs.junitPrecondition.suites[1]] }).success).toBe(false);
    expect(JunitPreconditionSchema.safeParse({ ...inputs.junitPrecondition, testedSha: "wrong-sha" }).success).toBe(false);
  });

  test("a companion failure does not change a passing core gate", () => {
    const aggregate = {
      schema: "tc893.aggregate/v1", inputs,
      gate: { id: "tc858-phase1-workspace", manifestSha256: digest, passed: true, reasons: [], rows: [] },
      companion: [{ set: "phase1-companion", manifestSha256: digest, passed: false, reasons: [{ code: "ROW_NOT_PASS", key: "EDGE-01@sqlite", detail: "companion row failed" }], rows: [] }],
      adhoc: null, legs: [], legCoreConclusion: "success", legCompanionConclusion: "failure", producedAt: "2026-10-10T00:00:00Z",
    };
    expect(AggregateReportSchema.parse(aggregate)).toEqual(aggregate);
    expect(aggregate.gate.passed).toBe(true);
    expect(aggregate.companion[0].passed).toBe(false);
  });

  test("CLI parses every command and leaves owned bodies as explicit S0 errors", () => {
    const owners = { run: "S3a", list: "S3a", manifest: "S3b", resolve: "S3b", aggregate: "S3b", "verify-aggregate": "S3b", doctor: "S1", gc: "S1" };
    for (const [command, slice] of Object.entries(owners)) {
      expect(parseArgs([command]).command).toBe(command);
      expect(() => runCommand([command])).toThrow(`${command} is not implemented in S0 (owned by ${slice})`);
    }
  });

  test("exact version validation rejects tags and ranges", () => {
    expect(exactSemver("1.2.3")).toBe(true);
    expect(exactSemver("1.2.3-beta.4")).toBe(true);
    expect(exactSemver("beta")).toBe(false);
    expect(exactSemver("^1.2.3")).toBe(false);
    expect(parseArgs(["verify-aggregate", "aggregate.json", "--gate", "tc858-phase1-beta", "--print", "cli.version"]))
      .toEqual({ command: "verify-aggregate", positionals: ["aggregate.json"], options: { gate: "tc858-phase1-beta", print: "cli.version" } });
  });
  test("CLI executable reports its S0 ownership boundary", () => {
    const result = Bun.spawnSync(["bun", "bin/harness.ts", "list"], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("list is not implemented in S0 (owned by S3a)");
  });
});
