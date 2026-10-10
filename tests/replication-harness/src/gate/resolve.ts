import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Backend, GateId, SetId, Tier } from "../contracts/common";
import type { ImageResolver, SutResolver } from "../contracts/frozen";
import type { JunitPrecondition, Manifest, RunInputs, Subject } from "../contracts/gate";
import type { ResolvedImage, ResolvedSut } from "../contracts/lifecycle";
import type { ManifestRegistry } from "./manifest";
import { createManifest } from "./manifest";
import { canonicalSha256 } from "./canonical-json";
import { RunInputsSchema, ResolvedImageSchema } from "../schemas/gate";
import { exactSemver } from "./semver";

interface GithubEvent {
  pull_request?: { number: number; head: { sha: string; ref: string }; base: { sha: string; ref: string } };
  repository?: { full_name?: string };
  ref?: string;
  after?: string;
}
export interface ResolveOptions {
  event: GithubEvent;
  eventName: string;
  ref: string;
  sha: string;
  runId?: string;
  runAttempt?: number;
  runUrl?: string;
  gate: GateId | null;
  sets: SetId[];
  tiers?: Tier[];
  backends?: Backend[];
  cliVersion?: string;
  nodeSdkVersion?: string;
  mode: "workspace" | "published";
  workspaceRoot?: string;
  harnessSha: string;
  junit?: JunitPrecondition | null;
  outDir: string;
  sutResolver: SutResolver;
  imageResolver: ImageResolver;
  registry: (sut: ResolvedSut, image: ResolvedImage, selection: { tiers: Tier[]; backends: Backend[] }) => ManifestRegistry;
  exportSutArtifacts: (outDir: string, sut: ResolvedSut) => Promise<void>;
  fetchInfo?: (url: string) => Promise<{ version: string; features: string[] }>;
  now?: () => Date;
}
export interface ResolveResult { inputs: RunInputs; manifests: { core: Manifest | null; companion: Manifest[] }; matrix: { include: { name: string; backend: Backend; set: SetId | null; tiers: Tier[] }[] } }

export function subjectFromEvent(event: GithubEvent, options: Pick<ResolveOptions, "eventName" | "ref" | "sha" | "runId" | "runAttempt" | "runUrl">): Subject {
  const repo = event.repository?.full_name ?? "unknown/unknown";
  const common = { repo, ref: options.ref, sha: options.sha, ...(options.runId ? { runId: options.runId } : {}), ...(options.runAttempt ? { runAttempt: options.runAttempt } : {}), ...(options.runUrl ? { runUrl: options.runUrl } : {}) };
  if (options.eventName === "pull_request") {
    const pr = event.pull_request;
    if (!pr) throw new Error("pull_request event is missing pull_request metadata");
    return { ...common, event: "pull_request", headSha: pr.head.sha, baseSha: pr.base.sha, prNumber: pr.number, headRef: pr.head.ref };
  }
  if (options.eventName === "workflow_dispatch") return { ...common, event: "workflow_dispatch" };
  return { ...common, event: "local" };
}

export function validateJunitPrecondition(evidence: JunitPrecondition | null | undefined, subject: Subject): void {
  if (!evidence) {
    if (subject.event === "pull_request" || subject.event === "workflow_dispatch") throw new Error("workspace gate requires junit precondition evidence");
    return;
  }
  if (evidence.minimumsVersion !== 1) throw new Error(`unsupported junit minimums version ${evidence.minimumsVersion}`);
  const minimums: Record<string, number> = {
    "cli-acceptance-sqlite": 1,
    "cli-acceptance-pg16": 1,
    "cli-replica-sqlite": 1,
    "cli-replica-pg16": 1,
    "node-sdk-real-node-sqlite": 10,
    "node-sdk-real-node-pg16": 10,
  };
  for (const [name, count] of Object.entries(minimums)) {
    const suite = evidence.suites.find((candidate) => candidate.name === name);
    if (!suite || !suite.present || suite.exitCode !== 0 || suite.skipped !== 0 || suite.tests < count) throw new Error(`junit suite ${name} must exist, pass with zero skips, and contain at least ${count} tests`);
  }
  if (subject.event === "pull_request" && (!("prNumber" in evidence.association) || evidence.association.prNumber !== subject.prNumber || evidence.association.headSha !== subject.headSha || evidence.association.baseSha !== subject.baseSha)) throw new Error("junit evidence is associated with a different PR, head, or base");
  if (subject.event === "workflow_dispatch" && (!("event" in evidence.association) || evidence.association.event !== subject.event || evidence.association.ref !== subject.ref || evidence.association.sha !== subject.sha)) throw new Error("junit evidence is associated with a different dispatch");
  if (evidence.testedSha !== subject.headSha && subject.event === "pull_request") throw new Error("junit tested SHA does not match PR head");
  if (evidence.testedSha !== subject.sha && subject.event === "workflow_dispatch") throw new Error("junit tested SHA does not match dispatch SHA");
  if (subject.event === "local") throw new Error("local resolve must not include CI junit evidence");
}

async function preflight(sut: RunInputs["sut"]): Promise<RunInputs["preflight"]> {
  let hasSqliteReplicaStorage = false;
  try {
    // S2 resolves SDK entries as file URLs; preserve those URLs and convert plain paths.
    const entry = sut.nodeSdk.entry.startsWith("file:") ? sut.nodeSdk.entry : pathToFileURL(sut.nodeSdk.entry).href;
    const resolvedModule = await import(entry);
    hasSqliteReplicaStorage = typeof resolvedModule.sqliteReplicaStorage === "function";
  } catch (error) {
    return { passed: false, checks: [{ name: "sqliteReplicaStorage", ok: false, detail: String(error) }] };
  }
  return { passed: hasSqliteReplicaStorage, checks: [{ name: "sqliteReplicaStorage", ok: hasSqliteReplicaStorage, detail: hasSqliteReplicaStorage ? "exported by resolved node-sdk" : "resolved node-sdk does not export sqliteReplicaStorage" }] };
}
function validateSutResolution(sut: ResolvedSut, options: ResolveOptions): void {
  if (sut.source !== options.mode) throw new Error(`SUT resolver returned ${sut.source} for ${options.mode} mode`);
  if (options.mode === "published") {
    if (sut.cli.version !== options.cliVersion || sut.nodeSdk.version !== options.nodeSdkVersion) throw new Error("resolved package versions differ from requested exact versions");
    if (!sut.cli.integrity || !sut.nodeSdk.integrity || !sut.lockfileSha256 || !/^[a-f0-9]{64}$/.test(sut.lockfileSha256)) throw new Error("published resolution must include package integrity and a lockfile SHA-256");
    return;
  }
  if (!sut.gitSha || !sut.distSha256 || !/^[a-f0-9]{64}$/.test(sut.distSha256)) throw new Error("workspace resolution must include gitSha and the build-artefact SHA-256");
}

export async function resolveInputs(options: ResolveOptions): Promise<ResolveResult> {
  const subject = subjectFromEvent(options.event, options);
  if (options.gate === "tc858-phase1-workspace" && options.mode !== "workspace") throw new Error("workspace gate requires workspace SUT resolution");
  if (options.gate === "tc858-phase1-beta" && options.mode !== "published") throw new Error("beta gate requires published SUT resolution");
  const tiers = options.gate ? ["core"] as Tier[] : [...new Set(options.tiers?.length ? options.tiers : ["core"] as Tier[])];
  const backends = options.gate ? ["sqlite", "pg16"] as Backend[] : [...new Set(options.backends?.length ? options.backends : ["sqlite", "pg16"] as Backend[])];
  if (options.gate && options.tiers?.some((tier) => tier !== "core")) throw new Error("gate resolution only accepts tier core");
  if (options.gate && options.backends && (options.backends.length !== 2 || !options.backends.includes("sqlite") || !options.backends.includes("pg16"))) throw new Error("gate resolution requires exactly sqlite and pg16 backends");
  if (!tiers.length || !backends.length) throw new Error("resolve requires at least one tier and backend");
  if (options.mode === "published" && (!options.cliVersion || !options.nodeSdkVersion || !exactSemver(options.cliVersion) || !exactSemver(options.nodeSdkVersion))) throw new Error("published client versions must be exact SemVer values");
  if (options.gate === "tc858-phase1-workspace") validateJunitPrecondition(options.junit, subject);
  const sut = await options.sutResolver({ mode: options.mode, root: options.workspaceRoot, cliVersion: options.cliVersion, nodeSdkVersion: options.nodeSdkVersion });
  validateSutResolution(sut, options);
  const fetchInfo = options.fetchInfo ?? (async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    const payload = await response.json() as { version: string; features?: string[] };
    return { version: payload.version, features: payload.features ?? [] };
  });
  const prodUrl = "https://tee.node.tinycloud.xyz/info";
  const productionInfo = await fetchInfo(prodUrl);
  if (!exactSemver(productionInfo.version)) throw new Error("production /info returned a non-exact SemVer version");
  const imageRef = `ghcr.io/tinycloudlabs/tinycloud-node:${productionInfo.version}-dstack`;
  const resolvedTagImage = await options.imageResolver({ ref: imageRef });
  const resolvedImage = ResolvedImageSchema.parse({ ...resolvedTagImage, role: "prod" });
  if (resolvedImage.nodeVersion !== productionInfo.version) throw new Error("resolved prod image version differs from production /info");
  const preflightResult = options.gate ? await preflight(sut) : { passed: true, checks: [] };
  if (options.gate && !preflightResult.passed) throw new Error("PREFLIGHT_FAILED: resolved node-sdk lacks sqliteReplicaStorage");
  const now = (options.now ?? (() => new Date()))().toISOString();
  const base: Omit<RunInputs, "inputsSha256"> = {
    schema: "tc893.inputs/v1", gate: options.gate, sets: options.sets, tiers, backends,
    subject, harnessSha: options.harnessSha, sut, image: resolvedImage,
    production: { url: prodUrl, version: productionInfo.version, features: productionInfo.features, capturedAt: now },
    preflight: preflightResult, junitPrecondition: options.gate === "tc858-phase1-workspace" ? options.junit ?? null : null,
    resolvedAt: now,
  };
  const inputs: RunInputs = RunInputsSchema.parse({ ...base, inputsSha256: canonicalSha256(base) });
  const registry = options.registry(sut, resolvedImage, { tiers, backends });
  const coreManifest = inputs.gate ? createManifest(inputs, registry) : null;
  const companionManifests = options.sets.map((set) => createManifest(inputs, registry, set));
  const matrix: ResolveResult["matrix"] = { include: [] };
  if (coreManifest) for (const backend of backends) matrix.include.push({ name: `core-${backend}`, backend, set: null, tiers: ["core"] });
  for (const manifest of companionManifests) if (manifest.rows.length) matrix.include.push({
    name: `companion-${manifest.rows[0]!.backend}`, backend: manifest.rows[0]!.backend, set: manifest.set,
    tiers: [...new Set(manifest.rows.map((row) => row.tier))],
  });
  if (!inputs.gate) {
    const regularTiers = tiers.filter((tier) => tier !== "speed");
    for (const backend of backends) {
      if (regularTiers.length) matrix.include.push({ name: regularTiers.length === 1 ? `${regularTiers[0]}-${backend}` : `adhoc-${backend}`, backend, set: null, tiers: regularTiers });
      if (tiers.includes("speed")) matrix.include.push({ name: `speed-${backend}`, backend, set: null, tiers: ["speed"] });
    }
  }
  await mkdir(options.outDir, { recursive: true });
  await options.exportSutArtifacts(options.outDir, sut);
  await writeFile(join(options.outDir, "inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`);
  if (coreManifest) await writeFile(join(options.outDir, "manifest-core.json"), `${JSON.stringify(coreManifest, null, 2)}\n`);
  for (const manifest of companionManifests) await writeFile(join(options.outDir, `manifest-${manifest.set}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(options.outDir, "matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`);
  return { inputs, manifests: { core: coreManifest, companion: companionManifests }, matrix };
}

export async function readResolveEvent(path: string): Promise<GithubEvent> {
  return JSON.parse(await readFile(path, "utf8")) as GithubEvent;
}
