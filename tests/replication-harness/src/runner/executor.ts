import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateTopology, type ClientSpec } from "../contracts/topology";
import type { KvClient, SdkClient } from "../contracts/client";
import type { Clock } from "../contracts/clock";
import type { RunEnvironment, TopologyFactory, Topology, DisposeReport } from "../contracts/lifecycle";
import type { ScenarioResult } from "../contracts/report";
import type { ScenarioRow } from "./registry";
import { createScenarioContext, ScenarioSkip, AssertionFailure, type ScenarioContextState, type ScenarioArtefactFile, writeScenarioArtefacts, normalizeArtefactName } from "./context";
import { redactBytes, redactText } from "./redact";
import { initialResult } from "./status";

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
function redactCollectedContent(bytes: Buffer, secrets: readonly string[]): Buffer {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Buffer.from(redactText(text, secrets));
  } catch {
    return Buffer.from(redactBytes(bytes, secrets));
  }
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
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
    }
    const bytes = redactCollectedContent(await readFile(target), secrets);
    await writeFile(target, bytes);
    indexed.push({ path: safeName, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return indexed;
}

type CaptureClient = {
  home?: () => string;
  artifactDirectoryPath?: () => string;
  stderrArtifactPath?: string;
  eventsArtifactPath?: string;
  profile?: () => string;
  redactionSecrets?: () => readonly string[] | Promise<readonly string[]>;
};

const MIN_SECRET_LENGTH = 16;
const PUBLIC_JWK_FIELDS = new Set(["kty", "crv", "x", "y", "kid", "alg", "use", "n", "e", "key_ops", "ext", "x5c", "x5t", "x5t#s256"]);
const PRIVATE_JWK_FIELDS = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k", "r", "t"]);

function isJwkObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).kty === "string";
}

function sensitiveValues(value: unknown, parentKey = "", values: string[] = [], inherited = false, inJwk = false): string[] {
  const key = parentKey.toLowerCase();
  const currentIsJwk = inJwk || key === "jwk" || key === "jwks" || isJwkObject(value);
  if (currentIsJwk) {
    if (typeof value === "string") {
      if ((PRIVATE_JWK_FIELDS.has(key) || key === "jwk" || key === "jwks") && value.length >= MIN_SECRET_LENGTH) values.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) sensitiveValues(item, parentKey, values, false, true);
    } else if (value !== null && typeof value === "object") {
      for (const [childKey, item] of Object.entries(value)) {
        const lowered = childKey.toLowerCase();
        if (PUBLIC_JWK_FIELDS.has(lowered)) continue;
        if (PRIVATE_JWK_FIELDS.has(lowered) || isJwkObject(item) || lowered === "jwk" || lowered === "jwks") {
          sensitiveValues(item, childKey, values, PRIVATE_JWK_FIELDS.has(lowered), true);
        }
      }
    }
    return values;
  }
  const sensitive = inherited || /(?:private|secret|token|proof|delegation|authorization|credential|session|key)/i.test(parentKey);
  if (typeof value === "string" && sensitive && value.length >= MIN_SECRET_LENGTH) values.push(value);
  else if (Array.isArray(value)) for (const item of value) sensitiveValues(item, parentKey, values, sensitive);
  else if (value !== null && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) sensitiveValues(item, childKey, values, sensitive);
  }
  return values;
}

async function collectHomeSecrets(client: CaptureClient): Promise<string[]> {
  if (!client.home) return [];
  const root = resolve(client.home());
  const candidates = new Set<string>([
    join(root, "session.json"),
    join(root, ".tc893-authority.json"),
    join(root, ".tc893-delegation.json"),
  ]);
  try {
    for (const entry of await readdir(root)) {
      if (/^\.tc893-(?:auth-|delegation|authority|grant|request).*\.json$/i.test(entry)) candidates.add(join(root, entry));
    }
  } catch { /* a missing home has no persisted secrets */ }
  if (client.profile) {
    const profile = join(root, ".tinycloud", "profiles", client.profile());
    for (const name of ["key.json", "profile.json", "session.json"]) candidates.add(join(profile, name));
  }
  const secrets: string[] = [];
  for (const path of candidates) {
    try {
      const content = await readFile(path, "utf8");
      if (content.length >= MIN_SECRET_LENGTH) secrets.push(content);
      try { secrets.push(...sensitiveValues(JSON.parse(content))); } catch { /* the raw credential file is still registered */ }
    } catch { /* optional credential files are created by the client API */ }
  }
  return secrets;
}

async function registerClientSecrets(topology: Topology, secrets: string[], collect?: (client: KvClient, spec: ClientSpec, runId: string) => Promise<readonly string[]>, runId = ""): Promise<void> {
  for (const spec of topology.spec.clients) {
    const client = topology.client(spec.id);
    const supplied = await (client as CaptureClient).redactionSecrets?.() ?? [];
    const external = collect ? await collect(client, spec, runId) : [];
    const values = [...sensitiveValues(spec), ...supplied, ...external, ...await collectHomeSecrets(client as CaptureClient)];
    secrets.push(...values.filter((value) => value.length >= MIN_SECRET_LENGTH));
  }
}

function clientCapturePaths(client: CaptureClient): { name: string; path: string }[] {
  if (client.stderrArtifactPath && client.eventsArtifactPath) return [
    { name: "stderr.log", path: client.stderrArtifactPath },
    { name: "events.jsonl", path: client.eventsArtifactPath },
  ];
  if (client.artifactDirectoryPath) {
    const root = client.artifactDirectoryPath();
    return [{ name: "stderr.log", path: join(root, "stderr.log") }, { name: "events.jsonl", path: join(root, "events.jsonl") }];
  }
  throw new Error("client does not expose its S2 capture artefact paths");
}

async function collectClientArtefacts(topology: Topology, directory: string, secrets: readonly string[]): Promise<ScenarioArtefactFile[]> {
  const files: ScenarioArtefactFile[] = [];
  for (const spec of topology.spec.clients) {
    const client = topology.client(spec.id) as CaptureClient;
    for (const capture of clientCapturePaths(client)) {
      await access(capture.path);
      const text = redactText(await readFile(capture.path, "utf8"), secrets);
      const path = normalizeArtefactName(`clients/${spec.id}/${capture.name}`, directory);
      const target = join(directory, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, { mode: 0o600 });
      const bytes = await readFile(target);
      files.push({ path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  return files;
}

export function createScenarioExecutor(options: { factory: TopologyFactory; env: RunEnvironment; clock: Clock; artefactRoot: string; clientArtifactsRoot?: string; secrets?: string[]; collectClientSecrets?: (client: KvClient, spec: ClientSpec, runId: string) => Promise<readonly string[]> }): ScenarioExecutor {
  const active = new Map<string, ActiveTopology>();
  const secrets = options.secrets ?? [];
  async function executeRow(row: ScenarioRow, signal: AbortSignal): Promise<ScenarioResult> {
    const dir = join(options.artefactRoot, artifactPath(row));
    const started = options.clock.now();
    const result = initialResult(row, artifactPath(row), "pass", "");
    const state: ScenarioContextState = { assertions: [], metrics: [], logs: [], artefacts: new Map(), secrets };
    try {
      const spec = validateTopology(row.scenario.topology(row.variant ?? "", row.backend));
      const topologyEnv = options.clientArtifactsRoot ? { ...options.env, resultsDir: join(options.clientArtifactsRoot, artifactPath(row)) } : options.env;
      const topology = await options.factory.create(topologyEnv, spec, { topoId: topologyId(options.env.runId, row), backend: row.backend, signal,
        deadlineMs: row.scenario.timeoutMs });
      let disposePromise: Promise<DisposeReport> | undefined;
      const dispose = (): Promise<DisposeReport> => {
        if (!disposePromise) disposePromise = topology.dispose({ deadlineMs: options.env.teardownMs });
        return disposePromise;
      };
      active.set(row.key, { topology, state, dir, started, dispose });
      try {
        for (const clientSpec of topology.spec.clients) {
          const client = topology.client(clientSpec.id);
          if (client.kind === "sdk") await (client as SdkClient).rpc("hello", {});
        }
      } finally {
        await registerClientSecrets(topology, secrets, options.collectClientSecrets, options.env.runId);
      }
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
    let collectorFiles: readonly ScenarioArtefactFile[] = [];
    try {
      await mkdir(lifecycle.dir, { recursive: true });
      const index = await lifecycle.topology.collectArtefacts(lifecycle.dir, { deadlineMs: 30_000 });
      collectorFiles = index.files;
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
    }
    try {
      await registerClientSecrets(lifecycle.topology, secrets, options.collectClientSecrets, options.env.runId);
      const collectedFiles = await indexCollectedArtefacts(collectorFiles, lifecycle.dir, secrets);
      const clientFiles = await collectClientArtefacts(lifecycle.topology, lifecycle.dir, secrets);
      const scenarioFiles = await writeScenarioArtefacts(lifecycle.state, lifecycle.dir, secrets);
      const files = new Map(collectedFiles.map((file) => [file.path, file]));
      for (const file of clientFiles) files.set(file.path, file);
      for (const file of scenarioFiles) files.set(file.path, file);
      result.artefacts = [...files.values()];
    } catch (error) {
      result.status = "error";
      result.reason = `ARTEFACT_FAILED: ${error instanceof Error ? error.message : String(error)}`;
    } finally { active.delete(row.key); }
  }
  return { executeRow, finalizeRow };
}

