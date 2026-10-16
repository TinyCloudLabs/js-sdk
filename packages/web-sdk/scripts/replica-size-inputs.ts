import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type EntryBuild = { entries: string[]; target: "browser" | "bun" };
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

/** Corroborate Node and worker reachability with maps emitted by the real tsup builds. */
export function collectNodeWorkerSourceMaps(root: string): Set<string> {
  const node = join(root, "packages/node-sdk/dist");
  const worker = join(root, "packages/replica/dist");
  const nodeMaps = sourceMapsIn(node);
  const workerMaps = sourceMapsIn(worker);
  if (nodeMaps.length === 0 || !workerMaps.some((map) => map.endsWith("/kv-storage.worker.js.map"))) {
    throw new Error("Missing Node SDK or replica worker build source maps");
  }
  const inputs = new Set<string>();
  for (const map of [...nodeMaps, ...workerMaps]) {
    const metadata = JSON.parse(readFileSync(map, "utf8")) as { sourceRoot?: string; sources?: string[] };
    if (!Array.isArray(metadata.sources)) throw new Error(`Missing sources in ${map}`);
    for (const path of metadata.sources) {
      const name = projectPath(root, resolve(dirname(map), metadata.sourceRoot ?? "", path));
      if (name) inputs.add(name);
    }
  }
  return inputs;
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
  }
  return {
    bundleInputs: collectBuildInputs(root, builds),
    sourceMapInputs: collectNodeWorkerSourceMaps(root),
  };
}
