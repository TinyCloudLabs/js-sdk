import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateTopology } from "../contracts/topology";
import type { Clock } from "../contracts/clock";
import type { RunEnvironment, TopologyFactory, ResourceRef, Topology, DisposeReport } from "../contracts/lifecycle";
import type { ScenarioResult } from "../contracts/report";
import type { ScenarioRow } from "./registry";
import { createScenarioContext, ScenarioSkip, AssertionFailure, type ScenarioContextState, type ScenarioArtefactFile, writeScenarioArtefacts, normalizeArtefactName } from "./context";
import { initialResult } from "./status";
import { redactText } from "./redact";

export type ScenarioExecutor = {
  executeRow(row: ScenarioRow, signal: AbortSignal): Promise<ScenarioResult>;
  finalizeRow(row: ScenarioRow, result: ScenarioResult): Promise<void>;
};
type ActiveTopology = { topology: Topology; state: ScenarioContextState; dir: string; started: number; dispose(): Promise<DisposeReport> };

function topologyId(runId: string, row: ScenarioRow): string {
  const raw = `${runId}-${row.id}-${row.variant ?? "default"}-${row.backend}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (raw.length <= 48) return raw;
  const suffix = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${raw.slice(0, 39)}-${suffix}`;
}
function artifactPath(row: ScenarioRow): string {
  return row.key.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
}
async function indexCollectedArtefacts(files: readonly ScenarioArtefactFile[], directory: string, secrets: readonly string[]): Promise<ScenarioArtefactFile[]> {
  const indexed: ScenarioArtefactFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const sourceName = normalizeArtefactName(file.path, directory);
    if (sourceName === "scenario.log") throw new Error("collector artefact path is reserved for scenario.log");
    const safeName = normalizeArtefactName(redactText(sourceName, secrets), directory);
    if (safeName === "scenario.log") throw new Error("collector artefact path is reserved for scenario.log");
    if (seen.has(safeName)) throw new Error(`duplicate collector artefact path ${safeName}`);
    seen.add(safeName);
    const source = join(directory, ...sourceName.split("/"));
    const target = join(directory, ...safeName.split("/"));
    if (sourceName !== safeName) {
      try { await access(target); throw new Error(`collector artefact target already exists: ${safeName}`); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
    }
    const bytes = await readFile(target);
    indexed.push({ path: safeName, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return indexed;
}

export function createScenarioExecutor(options: { factory: TopologyFactory; env: RunEnvironment; clock: Clock; artefactRoot: string; secrets?: readonly string[] }): ScenarioExecutor {
  const active = new Map<string, ActiveTopology>();
  async function executeRow(row: ScenarioRow, signal: AbortSignal): Promise<ScenarioResult> {
    const dir = join(options.artefactRoot, artifactPath(row));
    const started = options.clock.now();
    const result = initialResult(row, artifactPath(row), "pass", "");
    const state: ScenarioContextState = { assertions: [], metrics: [], logs: [], artefacts: new Map(), secrets: options.secrets ?? [] };
    try {
      const spec = validateTopology(row.scenario.topology(row.variant ?? "", row.backend));
      const topology = await options.factory.create(options.env, spec, { topoId: topologyId(options.env.runId, row), backend: row.backend, signal,
        deadlineMs: row.scenario.timeoutMs });
      let disposePromise: Promise<DisposeReport> | undefined;
      const dispose = (): Promise<DisposeReport> => {
        if (!disposePromise) disposePromise = topology.dispose({ deadlineMs: options.env.teardownMs });
        return disposePromise;
      };
      active.set(row.key, { topology, state, dir, started, dispose });
      await row.scenario.run(createScenarioContext(row, topology, options.clock, signal, options.env, state), row.variant ?? "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.status = error instanceof AssertionFailure ? "fail" : error instanceof ScenarioSkip ? error.status : "error";
      if (row.tier === "core" && (result.status === "skipped" || result.status === "unsupported")) result.status = "error";
      result.reason = row.tier === "core" && error instanceof ScenarioSkip ? "CORE_STATUS_FORBIDDEN" : message;
    }
    result.assertions = state.assertions;
    result.metrics = state.metrics;
    result.durationMs = Math.max(0, options.clock.now() - started);
    return result;
  }
  async function finalizeRow(row: ScenarioRow, result: ScenarioResult): Promise<void> {
    const lifecycle = active.get(row.key);
    if (!lifecycle) return;
    result.assertions = lifecycle.state.assertions;
    result.metrics = lifecycle.state.metrics;
    result.durationMs = Math.max(0, options.clock.now() - lifecycle.started);
    try {
      await mkdir(lifecycle.dir, { recursive: true });
      const index = await lifecycle.topology.collectArtefacts(lifecycle.dir, { deadlineMs: 30_000 });
      const secrets = options.secrets ?? [];
      const collectedFiles = await indexCollectedArtefacts(index.files, lifecycle.dir, secrets);
      const scenarioFiles = await writeScenarioArtefacts(lifecycle.state, lifecycle.dir, secrets);
      const files = new Map(collectedFiles.map((file) => [file.path, file]));
      for (const file of scenarioFiles) files.set(file.path, file);
      result.artefacts = [...files.values()];
    } catch (error) {
      result.status = "error";
      result.reason = `ARTEFACT_FAILED: ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      const teardown = await lifecycle.dispose();
      result.teardown = { leaked: teardown.leaked, errors: teardown.errors };
      if ((teardown.leaked.length || teardown.errors.length) && result.status === "pass") {
        result.status = "error";
        result.reason = "TEARDOWN_FAILED";
      }
    } catch (error) {
      result.status = "error";
      result.reason = `TEARDOWN_FAILED: ${error instanceof Error ? error.message : String(error)}`;
      result.teardown.errors.push(result.reason);
    } finally { active.delete(row.key); }
  }
  return { executeRow, finalizeRow };
}
