import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scenario } from "../src/contracts/scenario";
import type { ScenarioResult } from "../src/contracts/report";
import type { RunContextView } from "../src/contracts/scenario";
import { realClock } from "../src/contracts/clock";
import { RunReportSchema } from "../src/schemas/report";
import { expandScenarios, validateRegistry, type ScenarioRow } from "../src/runner/registry";
import { validateQuarantine } from "../src/runner/quarantine";
import { createScenarioContext, writeScenarioArtefacts, type ScenarioContextState } from "../src/runner/context";
import { scheduleRows } from "../src/runner/schedule";
import { runRows, runRowsWithInterrupt, createRunReportBase } from "../src/runner/run";
import { initialResult } from "../src/runner/status";
import { createScenarioExecutor } from "../src/runner/executor";
import type { RunEnvironment, Topology, TopologyFactory } from "../src/contracts/lifecycle";

const topology: Scenario["topology"] = () => ({ name: "fake", nodes: [], clients: [] });
function scenario(id: string, tier: Scenario["tier"], options: Partial<Scenario> = {}): Scenario {
  return { id, title: id, tier, timeoutMs: 1000, topology, run: async () => {}, ...options };
}
const view: RunContextView = {
  tiers: ["core", "edge", "speed", "tc12"], backends: ["sqlite", "pg16"], ciPinImage: "node:ci",
  sut: { source: "workspace", gitSha: "sut", distSha256: "a".repeat(64), cli: { version: "1.2.3", packageJson: "/cli/package.json", entry: "/cli/index.js" },
    nodeSdk: { version: "3.2.1", packageJson: "/sdk/package.json", entry: "/sdk/index.js", condition: "import" } },
  image: { role: "prod", ref: "node:1.2.3", digest: `sha256:${"b".repeat(64)}`, pinned: `node@sha256:${"b".repeat(64)}`, nodeVersion: "1.2.3", features: [] },
};
const scenarios = [scenario("CORE-00", "core", { variants: ["cli", "sdk"] }),
  scenario("EDGE-01", "edge", { sets: ["phase1-companion"], variants: ["cli", "sdk"], backends: ["sqlite"] })];
function reportBase(directory: string) {
  return createRunReportBase({ runId: "test-run", startedAt: new Date().toISOString(), tiers: ["core"], set: null, only: null,
    backends: ["sqlite"], concurrency: 2, argv: ["run"], filtered: false,
    subject: { repo: "example/repo", event: "local", ref: "main", sha: "subject-sha" }, harnessSha: "harness-sha", harnessDirty: false,
    environment: { runnerClass: "test", os: "linux", cpus: 2, docker: "fake", node: "22", bun: "1.3" }, sut: view.sut, image: view.image });
}
function result(row: ScenarioRow, status: ScenarioResult["status"] = "pass"): ScenarioResult {
  return initialResult(row, row.key.replaceAll(/[^A-Za-z0-9_.-]/g, "_"), status, "test result");
}
async function tempDir(): Promise<string> { return mkdtemp(join(tmpdir(), "tc893-runner-")); }

describe("S3a scenario expansion", () => {
  test("validates core invariants and expands variant × backend rows before filtering", () => {
    expect(() => validateRegistry([scenario("CORE-00", "core", { requires: ["workspace-sut"] })])).toThrow("core scenarios cannot");
    const rows = expandScenarios(scenarios, { tiers: ["core", "edge"], set: null, only: undefined, backends: ["sqlite", "pg16"] }, view);
    expect(rows.map((row) => row.key)).toEqual(["CORE-00[cli]@sqlite", "CORE-00[cli]@pg16", "CORE-00[sdk]@sqlite", "CORE-00[sdk]@pg16", "EDGE-01[cli]@sqlite", "EDGE-01[sdk]@sqlite"]);
    const filtered = expandScenarios(scenarios, { tiers: ["edge"], set: "phase1-companion", only: ["EDGE-01"], variants: ["sdk"], backends: ["sqlite", "pg16"] }, view);
    expect(filtered.map((row) => row.key)).toEqual(["EDGE-01[sdk]@sqlite"]);
  });
  test("requirement probes distinguish skipped, unsupported, and force-unsupported xpass", async () => {
    const tc12 = scenario("TC12-01", "tc12", { variants: ["sdk"], requires: ["tc12:host-sync"] });
    const noProbe = expandScenarios([tc12], { tiers: ["tc12"], set: null, backends: ["sqlite"] }, view);
    expect(noProbe[0]?.unavailableStatus).toBe("unsupported");
    const forcedWithoutProbe = expandScenarios([tc12], { tiers: ["tc12"], set: null, backends: ["sqlite"], forceUnsupported: true }, view);
    expect(forcedWithoutProbe[0]?.forcedUnsupported).toBe(true);
    const skipped = expandScenarios([scenario("EDGE-07", "edge", { requires: ["workspace-sut"] })],
      { tiers: ["edge"], set: null, backends: ["sqlite"] }, view, () => "workspace SUT required");
    expect(skipped[0]?.unavailableStatus).toBe("skipped");
    const unavailable = expandScenarios([tc12], { tiers: ["tc12"], set: null, backends: ["sqlite"] }, view, () => "host sync unavailable");
    expect(unavailable[0]?.unavailableStatus).toBe("unsupported");
    const forced = expandScenarios([tc12], { tiers: ["tc12"], set: null, backends: ["sqlite"], forceUnsupported: true }, view, () => "host sync unavailable");
    const dir = await tempDir();
    try {
      const output = await runRows({ rows: forced, clock: realClock, concurrency: 1, report: reportBase(dir), reportDirectory: dir,
        executeRow: async (row) => result(row) });
      expect(output.report.results[0]?.status).toBe("xpass");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("CORE-00 runs before every other row and preflight failure suppresses core execution", async () => {
    const dir = await tempDir();
    try {
      const rows = expandScenarios([scenario("CORE-00", "core"), scenario("CORE-01", "core"), scenario("EDGE-01", "edge")],
        { tiers: ["core", "edge"], set: null, backends: ["sqlite"] }, view);
      const invoked: string[] = [];
      const output = await runRows({ rows, clock: realClock, concurrency: 2, report: reportBase(dir), reportDirectory: dir,
        executeRow: async (row) => { invoked.push(row.id); return result(row, row.id === "CORE-00" ? "fail" : "pass"); } });
      expect(invoked).toEqual(["CORE-00", "EDGE-01"]);
      expect(output.report.results.find((row) => row.id === "CORE-01")?.reason).toBe("PREFLIGHT_FAILED");
      expect(output.report.results.find((row) => row.id === "CORE-01")?.status).toBe("error");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("never-settling scenario is aborted at deadline and abandoned after grace", async () => {
    const dir = await tempDir();
    try {
      const rowScenario = scenario("EDGE-02", "edge", { timeoutMs: 25 });
      const [row] = expandScenarios([rowScenario], { tiers: ["edge"], set: null, backends: ["sqlite"] }, view);
      const before = realClock.now();
      let scenarioSignal: AbortSignal | undefined;
      const output = await runRows({ rows: [row], clock: realClock, concurrency: 1, abortGraceMs: 30,
        report: reportBase(dir), reportDirectory: dir, executeRow: async (_row, signal) => {
          scenarioSignal = signal;
          return Promise.withResolvers<ScenarioResult>().promise;
        } });
      const elapsed = realClock.now() - before;
      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeLessThan(300);
      expect(output.report.results[0]?.reason).toBe("DEADLINE_EXCEEDED");
      expect(scenarioSignal?.aborted).toBe(true);
      await realClock.sleep(2); // proves no runner-owned sleeper remains to reject or hold the process open.
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("deadline abandonment disposes its fake topology before reporting", async () => {
    const dir = await tempDir();
    let disposals = 0;
    const before = realClock.now();
    try {
      const stuck = scenario("EDGE-06", "edge", { timeoutMs: 20, run: async () => Promise.withResolvers<void>().promise });
      const [row] = expandScenarios([stuck], { tiers: ["edge"], set: null, backends: ["sqlite"] }, view);
      const fakeTopology = {
        id: "fake-topology", spec: { name: "fake", nodes: [], clients: [] }, backend: "sqlite",
        resources: () => [], collectArtefacts: async (outputDir: string) => {
          await realClock.sleep(25);
          return { dir: outputDir, files: [] };
        },
        dispose: async () => { disposals++; return { removed: [], leaked: [], errors: [], clients: [] }; },
      } as unknown as Topology;
      const factory: TopologyFactory = { create: async () => fakeTopology };
      const env: RunEnvironment = { runId: "test-run", resultsDir: dir, clock: realClock, docker: ["docker"], sut: view.sut,
        image: () => view.image, slackMs: 1, teardownMs: 100 };
      const executor = createScenarioExecutor({ factory, env, clock: realClock, artefactRoot: dir });
      const output = await runRows({ rows: [row], clock: realClock, concurrency: 1, abortGraceMs: 15,
        report: reportBase(dir), reportDirectory: dir, executeRow: executor.executeRow, finalizeRow: executor.finalizeRow });
      expect(output.report.results[0]?.reason).toBe("DEADLINE_EXCEEDED");
      expect(realClock.now() - before).toBeGreaterThanOrEqual(50);
      expect(disposals).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("SIGINT aborts the active scenario and writes an interrupted leg report", async () => {
    const dir = await tempDir();
    const target = new EventEmitter();
    try {
      const [row] = expandScenarios([scenario("EDGE-08", "edge")], { tiers: ["edge"], set: null, backends: ["sqlite"] }, view);
      const running = runRowsWithInterrupt({ rows: [row], clock: realClock, concurrency: 1, report: reportBase(dir), reportDirectory: dir,
        executeRow: (selectedRow, signal) => {
          const { promise, resolve } = Promise.withResolvers<ScenarioResult>();
          signal.addEventListener("abort", () => resolve(result(selectedRow, "error")), { once: true });
          return promise;
        } }, target);
      await realClock.sleep(3);
      target.emit("SIGINT");
      const output = await running;
      expect(output.interrupted).toBe(true);
      expect(output.report.interrupted).toBe(true);
      expect(await readFile(join(dir, "report.json"), "utf8")).toContain("\"interrupted\": true");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });


  test("speed rows run alone after normal rows, and quarantine/report output preserves gate evidence while redacting secrets", async () => {
    const dir = await tempDir();
    const secret = "synthetic-secret-value";
    try {
      const selected = [scenario("EDGE-03", "edge"), scenario("SPEED-01", "speed", { speed: true }), scenario("EDGE-04", "edge")];
      const rows = expandScenarios(selected, { tiers: ["edge", "speed"], set: null, backends: ["sqlite"] }, view);
      const active: string[] = [];
      let maxActive = 0;
      const output = await runRows({ rows, clock: realClock, concurrency: 2, report: reportBase(dir), reportDirectory: dir,
        quarantine: [{ key: "EDGE-03@sqlite", ticket: "TC-900", reason: "known issue" }], secrets: [secret],
        executeRow: async (row) => {
          active.push(row.key); maxActive = Math.max(maxActive, active.length);
          await realClock.sleep(4);
          active.splice(active.indexOf(row.key), 1);
          const value = result(row);
          value.assertions.push({ name: "secret", ok: false, detail: secret });
          value.reason = secret;
          return value;
        } });
      expect(maxActive).toBe(2);
      expect(output.report.results.map((row) => row.id)).toEqual(["EDGE-03", "EDGE-04", "SPEED-01"]);
      expect(output.report.quarantined).toEqual(["EDGE-03@sqlite"]);
      expect(output.report.results.find((row) => row.id === "EDGE-03")?.status).toBe("pass");
      const jsonText = await readFile(join(dir, "report.json"), "utf8");
      const mdText = await readFile(join(dir, "report.md"), "utf8");
      expect(jsonText).not.toContain(secret);
      expect(mdText).not.toContain(secret);
      expect(jsonText).toContain("[REDACTED]");
      expect(RunReportSchema.safeParse(JSON.parse(jsonText)).success).toBe(true);
      expect(mdText).toContain("EDGE-03@sqlite");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("scheduler never overlaps speed rows with any tier", async () => {
    const rows = expandScenarios([scenario("EDGE-05", "edge"), scenario("SPEED-02", "speed", { speed: true }), scenario("SPEED-03", "speed", { speed: true })],
      { tiers: ["edge", "speed"], set: null, backends: ["sqlite"] }, view);
    const active: string[] = [];
    const max = { value: 0 };
    await scheduleRows(rows, 3, async (row) => {
      active.push(row.key); max.value = Math.max(max.value, active.length);
      if (row.scenario.speed) expect(active).toEqual([row.key]);
      await realClock.sleep(3);
      active.splice(active.indexOf(row.key), 1);
      return row.key;
    });
    expect(max.value).toBe(1);
  });
  test("quarantine accepts both directional variant keys", () => {
    expect(validateQuarantine([
      { key: "CORE-01[sdk>cli]@sqlite", ticket: "TC-893", reason: "known issue" },
      { key: "CORE-01[cli>sdk]@pg16", ticket: "TC-893", reason: "known issue" },
    ]).map((entry) => entry.key)).toEqual(["CORE-01[sdk>cli]@sqlite", "CORE-01[cli>sdk]@pg16"]);
  });

  test("redacts serialized and binary secret forms before eq and in both leg reports", async () => {
    const dir = await tempDir();
    const pem = "-----BEGIN PRIVATE KEY-----\nsynthetic-pem-secret\n-----END PRIVATE KEY-----";
    const jwkD = "c2VjcmV0LWp3ay1k";
    const secrets = [pem, jwkD];
    const [row] = expandScenarios([scenario("EDGE-09", "edge")], { tiers: ["edge"], set: null, backends: ["sqlite"] }, view);
    const fakeTopology = { spec: { clients: [] } } as unknown as Topology;
    const state: ScenarioContextState = { assertions: [], metrics: [], logs: [], artefacts: new Map(), secrets };
    const env: RunEnvironment = { runId: "test-run", resultsDir: dir, clock: realClock, docker: ["docker"], sut: view.sut,
      image: () => view.image, slackMs: 1, teardownMs: 100 };
    const context = createScenarioContext(row!, fakeTopology, realClock, new AbortController().signal, env, state);
    try {
      const pemJson = JSON.stringify({ privateKey: pem });
      const jwkBytes = new TextEncoder().encode(jwkD);
      const jwkBuffer = Buffer.from(jwkD, "utf8");
      context.eq("serialized PEM", pemJson, pemJson);
      context.eq("binary JWK d", jwkBytes, new Uint8Array(jwkBytes));
      context.eq("buffer JWK d", jwkBuffer, Buffer.from(jwkBytes));
      expect(JSON.stringify(state.assertions)).not.toContain(pem);
      expect(JSON.stringify(state.assertions)).not.toContain(jwkD);
      expect(JSON.stringify(state.assertions)).toContain("[REDACTED]");

      expect(() => context.artefact(`${jwkD}.txt`, "secret filename")).toThrow("filename contains");
      expect(() => context.artefact("scenario.log", "overwrite")).toThrow("reserved");
      context.artefact("ordinary.txt", "ordinary contents");
      context.log("runner log");
      const indexed = await writeScenarioArtefacts(state, dir);
      for (const file of indexed) {
        const bytes = await readFile(join(dir, file.path));
        expect(file.bytes).toBe(bytes.byteLength);
        expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }

      const failed = result(row!, "fail");
      failed.assertions.push({ name: "secret representations", ok: false, detail: {
        serializedPem: pemJson,
        pemBase64: Buffer.from(pem).toString("base64"),
        escapedPemBase64: Buffer.from(JSON.stringify(pem).slice(1, -1)).toString("base64"),
        escapedPemBase64url: Buffer.from(JSON.stringify(pem).slice(1, -1)).toString("base64url"),
        jwkD,
        jwkDBase64: Buffer.from(jwkD).toString("base64"),
        jwkDBase64url: Buffer.from(jwkD).toString("base64url"),
        jwkBytes,
        jwkBuffer,
        jwkNumbers: [...jwkBytes],
      } });
      await runRows({ rows: [row!], clock: realClock, concurrency: 1, report: reportBase(dir), reportDirectory: dir, secrets,
        executeRow: async () => failed });
      const jsonText = await readFile(join(dir, "report.json"), "utf8");
      const mdText = await readFile(join(dir, "report.md"), "utf8");
      const pemEscaped = JSON.stringify(pem).slice(1, -1);
      const secretForms = [pem, pemEscaped, Buffer.from(pem).toString("base64"),
        Buffer.from(pem).toString("base64url"), Buffer.from(pemEscaped).toString("base64"),
        Buffer.from(pemEscaped).toString("base64url"), jwkD, Buffer.from(jwkD).toString("base64"),
        Buffer.from(jwkD).toString("base64url")];
      for (const text of [jsonText, mdText]) for (const secret of secretForms) expect(text).not.toContain(secret);
      expect(jsonText).toContain("[REDACTED]");
      expect(mdText).toContain("[REDACTED]");
      expect(RunReportSchema.safeParse(JSON.parse(jsonText)).success).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
