import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import type { KvClient } from "../src/contracts/client";
import { resolveSubjectRef } from "../src/runner/run-command";

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
      const [row] = expandScenarios([scenario("TC12-02", "tc12", { timeoutMs: 60_000, requires: ["tc12:host-sync"] })],
        { tiers: ["tc12"], set: null, backends: ["sqlite"], forceUnsupported: true }, view, () => "host sync unavailable");
      let abortObserved = false;
      const running = runRowsWithInterrupt({ rows: [row!], clock: realClock, concurrency: 1, abortGraceMs: 15,
        report: reportBase(dir), reportDirectory: dir,
        executeRow: (_selectedRow, signal) => {
          signal.addEventListener("abort", () => { abortObserved = true; }, { once: true });
          return Promise.withResolvers<ScenarioResult>().promise;
        } }, target);
      await realClock.sleep(3);
      target.emit("SIGINT");
      const output = await running;
      expect(output.interrupted).toBe(true);
      expect(output.report.interrupted).toBe(true);
      expect(abortObserved).toBe(true);
      expect(output.report.results[0]?.status).toBe("error");
      expect(output.report.results[0]?.reason).toBe("INTERRUPTED");
      expect(output.report.results[0]?.status).not.toBe("xfail");
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

  test("executor redacts client assertion, log, and capture secrets while indexing capture hashes", async () => {
    const dir = await tempDir();
    const secret = "synthetic-client-private-key";
    const runId = "test-run";
    const sourceRoot = await mkdtemp(join(tmpdir(), "tc893-client-capture-fixture-"));
    const home = join(sourceRoot, "homes", "c1");
    const spec: Scenario["topology"] = () => ({ name: "capture-fixture", nodes: [{ id: "n1" }],
      clients: [{ id: "c1", kind: "cli", node: "n1", identity: "owner", auth: { posture: "owner" } }] });
    const fixtureScenario = scenario("EDGE-10", "edge", { topology: spec, run: async (ctx) => {
      ctx.log(`client log ${secret}`);
      ctx.check("key detail", false, { privateKey: secret, logLine: `client log ${secret}` });
    } });
    try {
      const profileDir = join(home, ".tinycloud", "profiles", "owner");
      await mkdir(profileDir, { recursive: true });
      await writeFile(join(profileDir, "key.json"), JSON.stringify({ privateKey: secret }));
      const factory: TopologyFactory = { create: async (env, topologySpec, options) => {
        const captureDir = join(env.resultsDir, env.runId, options.topoId, "clients", "c1");
        await mkdir(captureDir, { recursive: true });
        await writeFile(join(captureDir, "stderr.log"), `client stderr ${secret}\n`);
        await writeFile(join(captureDir, "events.jsonl"), `${JSON.stringify({ token: secret })}\n`);
        const client = { id: "c1", kind: "cli", capabilities: new Set(), home: () => home, artifactDirectoryPath: () => captureDir } as unknown as KvClient;
        return { id: options.topoId, backend: options.backend, spec: topologySpec, client: (id: string) => id === "c1" ? client : undefined,
          collectArtefacts: async (outputDir: string) => {
            const nodeLog = join(outputDir, "nodes/n1.log");
            await mkdir(dirname(nodeLog), { recursive: true });
            await writeFile(nodeLog, `node secret ${secret}\n`);
            const bytes = await readFile(nodeLog);
            return { dir: outputDir, files: [{ path: "nodes/n1.log", bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }] };
          },
          dispose: async () => ({ removed: [], leaked: [], errors: [], clients: [] }) } as unknown as Topology;
      } };
      const rows = expandScenarios([fixtureScenario], { tiers: ["edge"], set: null, backends: ["sqlite"] }, view);
      const env: RunEnvironment = { runId, resultsDir: dir, clock: realClock, docker: ["docker"], sut: view.sut,
        image: () => view.image, slackMs: 1, teardownMs: 100 };
      const secrets: string[] = [];
      const executor = createScenarioExecutor({ factory, env, clock: realClock, artefactRoot: dir, clientArtifactsRoot: sourceRoot,
        secrets, collectClientSecrets: async () => [secret] });
      const output = await runRows({ rows, clock: realClock, concurrency: 1, report: reportBase(dir), reportDirectory: dir,
        secrets, executeRow: executor.executeRow, finalizeRow: executor.finalizeRow });
      const json = await readFile(join(dir, "report.json"), "utf8");
      const markdown = await readFile(join(dir, "report.md"), "utf8");
      expect(json).not.toContain(secret);
      expect(markdown).not.toContain(secret);
      expect(json).toContain("[REDACTED]");
      expect(markdown).toContain("[REDACTED]");
      expect(RunReportSchema.safeParse(JSON.parse(json)).success).toBe(true);
      const row = output.report.results[0]!;
      const captures = row.artefacts.filter((file) => file.path.startsWith("clients/c1/"));
      expect(captures.map((file) => file.path).sort()).toEqual(["clients/c1/events.jsonl", "clients/c1/stderr.log"]);
      for (const file of captures) {
        const bytes = await readFile(join(dir, row.artefactDir, file.path));
        expect(bytes.toString("utf8")).not.toContain(secret);
        expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
      expect(await readFile(join(dir, row.artefactDir, "clients/c1/stderr.log"), "utf8")).toContain("[REDACTED]");
      const nodeLogEntry = row.artefacts.find((file) => file.path === "nodes/n1.log");
      expect(nodeLogEntry).toBeDefined();
      const nodeLog = await readFile(join(dir, row.artefactDir, "nodes/n1.log"));
      expect(nodeLog.toString("utf8")).not.toContain(secret);
      expect(nodeLog.toString("utf8")).toContain("[REDACTED]");
      expect(nodeLogEntry?.sha256).toBe(createHash("sha256").update(nodeLog).digest("hex"));
      const scenarioLog = await readFile(join(dir, row.artefactDir, "scenario.log"), "utf8");
      expect(scenarioLog).not.toContain(secret);
      expect(scenarioLog).toContain("[REDACTED]");
      expect(home.startsWith(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  test("detached HEAD report metadata falls back to the commit SHA and validates", async () => {
    const dir = await tempDir();
    try {
      await Bun.$`git -C ${dir} init -q -b main`;
      await Bun.$`git -C ${dir} config user.name harness-test`;
      await Bun.$`git -C ${dir} config user.email harness-test@example.test`;
      await writeFile(join(dir, "tracked.txt"), "fixture");
      await Bun.$`git -C ${dir} add tracked.txt`;
      await Bun.$`git -C ${dir} commit -qm fixture`;
      const sha = (await Bun.$`git -C ${dir} rev-parse HEAD`.text()).trim();
      await Bun.$`git -C ${dir} checkout -q --detach ${sha}`;
      const ref = await resolveSubjectRef(dir, sha);
      expect(ref).toBe(sha);
      const rows = expandScenarios([scenario("EDGE-11", "edge")], { tiers: ["edge"], set: null, backends: ["sqlite"] }, view);
      const base = reportBase(dir);
      const report = { ...base, subject: { ...base.subject, ref, sha } };
      await runRows({ rows, clock: realClock, concurrency: 1, report, reportDirectory: join(dir, "report"),
        executeRow: async (row) => result(row) });
      const text = await readFile(join(dir, "report", "report.json"), "utf8");
      expect(RunReportSchema.safeParse(JSON.parse(text)).success).toBe(true);
      expect(JSON.parse(text).subject.ref).toBe(sha);
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

  test("redacts serialized and binary secrets without changing equality or leaking either leg report", async () => {
    const dir = await tempDir();
    const pem = "-----BEGIN PRIVATE KEY-----\nsynthetic-pem-secret\n-----END PRIVATE KEY-----";
    const jwkD = "c2VjcmV0LWp3ay1k";
    const otherSecret = "different-registered-key";
    const secrets = [pem, jwkD, otherSecret];
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
      const pemHex = Buffer.from(pem, "utf8").toString("hex");
      const jwkDecodedHex = Buffer.from(jwkD, "base64url").toString("hex");
      const jwkTextHex = Buffer.from(jwkD, "utf8").toString("hex");
      const otherSecretHex = Buffer.from(otherSecret, "utf8").toString("hex");
      context.eq("serialized PEM", pemJson, pemJson);
      context.eq("binary JWK d", jwkBytes, new Uint8Array(jwkBytes));
      context.eq("buffer JWK d", jwkBuffer, Buffer.from(jwkBytes));
      expect(() => context.eq("different registered secrets", jwkD, otherSecret)).toThrow("different registered secrets");
      expect(state.assertions.at(-1)?.ok).toBe(false);
      expect(JSON.stringify(state.assertions)).not.toContain(pem);
      expect(JSON.stringify(state.assertions)).not.toContain(jwkD);
      expect(JSON.stringify(state.assertions)).not.toContain(otherSecret);
      expect(JSON.stringify(state.assertions)).toContain("[REDACTED]");

      expect(() => context.artefact(`${jwkD}.txt`, "secret filename")).toThrow("filename contains");
      for (const name of ["scenario.log", "./scenario.log", "nested/../scenario.log", "nested\\..\\scenario.log"]) {
        expect(() => context.artefact(name, "overwrite")).toThrow("reserved");
      }
      expect(() => context.artefact("../escaped.txt", "escape")).toThrow("escapes");
      context.artefact("./nested/../ordinary.txt", "ordinary contents");
      context.log(jwkDecodedHex.slice(0, 8));
      context.log(jwkDecodedHex.slice(8));
      const indexed = await writeScenarioArtefacts(state, dir);
      for (const file of indexed) {
        const bytes = await readFile(join(dir, file.path));
        expect(file.bytes).toBe(bytes.byteLength);
        expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      }
      const log = await readFile(join(dir, "scenario.log"), "utf8");
      expect(log).not.toContain(jwkDecodedHex);
      expect(log).not.toContain(jwkDecodedHex.toUpperCase());
      expect(log).toContain("[REDACTED]");
      const bypassState: ScenarioContextState = { ...state, artefacts: new Map([["./scenario.log", "overwrite"]]) };
      await expect(writeScenarioArtefacts(bypassState, dir)).rejects.toThrow("reserved");

      const failed = result(row!, "fail");
      failed.assertions.push({ name: "secret representations", ok: false, detail: {
        serializedPem: pemJson,
        pemHex,
        pemHexUpper: pemHex.toUpperCase(),
        pemBase64: Buffer.from(pem).toString("base64"),
        escapedPemBase64: Buffer.from(JSON.stringify(pem).slice(1, -1)).toString("base64"),
        jwkD,
        jwkDBase64: Buffer.from(jwkD).toString("base64"),
        jwkDBase64url: Buffer.from(jwkD).toString("base64url"),
        jwkTextHex,
        jwkTextHexUpper: jwkTextHex.toUpperCase(),
        otherSecretHex,
        otherSecretHexUpper: otherSecretHex.toUpperCase(),
        jwkDecodedHex,
        jwkDecodedHexUpper: jwkDecodedHex.toUpperCase(),
        jwkBytes,
        jwkBuffer,
        jwkNumbers: [...jwkBytes],
      } });
      await runRows({ rows: [row!], clock: realClock, concurrency: 1, report: reportBase(dir), reportDirectory: dir, secrets,
        executeRow: async () => failed });
      const jsonText = await readFile(join(dir, "report.json"), "utf8");
      const mdText = await readFile(join(dir, "report.md"), "utf8");
      const pemEscaped = JSON.stringify(pem).slice(1, -1);
      const secretForms = [pem, pemEscaped, pemHex, pemHex.toUpperCase(), Buffer.from(pem).toString("base64"),
        Buffer.from(pem).toString("base64url"), Buffer.from(pemEscaped).toString("base64"),
        Buffer.from(pemEscaped).toString("base64url"), jwkD, Buffer.from(jwkD).toString("base64"),
        Buffer.from(jwkD).toString("base64url"), jwkTextHex, jwkTextHex.toUpperCase(),
        jwkDecodedHex, jwkDecodedHex.toUpperCase(), otherSecret, otherSecretHex, otherSecretHex.toUpperCase()];
      for (const text of [jsonText, mdText]) for (const secret of secretForms) expect(text).not.toContain(secret);
      expect(jsonText).toContain("[REDACTED]");
      expect(mdText).toContain("[REDACTED]");
      expect(RunReportSchema.safeParse(JSON.parse(jsonText)).success).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  test("collector secret-bearing filenames are renamed and reindexed from bytes on disk", async () => {
    const dir = await tempDir();
    const secret = "collector-secret";
    const [row] = expandScenarios([scenario("EDGE-10", "edge")], { tiers: ["edge"], set: null, backends: ["sqlite"] }, view);
    const content = new TextEncoder().encode("collector payload");
    const fakeTopology = {
      id: "fake-topology",
      spec: { name: "fake", nodes: [], clients: [] },
      backend: "sqlite",
      resources: () => [],
      collectArtefacts: async (outputDir: string) => {
        await writeFile(join(outputDir, `${secret}.txt`), content);
        return { dir: outputDir, files: [{ path: `${secret}.txt`, bytes: content.byteLength, sha256: "0".repeat(64) }] };
      },
      dispose: async () => ({ removed: [], leaked: [], errors: [], clients: [] }),
    } as unknown as Topology;
    const factory: TopologyFactory = { create: async () => fakeTopology };
    const env: RunEnvironment = { runId: "test-run", resultsDir: dir, clock: realClock, docker: ["docker"], sut: view.sut,
      image: () => view.image, slackMs: 1, teardownMs: 100 };
    try {
      const executor = createScenarioExecutor({ factory, env, clock: realClock, artefactRoot: dir, secrets: [secret] });
      const result = await executor.executeRow(row!, new AbortController().signal);
      await executor.finalizeRow(row!, result);
      expect(result.status).toBe("pass");
      expect(result.artefacts).toHaveLength(1);
      expect(result.artefacts[0]?.path).toBe("[REDACTED].txt");
      const target = join(dir, result.artefactDir, "[REDACTED].txt");
      const bytes = await readFile(target);
      expect([...bytes]).toEqual([...content]);
      expect(result.artefacts[0]?.bytes).toBe(bytes.byteLength);
      expect(result.artefacts[0]?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      await expect(readFile(join(dir, result.artefactDir, `${secret}.txt`))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
