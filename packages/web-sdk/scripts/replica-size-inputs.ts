import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type EntryBuild = { entries: string[]; target: "browser" | "bun" };
type TsupEntryConfig = { entry: unknown; format?: string | string[]; sourcemap?: boolean; platform?: string };
export type MeasuredInputGraph = { bundleInputs: ReadonlySet<string>; sourceMapInputs: ReadonlySet<string> };

function projectPath(root: string, path: string): string | undefined {
  const name = relative(root, resolve(root, path));
  return name === ".." || name.startsWith(`..${sep}`) ? undefined : name.split(sep).join("/");
}

/** Build graphs are analysis-only; production webpack/tsup configs and emitted assets are untouched. */
export function collectBuildInputs(root: string, builds: readonly EntryBuild[]): Set<string> {
  const temp = mkdtempSync(join(tmpdir(), "tc-replica-inputs-"));
  const inputs = new Set<string>();
  try {
    for (const [index, build] of builds.entries()) {
      if (build.entries.length === 0 || build.entries.some((entry) => !existsSync(join(root, entry)))) {
        throw new Error(`Missing measured ${build.target} entry in ${build.entries.join(", ")}`);
      }
      const metadataPath = join(temp, `inputs-${index}.json`);
      execFileSync("bun", ["build", ...build.entries, "--packages=external", `--target=${build.target}`,
        "--root=packages", `--outdir=${join(temp, `output-${index}`)}`, `--metafile=${metadataPath}`],
      { cwd: root, stdio: "pipe" });
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { inputs?: Record<string, unknown> };
      if (!metadata.inputs || Object.keys(metadata.inputs).length === 0) throw new Error("Missing measured entry input graph");
      for (const path of Object.keys(metadata.inputs)) {
        const name = projectPath(root, path);
        if (name) inputs.add(name);
      }
    }
    return inputs;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function sourceMapsIn(dir: string): string[] {
  if (!existsSync(dir)) throw new Error(`Missing measured package build: ${dir}`);
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceMapsIn(path) : entry.name.endsWith(".js.map") || entry.name.endsWith(".cjs.map") ? [path] : [];
  });
}

/** Require usable emitted maps for every declared Node entry and both worker entries. */
export function collectNodeWorkerSourceMaps(
  root: string, nodeConfigs: readonly TsupEntryConfig[], replicaConfigs: readonly TsupEntryConfig[],
): Set<string> {
  const required = new Map<string, string>();
  const register = (map: string, source: string): void => {
    if (required.has(map)) throw new Error(`source-map coverage incomplete: duplicate ${map}`);
    required.set(map, source);
  };
  if (nodeConfigs.length === 0) throw new Error("source-map coverage incomplete: no Node entries");
  for (const config of nodeConfigs) {
    const formats = typeof config.format === "string" ? [config.format] : config.format;
    if (config.sourcemap !== true || !formats?.includes("esm") || !formats.includes("cjs")) {
      throw new Error("source-map coverage incomplete: Node formats or source maps disabled");
    }
    for (const [name, source] of namedEntries(config.entry)) {
      for (const format of formats) {
        if (format !== "esm" && format !== "cjs") throw new Error("source-map coverage incomplete: Node format");
        register(join(root, "packages/node-sdk/dist", `${name}.${format === "esm" ? "js" : "cjs"}.map`),
          join(root, "packages/node-sdk", source));
      }
    }
  }
  const workerSources = new Set(["src/worker.ts", "src/kv-storage/worker.ts"]);
  for (const config of replicaConfigs) {
    for (const [name, source] of namedEntries(config.entry)) {
      if (!workerSources.has(source)) continue;
      if (config.sourcemap !== true || config.platform !== "browser" ||
          !(typeof config.format === "string" ? [config.format] : config.format)?.includes("esm")) {
        throw new Error("source-map coverage incomplete: worker config");
      }
      register(join(root, "packages/replica/dist", `${name}.js.map`), join(root, "packages/replica", source));
      workerSources.delete(source);
    }
  }
  if (workerSources.size !== 0) throw new Error("source-map coverage incomplete: worker entry missing");
  const nodeMaps = sourceMapsIn(join(root, "packages/node-sdk/dist"));
  const workerMaps = sourceMapsIn(join(root, "packages/replica/dist"));
  const emitted = new Set([...nodeMaps, ...workerMaps]);
  const inputs = new Set<string>();
  for (const map of required.keys()) {
    if (!emitted.has(map)) throw new Error(`source-map coverage incomplete: ${map} missing`);
  }
  for (const map of emitted) {
    const metadata = JSON.parse(readFileSync(map, "utf8")) as { sourceRoot?: string; sources?: string[] };
    if (!Array.isArray(metadata.sources)) throw new Error(`source-map coverage incomplete: ${map} sources missing`);
    const mapped = metadata.sources.map((path) =>
      projectPath(root, resolve(dirname(map), metadata.sourceRoot ?? "", path))).filter((name): name is string => name !== undefined);
    if (required.has(map) && (mapped.length === 0 || !mapped.includes(projectPath(root, required.get(map)!)))) {
      throw new Error(`source-map coverage incomplete: ${map} has no entry source`);
    }
    for (const name of mapped) inputs.add(name);
  }
  return inputs;
}

function namedEntries(entry: unknown): [string, string][] {
  if (entry && typeof entry === "object" && !Array.isArray(entry) &&
      Object.entries(entry).length > 0 &&
      Object.values(entry).every((source) => typeof source === "string")) {
    return Object.entries(entry) as [string, string][];
  }
  throw new Error("source-map coverage incomplete: unnamed entry declaration");
}
function entryValues(entry: unknown): string[] {
  if (typeof entry === "string") return [entry];
  if (Array.isArray(entry) && entry.every((path) => typeof path === "string")) return entry;
  if (entry && typeof entry === "object" && Object.values(entry).every((path) => typeof path === "string")) {
    return Object.values(entry) as string[];
  }
  throw new Error("Unrecognized measured package entry configuration");
}

/** Read the actual production entry declarations; fail closed on a changed config shape. */
export async function collectMeasuredArtifactInputs(root: string): Promise<MeasuredInputGraph> {
  const require = createRequire(import.meta.url);
  const webpackConfigs = require(join(root, "packages/web-sdk/webpack.config.cjs")) as { entry: unknown }[];
  if (!Array.isArray(webpackConfigs)) throw new Error("Missing web root/optional/gated configs");
  const webEntries = webpackConfigs.flatMap((config) => entryValues(config.entry))
    .map((entry) => join("packages/web-sdk", entry));
  for (const expected of ["packages/web-sdk/src/index.ts", "packages/web-sdk/src/replica.ts", "packages/web-sdk/src/replica-gated.ts"]) {
    if (!webEntries.includes(expected)) throw new Error(`Missing measured web entry ${expected}`);
  }
  const builds: EntryBuild[] = [{ entries: [...new Set(webEntries)], target: "browser" }];
  let nodeConfigs: TsupEntryConfig[] = [];
  let replicaConfigs: TsupEntryConfig[] = [];
  for (const name of ["node-sdk", "sdk-services", "sdk-core", "replica", "bootstrap", "share-sdk", "share-envelope"]) {
    const configFile = join(root, "packages", name, "tsup.config.ts");
    const module = await import(pathToFileURL(configFile).href) as { default: unknown };
    const configs = Array.isArray(module.default) ? module.default : [module.default];
    for (const config of configs) {
      if (!config || typeof config !== "object" || !("entry" in config)) {
        throw new Error(`Missing measured ${name} tsup entries`);
      }
      const { entry, platform } = config as { entry: unknown; platform?: string };
      builds.push({ entries: entryValues(entry).map((path) => join("packages", name, path)),
        target: platform === "browser" ? "browser" : "bun" });
    }
    if (name === "node-sdk") nodeConfigs = configs as TsupEntryConfig[];
    if (name === "replica") replicaConfigs = configs as TsupEntryConfig[];
  }
  return {
    bundleInputs: collectBuildInputs(root, builds),
    sourceMapInputs: collectNodeWorkerSourceMaps(root, nodeConfigs, replicaConfigs),
  };
}
