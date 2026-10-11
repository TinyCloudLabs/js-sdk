import { cpus, tmpdir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { realClock } from "../contracts/clock";
import type { Backend, SetId, Tier } from "../contracts/common";
import { Docker } from "../topology/docker";
import { NodeImageResolver } from "../topology/images";
import type { RunEnvironment } from "../contracts/lifecycle";
import type { RunContextView } from "../contracts/scenario";
import { createRunReportBase, runRowsWithInterrupt } from "./run";
import { createScenarioExecutor } from "./executor";
import { expandScenarios, scenarioRegistry } from "./registry";
import { assembleHarnessRuntime, loadS2RuntimeAdapters } from "./runtime";
import { defaultWorkspaceRoot } from "../clients/sut";
import { createRequirementProbe } from "./requirements";
export interface RunCommandArgs { options: Record<string, string | true>; positionals: string[] }

function option(options: RunCommandArgs["options"], name: string, fallback?: string): string | undefined {
  const value = options[name];
  if (value === true) throw new Error(`--${name} requires a value`);
  return value ?? fallback;
}
function listOption(options: RunCommandArgs["options"], name: string): string[] | undefined {
  const value = option(options, name);
  return value === undefined ? undefined : value.split(",").filter(Boolean);
}
function numberOption(options: RunCommandArgs["options"], name: string, fallback: number): number {
  const text = option(options, name);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}
function checkedList<T extends string>(name: string, values: string[] | undefined, fallback: readonly T[], allowed: readonly T[]): T[] {
  const result = values ?? [...fallback];
  const invalid = result.filter((value) => !allowed.includes(value as T));
  if (invalid.length || result.length === 0) throw new Error(`invalid --${name}: ${invalid.join(", ") || "empty value"}`);
  return result as T[];
}
function dockerCommand(): string[] {
  return process.env.DOCKER?.trim() ? process.env.DOCKER.trim().split(/\s+/) : ["sudo", "-n", "docker"];
}
function safeRunId(): string {
  return new Date().toISOString().replace(/[^0-9A-Za-z-]/g, "-");
}
async function git(root: string, ...args: string[]): Promise<string> {
  return (await Bun.$`git -C ${root} ${args}`.text()).trim();
}

export async function resolveSubjectRef(root: string, sha: string): Promise<string> {
  const branch = await git(root, "branch", "--show-current");
  if (branch) return branch;
  const symbolic = await git(root, "rev-parse", "--abbrev-ref", "HEAD");
  return symbolic && symbolic !== "HEAD" ? symbolic : sha;
}

export async function runHarnessCommand(parsed: RunCommandArgs): Promise<void> {
  if (parsed.positionals.length) throw new Error(`unexpected positional arguments: ${parsed.positionals.join(" ")}`);
  const tiers = checkedList<Tier>("tier", listOption(parsed.options, "tier"), ["core"], ["core", "edge", "speed", "tc12"]);
  const backends = checkedList<Backend>("backend", listOption(parsed.options, "backend"), ["sqlite", "pg16", "pg16-c"], ["sqlite", "pg16", "pg16-c"]);
  const only = listOption(parsed.options, "only");
  const variants = listOption(parsed.options, "variant");
  const concurrency = numberOption(parsed.options, "concurrency", 4);
  const slackMs = numberOption(parsed.options, "slack-ms", 3000);
  const teardownMs = numberOption(parsed.options, "teardown-ms", 60_000);
  const runId = option(parsed.options, "run-id", safeRunId())!;
  const resultsDir = resolve(option(parsed.options, "results", process.env.TC893_RESULTS_DIR ?? process.env.TC893_RESULTS ?? "results")!);
  const sutRoot = option(parsed.options, "sut-root", defaultWorkspaceRoot())!;
  const imageRef = option(parsed.options, "node-image", "default")!;
  const sutMode = option(parsed.options, "clients", "workspace");
  if (sutMode !== "workspace") throw new Error(`unsupported SUT mode ${sutMode}; S2 published-client installation is not wired into the local run command yet`);
  const docker = dockerCommand();
  const adapters = await loadS2RuntimeAdapters();
  const runtime = assembleHarnessRuntime(adapters);
  const sut = await adapters.resolveSut({ mode: "workspace", root: sutRoot });
  const imageResolver = new NodeImageResolver(new Docker(docker));
  const image = await imageResolver.resolve(imageRef === "default" || imageRef === "previous" || imageRef === "prod" ? imageRef : { ref: imageRef });
  const environment: RunEnvironment = { runId, resultsDir, clock: realClock, docker, sut,
    image: (ref) => {
      if (typeof ref !== "string" && "build" in ref) throw new Error("node build image references are not supported by the S4a runner");
      const requested = typeof ref === "string" ? ref : ref.ref;
      if (requested !== imageRef && requested !== "default") throw new Error(`run resolved only --node-image ${imageRef}, scenario requested ${requested}`);
      return image;
    }, slackMs, teardownMs };
  const defaults = JSON.parse(await readFile(new URL("../../defaults.json", import.meta.url), "utf8")) as { ciPin: string };
  const run: RunContextView = { tiers, backends, sut, image, ciPinImage: defaults.ciPin };
  const setOption = option(parsed.options, "set");
  if (setOption !== undefined && setOption !== "phase1-companion") throw new Error(`unknown scenario set ${setOption}`);
  const set: SetId | null = setOption === "phase1-companion" ? "phase1-companion" : null;
  const rows = expandScenarios(scenarioRegistry, { tiers, backends, only, variants, set }, run, createRequirementProbe());
  if (!rows.length) throw new Error("no scenarios selected");
  const harnessRoot = process.cwd();
  const harnessSha = await git(harnessRoot, "rev-parse", "HEAD");
  const harnessDirty = (await git(harnessRoot, "status", "--porcelain")).length > 0;
  const report = createRunReportBase({ runId, startedAt: new Date(realClock.wallNow()).toISOString(), tiers,
    set, only: only ?? null, backends, concurrency, argv: process.argv.slice(2),
    filtered: Boolean(only || variants || parsed.options.tier !== undefined || parsed.options.backend !== undefined),
    subject: { repo: process.env.GITHUB_REPOSITORY ?? "local", event: "local", ref: await resolveSubjectRef(harnessRoot, harnessSha), sha: harnessSha },
    harnessSha, harnessDirty, environment: { runnerClass: process.env.TC893_RUNNER_CLASS ?? "local", os: `${process.platform}-${process.arch}`,
      cpus: cpus().length, docker: docker.join(" "), node: process.versions.node, bun: Bun.version }, sut, image });
  const clientArtifactsRoot = await mkdtemp(join(tmpdir(), "tc893-client-captures-"));
  const secrets: string[] = [];
  const executor = createScenarioExecutor({ factory: runtime.topologyFactory, env: environment, clock: realClock,
    artefactRoot: join(resultsDir, runId), clientArtifactsRoot, secrets, collectClientSecrets: runtime.collectClientSecrets });
  try {
    const { report: result, interrupted } = await runRowsWithInterrupt({ rows, clock: realClock, concurrency,
      executeRow: executor.executeRow, finalizeRow: executor.finalizeRow, report, reportDirectory: join(resultsDir, runId), secrets });
    console.log(JSON.stringify({ runId, report: join(resultsDir, runId, "report.json"), summary: result.summary }, null, 2));
    process.exitCode = interrupted ? 130 : result.summary.fail || result.summary.error || result.summary.xpass ? 1 : 0;
  } finally {
    await rm(clientArtifactsRoot, { recursive: true, force: true });
  }
}
