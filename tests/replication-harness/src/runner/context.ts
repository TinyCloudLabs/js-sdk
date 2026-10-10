import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export function normalizeArtefactName(name: string, directory?: string): string {
  if (!name || name.includes("\0")) throw new HarnessError("TOPOLOGY_INVALID", `invalid artefact name ${name}`);
  const normalized = name.replaceAll("\\", "/").replaceAll(/\/+/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new HarnessError("TOPOLOGY_INVALID", `invalid artefact name ${name}`);
  const canonical = normalized.split("/").reduce<string[]>((parts, segment) => {
    if (!segment || segment === ".") return parts;
    if (segment === "..") {
      if (!parts.length) throw new HarnessError("TOPOLOGY_INVALID", `artefact path escapes its directory: ${name}`);
      parts.pop();
    } else parts.push(segment);
    return parts;
  }, []).join("/");
  if (!canonical || /^[A-Za-z]:/.test(canonical)) throw new HarnessError("TOPOLOGY_INVALID", `invalid artefact name ${name}`);
  if (directory) {
    const root = resolve(directory);
    const target = resolve(root, ...canonical.split("/"));
    const pathFromRoot = relative(root, target);
    if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new HarnessError("TOPOLOGY_INVALID", `artefact path escapes its directory: ${name}`);
    }
  }
  return canonical;
}
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
      const normalizedActual = normalize(actual);
      const normalizedExpected = normalize(expected);
      const actualJson = JSON.stringify(normalizedActual);
      const expectedJson = JSON.stringify(normalizedExpected);
      this.check(name, actualJson === expectedJson, {
        actual: redactValue(normalizedActual, state.secrets),
        expected: redactValue(normalizedExpected, state.secrets),
      });
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
      const normalized = normalizeArtefactName(name);
      if (normalized === "scenario.log") throw new HarnessError("TOPOLOGY_INVALID", "scenario.log is reserved for ctx.log");
      if (redactText(normalized, state.secrets) !== normalized) throw new HarnessError("TOPOLOGY_INVALID", "artefact filename contains a registered secret");
      state.artefacts.set(normalized, data);
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
  const names = new Set<string>();
  for (const [rawName, content] of state.artefacts) {
    const name = normalizeArtefactName(rawName, directory);
    if (name === "scenario.log") throw new HarnessError("TOPOLOGY_INVALID", "scenario.log is reserved for ctx.log");
    if (redactText(name, activeSecrets) !== name) throw new HarnessError("TOPOLOGY_INVALID", "artefact filename contains a registered secret");
    if (names.has(name)) throw new HarnessError("TOPOLOGY_INVALID", `duplicate artefact path ${name}`);
    names.add(name);
    const path = join(directory, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    const bytes = typeof content === "string" ? new TextEncoder().encode(redactText(content, activeSecrets)) : redactBytes(content, activeSecrets);
    await writeFile(path, bytes, { mode: 0o600 });
    files.push({ path: name, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (state.logs.length) {
    if (names.has("scenario.log")) throw new HarnessError("TOPOLOGY_INVALID", "scenario.log is reserved for ctx.log");
    const bytes = new TextEncoder().encode(redactText(state.logs.join("\n"), activeSecrets));
    await writeFile(join(directory, "scenario.log"), bytes, { mode: 0o600 });
    files.push({ path: "scenario.log", bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return files;
}
