import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Backend, GateId, SetId, Tier } from "../src/contracts/common";
import type { JunitPrecondition, Manifest, RunInputs, Subject } from "../src/contracts/gate";
import type { ImageResolver, SutResolver } from "../src/contracts/frozen";
import type { RunEnvironment, ResolvedImage, TopologyFactory } from "../src/contracts/lifecycle";
import type { RunReport } from "../src/contracts/report";
import type { NodeImageRef } from "../src/contracts/topology";
import { scenarioRegistry, expandScenarios, validateRegistry, type ProbeRequirement } from "../src/runner/registry";
import { createRunReportBase, runRowsWithInterrupt } from "../src/runner/run";
import { createScenarioExecutor } from "../src/runner/executor";
import { ResolvedImageSchema, RunInputsSchema } from "../src/schemas/gate";
import { aggregate, aggregateExitCode, type LegEvidence } from "../src/gate/aggregate";
import { createManifest, type ManifestRegistry } from "../src/gate/manifest";
import { resolveInputs, readResolveEvent, subjectFromEvent } from "../src/gate/resolve";
import { runGateLocally, type LocalGateHooks, type LocalGatePlan } from "../src/gate/local-run";
import { verifyAggregateFile, type VerifyOptions } from "../src/gate/verify";
import { canonicalSha256 } from "../src/gate/canonical-json";

export interface GateRuntime {
  sutResolver: SutResolver;
  imageResolver: ImageResolver;
  exportSutArtifacts(outDir: string, sut: RunInputs["sut"]): Promise<void>;
  topologyFactory: TopologyFactory;
  fetchInfo?(url: string): Promise<{ version: string; features: string[] }>;
  junitPrecondition?(subject: Subject): Promise<JunitPrecondition | null>;
  probeRequirement?: ProbeRequirement;
  createRunEnvironment(inputs: RunInputs, resultsDir: string): Promise<RunEnvironment> | RunEnvironment;
}

let runtime: GateRuntime | undefined;
let runtimeModuleLoad: Promise<void> | undefined;
export function configureGateRuntime(value: GateRuntime): void { runtime = value; }

async function loadRuntimeModule(): Promise<void> {
  if (runtime || !process.env.TC893_RUNTIME_MODULE) return;
  runtimeModuleLoad ??= (async () => {
    const modulePath = resolve(process.env.TC893_RUNTIME_MODULE!);
    const loaded = await import(pathToFileURL(modulePath).href) as { registerGateRuntime?: (configure: typeof configureGateRuntime) => void | Promise<void> };
    if (typeof loaded.registerGateRuntime !== "function") throw new Error("TC893_RUNTIME_MODULE must export registerGateRuntime(configureGateRuntime)");
    await loaded.registerGateRuntime(configureGateRuntime);
  })();
  await runtimeModuleLoad;
}
function requireRuntime(needTopology = false): GateRuntime {
  if (!runtime) throw new Error("gate commands require an injected runtime; set TC893_RUNTIME_MODULE or call configureGateRuntime()");
  if (needTopology && !runtime.topologyFactory) throw new Error("run requires an injected topology factory");
  return runtime;
}
export async function verifyAggregateCommandFile(path: string, options: VerifyOptions) {
  await loadRuntimeModule();
  const fetchProduction = runtime?.fetchInfo;
  return verifyAggregateFile(path, {
    ...options,
    ...(fetchProduction ? { fetchProduction: async () => fetchProduction("https://tee.node.tinycloud.xyz/info") } : {}),
  });
}

function option(args: Record<string, string | true>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}
function requiredOption(args: Record<string, string | true>, name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  if (value.startsWith("[")) {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) throw new Error("expected a JSON string array");
    return parsed;
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
async function jsonFile<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
function runId(inputs: RunInputs): string { return inputs.subject.runId ?? `local-${randomUUID()}`; }

async function dispatchInputs(value: string | undefined): Promise<Record<string, unknown>> {
  if (!value) return {};
  const text = value.trim().startsWith("{") ? value : await readFile(value, "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("dispatch inputs must be a JSON object or a JSON file path");
  return parsed as Record<string, unknown>;
}
function dispatchString(inputs: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) if (typeof inputs[name] === "string" && inputs[name]) return inputs[name] as string;
  return undefined;
}
function gitSha(): string {
  if (process.env.TC893_HARNESS_SHA) return process.env.TC893_HARNESS_SHA;
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
function harnessDirty(): boolean {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const scope = relative(root, process.cwd()) || ".";
  return execFileSync("git", ["status", "--porcelain", "--", scope], { cwd: root, encoding: "utf8" }).trim().length > 0;
}
function gatesFor(eventName: string, dispatch: Record<string, unknown>): GateId | null {
  if (eventName === "pull_request") return "tc858-phase1-workspace";
  const gate = dispatchString(dispatch, "gate");
  if (!gate || gate === "none") return null;
  if (gate === "tc858-phase1-workspace" || gate === "tc858-phase1-beta") return gate;
  throw new Error(`unsupported gate ${gate}`);
}
function selectedTiers(dispatch: Record<string, unknown>): Tier[] {
  const selection = dispatchString(dispatch, "tier", "tiers") ?? "core";
  return selection === "all" ? ["core", "edge", "tc12", "speed"] : parseList(selection) as Tier[];
}
function selectedBackends(dispatch: Record<string, unknown>): Backend[] {
  const selection = dispatchString(dispatch, "backends", "backend") ?? '["sqlite","pg16"]';
  return parseList(selection) as Backend[];
}
async function buildResolveOptions(args: { options: Record<string, string | true> }): Promise<Parameters<typeof resolveInputs>[0]> {
  const services = requireRuntime();
  validateRegistry(scenarioRegistry);
  const eventFile = requiredOption(args.options, "event-file");
  const dispatch = await dispatchInputs(option(args.options, "dispatch-inputs"));
  for (const [argument, input] of [["gate", "gate"], ["set", "set"], ["clients", "clients"], ["tier", "tier"], ["backend", "backends"],
    ["cli", "cli_version"], ["node-sdk", "node_sdk_version"], ["sut-root", "sut_root"]] as const) {
    const value = option(args.options, argument);
    if (value !== undefined) dispatch[input] = value;
  }
  const event = await readResolveEvent(eventFile);
  const eventName = process.env.GITHUB_EVENT_NAME ?? (event.pull_request ? "pull_request" : "workflow_dispatch");
  const gate = gatesFor(eventName, dispatch);
  const ref = process.env.GITHUB_REF ?? event.ref ?? dispatchString(dispatch, "ref") ?? "refs/heads/local";
  const sha = process.env.GITHUB_SHA ?? event.after ?? dispatchString(dispatch, "sha") ?? event.pull_request?.head.sha ?? "local";
  const runIdValue = process.env.GITHUB_RUN_ID;
  const runAttemptValue = process.env.GITHUB_RUN_ATTEMPT;
  const runUrl = process.env.GITHUB_SERVER_URL && event.repository?.full_name && runIdValue
    ? `${process.env.GITHUB_SERVER_URL}/${event.repository.full_name}/actions/runs/${runIdValue}` : undefined;
  const subject = subjectFromEvent(event, { eventName, ref, sha, ...(runIdValue ? { runId: runIdValue } : {}),
    ...(runAttemptValue ? { runAttempt: Number(runAttemptValue) } : {}), ...(runUrl ? { runUrl } : {}) });
  const junit = await services.junitPrecondition?.(subject);
  const tierArg = parseList(option(args.options, "tier"));
  const backendArg = parseList(option(args.options, "backend"));
  const tiers = dispatchString(dispatch, "tier", "tiers") ? selectedTiers(dispatch) : (tierArg.length ? tierArg as Tier[] : selectedTiers(dispatch));
  const backends = dispatchString(dispatch, "backends", "backend") ? selectedBackends(dispatch) : (backendArg.length ? backendArg as Backend[] : selectedBackends(dispatch));
  const mode = (dispatchString(dispatch, "clients") ?? (gate === "tc858-phase1-beta" ? "published" : "workspace")) as "workspace" | "published";
  if (mode !== "workspace" && mode !== "published") throw new Error("clients must be workspace or published");
  return {
    event, eventName, ref, sha,
    ...(runIdValue ? { runId: runIdValue } : {}), ...(runAttemptValue ? { runAttempt: Number(runAttemptValue) } : {}), ...(runUrl ? { runUrl } : {}),
    gate, sets: eventName === "pull_request" ? ["phase1-companion"] : parseList(dispatchString(dispatch, "set")) as SetId[],
    tiers, backends, cliVersion: dispatchString(dispatch, "cli_version", "cliVersion"), nodeSdkVersion: dispatchString(dispatch, "node_sdk_version", "nodeSdkVersion"),
    mode, workspaceRoot: dispatchString(dispatch, "sut_root", "workspaceRoot") ?? process.cwd(), harnessSha: gitSha(), junit,
    outDir: requiredOption(args.options, "out"), sutResolver: services.sutResolver, imageResolver: services.imageResolver,
    registry: (sut, image, selection) => ({ scenarios: scenarioRegistry, context: { ...selection, sut, image, ciPinImage: "ghcr.io/tinycloudlabs/tinycloud-node:d7f511f" } }),
    exportSutArtifacts: services.exportSutArtifacts, ...(services.fetchInfo ? { fetchInfo: services.fetchInfo } : {}),
  };
}

export async function resolveCommand(args: { options: Record<string, string | true> }): Promise<void> {
  await loadRuntimeModule();
  const result = await resolveInputs(await buildResolveOptions(args));
  const matrix = JSON.stringify(result.matrix);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
  process.stdout.write(`${matrix}\n`);
}

async function readInputs(path: string): Promise<RunInputs> {
  return RunInputsSchema.parse(await jsonFile<unknown>(path)) as RunInputs;
}
function contextFor(inputs: RunInputs, tiers = inputs.tiers, backends = inputs.backends): ManifestRegistry["context"] {
  return { tiers, backends, sut: inputs.sut, image: inputs.image, ciPinImage: "ghcr.io/tinycloudlabs/tinycloud-node:d7f511f" };
}
function registryFor(inputs: RunInputs, tiers = inputs.tiers, backends = inputs.backends): ManifestRegistry {
  validateRegistry(scenarioRegistry);
  return { scenarios: scenarioRegistry, context: contextFor(inputs, tiers, backends) };
}
export async function recomputeManifest(set: SetId | null, inputs: RunInputs): Promise<Manifest> {
  return createManifest(inputs, registryFor(inputs), set);
}

export async function manifestCommand(args: { options: Record<string, string | true> }): Promise<void> {
  await loadRuntimeModule();
  const inputs = await readInputs(requiredOption(args.options, "inputs"));
  const setValue = option(args.options, "set");
  if (setValue && setValue !== "phase1-companion") throw new Error(`unsupported manifest set ${setValue}`);
  const set = setValue ? setValue as SetId : null;
  const manifest = await recomputeManifest(set, inputs);
  const outDir = requiredOption(args.options, "out");
  await mkdir(outDir, { recursive: true });
  const filename = set ? `manifest-${set}.json` : "manifest-core.json";
  await writeFile(join(outDir, filename), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${join(outDir, filename)}\n`);
}

function backendValue(value: unknown): Backend {
  if (value === "sqlite" || value === "pg16" || value === "pg16-c") return value;
  throw new Error(`invalid matrix backend ${String(value)}`);
}
type ResolvedMatrixLeg = { name: string; backend: Backend; set: SetId | null; tiers: Tier[] };
function parseMatrixEntry(value: unknown, index: number): ResolvedMatrixLeg {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid matrix entry ${index}`);
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string" || !entry.name) throw new Error(`invalid matrix name at entry ${index}`);
  const set = entry.set === null ? null : entry.set === "phase1-companion" ? entry.set : (() => { throw new Error(`invalid matrix set for leg ${entry.name}`); })();
  const tiers = entry.tiers;
  if (!Array.isArray(tiers) || !tiers.length || tiers.some((tier) => !["core", "edge", "speed", "tc12"].includes(String(tier)))) throw new Error(`invalid matrix tiers for leg ${entry.name}`);
  return { name: entry.name, backend: backendValue(entry.backend), set, tiers: tiers as Tier[] };
}
async function readMatrixEntries(inputsPath: string): Promise<ResolvedMatrixLeg[]> {
  const matrix = await jsonFile<{ include?: unknown }>(join(dirname(inputsPath), "matrix.json"));
  if (!Array.isArray(matrix.include)) throw new Error("resolved matrix must include an array");
  const entries = matrix.include.map((entry, index) => parseMatrixEntry(entry, index));
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new Error("resolved matrix contains duplicate leg names");
  return entries;
}
async function readMatrixEntry(inputsPath: string, name: string): Promise<ResolvedMatrixLeg> {
  const entry = (await readMatrixEntries(inputsPath)).find((item) => item.name === name);
  if (!entry) throw new Error(`leg ${name} is not present in ${join(dirname(inputsPath), "matrix.json")}`);
  return entry;
}
async function readManifestFor(inputsPath: string, set: SetId | null): Promise<Manifest | null> {
  const filename = set ? `manifest-${set}.json` : "manifest-core.json";
  try { return await jsonFile<Manifest>(join(dirname(inputsPath), filename)); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function reportEnvironment(): RunReport["environment"] {
  return { runnerClass: process.env.RUNNER_CLASS ?? "local", os: process.platform, cpus: cpus().length,
    docker: process.env.DOCKER ?? "docker", node: process.version, bun: Bun.version };
}
function imageRefKey(ref: NodeImageRef): string { return JSON.stringify(ref); }
async function resolveScenarioImages(rows: ReturnType<typeof expandScenarios>, inputs: RunInputs, services: GateRuntime): Promise<Map<string, ResolvedImage>> {
  const refs = new Map<string, NodeImageRef>();
  for (const row of rows) for (const node of row.scenario.topology(row.variant ?? "", row.backend).nodes) {
    const ref = node.image ?? "default";
    refs.set(imageRefKey(ref), ref);
  }
  const images = new Map<string, ResolvedImage>([[imageRefKey("prod"), inputs.image]]);
  if (inputs.gate) images.set(imageRefKey("default"), inputs.image);
  for (const [key, ref] of refs) {
    if (images.has(key)) continue;
    const resolved = ResolvedImageSchema.parse({ ...await services.imageResolver(ref), role: typeof ref === "string" ? ref : "build" in ref ? "build" : "custom" }) as ResolvedImage;
    images.set(key, resolved);
  }
  return images;
}

async function runS3aLeg(entry: LocalGatePlan["matrix"][number], inputs: RunInputs, resultsDir: string, inputsPath: string, services: GateRuntime): Promise<LegEvidence> {
  await mkdir(resultsDir, { recursive: true });
  const selected = await readMatrixEntry(inputsPath, entry.name);
  const manifest = await readManifestFor(inputsPath, selected.set);
  if ((inputs.gate || selected.set !== null) && !manifest) throw new Error(`resolved manifest for ${selected.name} is missing`);
  const tiers = selected.tiers;
  const context = contextFor(inputs, tiers, [selected.backend]);
  const rows = expandScenarios(scenarioRegistry, { tiers, set: selected.set, backends: [selected.backend] }, context, services.probeRequirement);
  const images = await resolveScenarioImages(rows, inputs, services);
  const createdEnvironment = await services.createRunEnvironment(inputs, resultsDir);
  if (canonicalSha256(createdEnvironment.sut) !== canonicalSha256(inputs.sut)) throw new Error("runtime SUT does not match resolved inputs");
  const env: RunEnvironment = { ...createdEnvironment, image: (ref) => {
    const expected = images.get(imageRefKey(ref));
    if (!expected) throw new Error(`image was not pre-resolved: ${imageRefKey(ref)}`);
    const actual = createdEnvironment.image(ref);
    if (actual.digest !== expected.digest) throw new Error(`runtime image digest differs for ${imageRefKey(ref)}`);
    return actual;
  } };
  const reportId = runId(inputs);
  const manifestSha256 = manifest?.manifestSha256 ?? null;
  const reportBase = createRunReportBase({ kind: "leg", runId: reportId, startedAt: new Date().toISOString(), tiers, set: selected.set, only: null,
    backends: [selected.backend], concurrency: Number(process.env.TC893_CONCURRENCY ?? 4), argv: process.argv.slice(2), filtered: false,
    subject: inputs.subject, harnessSha: inputs.harnessSha, harnessDirty: harnessDirty(), inputsSha256: inputs.inputsSha256, manifestSha256,
    environment: reportEnvironment(), sut: inputs.sut, image: inputs.image });
  const executor = createScenarioExecutor({ factory: services.topologyFactory, env, clock: env.clock, artefactRoot: resultsDir });
  const output = await runRowsWithInterrupt({ rows, clock: env.clock, concurrency: reportBase.invocation.concurrency, report: reportBase,
    reportDirectory: resultsDir, executeRow: executor.executeRow, finalizeRow: executor.finalizeRow });
  const bytes = await readFile(join(resultsDir, "report.json"));
  return { name: entry.name, directory: resultsDir, report: output.report, reportSha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function runLegCommand(args: { options: Record<string, string | true> }): Promise<void> {
  await loadRuntimeModule();
  const services = requireRuntime(true);
  const inputsPath = requiredOption(args.options, "inputs");
  const inputs = await readInputs(inputsPath);
  const name = requiredOption(args.options, "leg");
  const resultsDir = requiredOption(args.options, "results");
  const entry = await readMatrixEntry(inputsPath, name);
  const evidence = await runS3aLeg(entry, inputs, resultsDir, inputsPath, services);
  process.stdout.write(`${JSON.stringify({ leg: evidence.name, report: join(resultsDir, "report.json"), interrupted: (evidence.report as RunReport).interrupted })}\n`);
  if (reportConclusion([evidence]) !== "success") process.exitCode = 1;
}

function reportConclusion(legs: readonly LegEvidence[]): "success" | "failure" | "cancelled" | "skipped" {
  if (!legs.length) return "failure";
  for (const leg of legs) {
    const report = leg.report as Partial<RunReport> | null;
    if (!report || typeof report !== "object") return "failure";
    if (report.interrupted || report.results?.some((row) => row.reason === "INTERRUPTED" || (row.status as string) === "cancelled")) return "cancelled";
    if (!report.results || report.results.some((row) => row.status !== "pass")) return "failure";
  }
  return "success";
}
function conclusionFlag(value: string | undefined, fallback: ReturnType<typeof reportConclusion>): "success" | "failure" | "cancelled" | "skipped" {
  if (!value) return fallback;
  if (value === "success" || value === "failure" || value === "cancelled" || value === "skipped") return value;
  throw new Error(`invalid job conclusion ${value}`);
}
function renderAggregateMarkdown(report: Awaited<ReturnType<typeof aggregate>>): string {
  const lines = ["# Replication harness aggregate", "", `Gate: ${report.gate?.passed ? "passed" : report.gate ? "failed" : "not applicable"}`, "",
    `Companion: ${report.companion.every((item) => item.passed) ? "passed" : "failed"}`, "", "## Reasons", ""];
  for (const item of report.gate?.reasons ?? []) lines.push(`- ${item.code}${item.key ? ` (${item.key})` : ""}: ${item.detail}`);
  for (const verdict of report.companion) for (const item of verdict.reasons) lines.push(`- companion ${verdict.set}: ${item.code}${item.key ? ` (${item.key})` : ""}: ${item.detail}`);
  if (lines.at(-1) === "") lines.push("- None");
  lines.push("", "## Rows", "", "| Key | Status | Quarantined |", "|---|---|---|");
  for (const row of report.gate?.rows ?? report.adhoc?.rows ?? []) lines.push(`| ${row.key} | ${row.status} | ${row.quarantined} |`);
  for (const verdict of report.companion) for (const row of verdict.rows) lines.push(`| ${row.key} (companion) | ${row.status} | ${row.quarantined} |`);
  return `${lines.join("\n")}\n`;
}
export async function aggregateCommand(args: { options: Record<string, string | true> }): Promise<void> {
  if (args.options["leg-jobs-conclusion"] !== undefined) {
    throw new Error("usage: harness aggregate --inputs <inputs.json> --legs <directory> --leg-core-conclusion <result> --leg-companion-conclusion <result> --out <directory>; --leg-jobs-conclusion was removed");
  }
  await loadRuntimeModule();
  const inputsPath = requiredOption(args.options, "inputs");
  const inputs = await readInputs(inputsPath);
  const expectedLegs = await readMatrixEntries(inputsPath);
  const legsRoot = requiredOption(args.options, "legs");
  const outDir = requiredOption(args.options, "out");
  const entries = await (await import("node:fs/promises")).readdir(legsRoot, { withFileTypes: true });
  const legs: LegEvidence[] = [];
  for (const item of entries) {
    if (!item.isDirectory()) continue;
    const directory = join(legsRoot, item.name);
    try {
      const bytes = await readFile(join(directory, "report.json"));
      let report: unknown = null;
      let parseError: string | undefined;
      try {
        report = JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
      legs.push({ name: item.name, directory, report, reportSha256: createHash("sha256").update(bytes).digest("hex"), ...(parseError ? { parseError } : {}) });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const legSet = (leg: LegEvidence): SetId | null | "companion" => {
    const report = leg.report as Partial<RunReport> | null;
    if (report?.invocation && report.invocation.set !== undefined) return report.invocation.set;
    const expected = expectedLegs.find((entry) => entry.name === leg.name);
    if (expected) return expected.set;
    return leg.name.startsWith("companion-") ? "companion" : null;
  };
  const coreManifest = inputs.gate ? await readManifestFor(inputsPath, null) : null;
  const companionManifests = new Map<SetId, Manifest>();
  for (const set of inputs.sets) {
    const manifest = await readManifestFor(inputsPath, set);
    if (manifest) companionManifests.set(set, manifest);
  }
  const recomputedCoreManifest = inputs.gate ? await recomputeManifest(null, inputs) : null;
  const recomputedCompanionManifests = new Map<SetId, Manifest>();
  for (const set of inputs.sets) recomputedCompanionManifests.set(set, await recomputeManifest(set, inputs));
  const coreLegs = legs.filter((leg) => legSet(leg) === null);
  const companionLegs = legs.filter((leg) => legSet(leg) !== null);
  const coreFromReport = expectedLegs.some((leg) => leg.set === null) ? reportConclusion(coreLegs) : "success";
  const companionFromReport = expectedLegs.some((leg) => leg.set !== null) ? reportConclusion(companionLegs) : "success";
  const coreFromFlags = conclusionFlag(option(args.options, "leg-core-conclusion"), coreFromReport);
  const companionFromFlags = conclusionFlag(option(args.options, "leg-companion-conclusion"), companionFromReport);
  const aggregateConclusion = (reported: ReturnType<typeof reportConclusion>, flagged: ReturnType<typeof conclusionFlag>) =>
    reported === "success" ? flagged : reported;
  const report = await aggregate({ inputs, coreManifest, companionManifests, recomputedCoreManifest, recomputedCompanionManifests, expectedLegs, legs,
    legCoreConclusion: aggregateConclusion(coreFromReport, coreFromFlags),
    legCompanionConclusion: aggregateConclusion(companionFromReport, companionFromFlags) });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "aggregate.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, "aggregate.md"), renderAggregateMarkdown(report));
  process.stdout.write(`${JSON.stringify({ gatePassed: report.gate?.passed ?? null, companionPassed: report.companion.every((item) => item.passed), aggregate: join(outDir, "aggregate.json") })}\n`);
  process.exitCode = aggregateExitCode(report);
}

export async function createGateHooks(parsed: { options: Record<string, string | true> }): Promise<LocalGateHooks> {
  await loadRuntimeModule();
  const services = requireRuntime(true);
  const eventFile = option(parsed.options, "event-file");
  const outDir = option(parsed.options, "results") ?? "./.tc893-results";
  return {
    resolve: async (): Promise<LocalGatePlan> => {
      const args = { options: { ...parsed.options, ...(eventFile ? { "event-file": eventFile } : {}), out: join(outDir, "inputs") } };
      if (!eventFile) {
        args.options["event-file"] = join(outDir, "local-event.json");
        await mkdir(dirname(args.options["event-file"] as string), { recursive: true });
        await writeFile(args.options["event-file"] as string, JSON.stringify({ repository: { full_name: "local/local" } }));
        process.env.GITHUB_EVENT_NAME = "local";
      }
      const options = await buildResolveOptions(args);
      const result = await resolveInputs(options);
      const coreManifest = result.manifests.core;
      if (!coreManifest) throw new Error("run --gate did not resolve a core manifest");
      const companionManifests = new Map(result.manifests.companion.map((manifest) => [manifest.set!, manifest]));
      return { inputs: result.inputs, coreManifest, companionManifests, matrix: result.matrix.include, resultsDir: join(outDir, "legs") };
    },
    runLeg: async (entry, inputs, resultsDir) => {
      const inputsPath = join(outDir, "inputs", "inputs.json");
      return runS3aLeg(entry, inputs, resultsDir, inputsPath, services);
    },
    recomputeManifest: (set, inputs) => recomputeManifest(set, inputs),
  };
}
