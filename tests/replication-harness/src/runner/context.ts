import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { HarnessError } from "../contracts/common";
import type { Clock } from "../contracts/clock";
import type { ScenarioContext } from "../contracts/scenario";
import type { RunEnvironment, Topology } from "../contracts/lifecycle";
import type { ScenarioResult } from "../contracts/report";
import type { ScenarioRow } from "./registry";
import { redactBytes, redactText, redactValue } from "./redact";

export class AssertionFailure extends Error { constructor(message: string) { super(message); this.name = "AssertionFailure"; } }
export class ScenarioSkip extends Error { constructor(readonly status: "skipped" | "unsupported", message: string) { super(message); this.name = "ScenarioSkip"; } }
export type ScenarioContextState = { assertions: ScenarioResult["assertions"]; metrics: ScenarioResult["metrics"]; logs: string[]; artefacts: Map<string, string | Uint8Array>; secrets: readonly string[] };

function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
export function createScenarioContext(row: ScenarioRow, topology: Topology, clock: Clock, signal: AbortSignal, env: RunEnvironment,
  state: ScenarioContextState): ScenarioContext {
  const variant = row.variant ?? "";
  const scenario = row.scenario;
  return {
    topo: topology, clock, signal, backend: row.backend, variant, env,
    check(name, ok, detail) {
      state.assertions.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
      if (!ok) throw new AssertionFailure(name);
    },
    eq(name, actual, expected) {
      const safeActual = redactValue(actual, state.secrets);
      const safeExpected = redactValue(expected, state.secrets);
      const actualJson = JSON.stringify(normalize(safeActual));
      const expectedJson = JSON.stringify(normalize(safeExpected));
      this.check(name, actualJson === expectedJson, { actual: normalize(safeActual), expected: normalize(safeExpected) });
    },
    deadline(client, extraMs = 0) {
      const spec = scenario.topology(variant, row.backend);
      const replication = spec.clients.find((item) => item.id === client.id)?.replication;
      if (!replication || replication.maxStalenessMs === undefined || replication.staleSyncTimeoutMs === undefined) {
        throw new HarnessError("TOPOLOGY_INVALID", `deadline bounds unset for client ${client.id}`);
      }
      return replication.maxStalenessMs + replication.staleSyncTimeoutMs + env.slackMs + extraMs;
    },
    metric(id, sample, unit) {
      if (!Number.isFinite(sample)) throw new HarnessError("TOPOLOGY_INVALID", `non-finite metric sample ${id}`);
      const metric = state.metrics.find((item) => item.id === id && item.unit === unit);
      if (metric) {
        metric.samples.push(sample); metric.n++; metric.min = Math.min(metric.min, sample); metric.max = Math.max(metric.max, sample);
        metric.p50 = percentile(metric.samples, 0.5); metric.p95 = percentile(metric.samples, 0.95);
      } else state.metrics.push({ id, unit, n: 1, p50: sample, p95: sample, min: sample, max: sample, samples: [sample] });
    },
    artefact(name, data) {
      if (name === "scenario.log") throw new HarnessError("TOPOLOGY_INVALID", "scenario.log is reserved for ctx.log");
      if (redactText(name, state.secrets) !== name) throw new HarnessError("TOPOLOGY_INVALID", "artefact filename contains a registered secret");
      if (name.startsWith("/") || name.split(/[\\/]/).includes("..")) throw new HarnessError("TOPOLOGY_INVALID", `invalid artefact name ${name}`);
      state.artefacts.set(name, data);
    },
    unsupported(reason) { throw new ScenarioSkip("unsupported", reason); },
    skip(reason) { throw new ScenarioSkip("skipped", reason); },
    async assertHealed() {
      for (const clientSpec of topology.spec.clients) {
        const statuses = await topology.client(clientSpec.id).status({ signal });
        for (const status of statuses) {
          const pending = status.pending;
          this.check(`${clientSpec.id} ${status.prefix} healed`, !pending || (pending.inFlight === 0 && pending.committed === 0 && pending.ambiguous === 0), status);
        }
      }
    },
    log(message) { state.logs.push(message); },
  };
}

export type ScenarioArtefactFile = { path: string; bytes: number; sha256: string };
export async function writeScenarioArtefacts(state: ScenarioContextState, directory: string, secrets: readonly string[] = state.secrets): Promise<ScenarioArtefactFile[]> {
  const activeSecrets = [...new Set([...state.secrets, ...secrets])];
  const files: ScenarioArtefactFile[] = [];
  for (const [name, content] of state.artefacts) {
    if (name === "scenario.log") throw new HarnessError("TOPOLOGY_INVALID", "scenario.log is reserved for ctx.log");
    if (redactText(name, activeSecrets) !== name) throw new HarnessError("TOPOLOGY_INVALID", "artefact filename contains a registered secret");
    if (name.startsWith("/") || name.split(/[\\/]/).includes("..")) throw new HarnessError("TOPOLOGY_INVALID", `invalid artefact name ${name}`);
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    const bytes = typeof content === "string" ? new TextEncoder().encode(redactText(content, activeSecrets)) : redactBytes(content, activeSecrets);
    await writeFile(path, bytes, { mode: 0o600 });
    files.push({ path: name, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (state.logs.length) {
    const bytes = new TextEncoder().encode(redactText(state.logs.join("\n"), activeSecrets));
    await writeFile(join(directory, "scenario.log"), bytes, { mode: 0o600 });
    files.push({ path: "scenario.log", bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return files;
}
