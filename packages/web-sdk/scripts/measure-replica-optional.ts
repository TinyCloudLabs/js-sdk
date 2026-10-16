import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type Format = "replica.mjs" | "replica.cjs";
type ActivationFormat = "activation.mjs" | "activation.cjs";
export type LoadedSizes = Record<Format | ActivationFormat, number>;
type Output = { entryPoint?: string | null; imports: { path: string; kind: string }[] };
type Metadata = { inputs: Record<string, unknown>; outputs: Record<string, Output> };

/** Each bucket counts emitted assets once in the same browser graph with the web
 * root external. Import cost includes the external parser and @noble dependencies;
 * activation adds the deferred IDB factory and its new static dependencies.
 * The separately delivered worker is measured and owned by @tinycloud/replica.
 */
export async function measureReplicaOptionalLoaded(dist: string): Promise<LoadedSizes> {
  const sizes: LoadedSizes = {
    "replica.mjs": 0, "replica.cjs": 0, "activation.mjs": 0, "activation.cjs": 0,
  };
  const formats: Format[] = ["replica.mjs", "replica.cjs"];
  const temp = await mkdtemp(join(tmpdir(), "tc-replica-optional-"));
  try {
    for (const format of formats) {
      const entry = resolve(dist, format);
      if (!existsSync(entry)) continue;
      const outputDir = join(temp, format);
      const metadataPath = join(temp, `${format}.json`);
      execFileSync("bun", ["build", entry, "--target=browser", `--outdir=${outputDir}`,
        "--external=@tinycloud/web-sdk", "--splitting", `--metafile=${metadataPath}`], {
        cwd: resolve(import.meta.dir, "../../.."), stdio: "pipe",
      });
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Metadata;
      if (Object.keys(metadata.inputs).some((input) => /(?:^|\/)web-sdk\/dist\/index\.(?:mjs|cjs)$/.test(input))) {
        throw new Error(`${format}: browser graph bundled a second web root`);
      }
      const initial = Object.entries(metadata.outputs).find(([, value]) =>
        value.entryPoint && basename(value.entryPoint) === format)?.[0];
      if (!initial) throw new Error(`${format}: browser graph has no initial entry`);
      const visited = new Set<string>();
      const visit = (name: string): void => {
        if (visited.has(name)) return;
        const output = metadata.outputs[name];
        if (!output || !name.startsWith("./")) throw new Error(`${format}: unaccounted static import ${name}`);
        visited.add(name);
        for (const imported of output.imports) {
          if (imported.kind === "import-statement") visit(imported.path);
        }
      };
      visit(initial);
      const rootExternal = await readFile(join(outputDir, initial.slice(2)), "utf8");
      if (!rootExternal.includes('"@tinycloud/web-sdk"')) {
        throw new Error(`${format}: browser graph does not reference the shared root`);
      }
      const gzipTotal = (names: Iterable<string>) => [...names].reduce((total, name) =>
        total + execFileSync("gzip", ["-9", "-c", join(outputDir, name.slice(2))]).byteLength, 0);
      sizes[format] = gzipTotal(visited);
      const storageEntry = Object.entries(metadata.outputs).find(([, value]) =>
        value.entryPoint && basename(value.entryPoint) === "kv-storage.js")?.[0];
      if (!storageEntry || ![...visited].some((name) =>
        metadata.outputs[name].imports.some((imported) =>
          imported.kind === "dynamic-import" && imported.path === storageEntry))) {
        throw new Error(`${format}: IDB factory is not deferred from the optional entry`);
      }
      const activated = new Set(visited);
      const visitActivation = (name: string): void => {
        if (activated.has(name)) return;
        const output = metadata.outputs[name];
        if (!output || !name.startsWith("./")) throw new Error(`${format}: unaccounted activation import ${name}`);
        activated.add(name);
        for (const imported of output.imports) {
          if (imported.kind === "import-statement") visitActivation(imported.path);
        }
      };
      visitActivation(storageEntry);
      sizes[format === "replica.mjs" ? "activation.mjs" : "activation.cjs"] =
        gzipTotal([...activated].filter((name) => !visited.has(name)));
    }
    return sizes;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const sizes = await measureReplicaOptionalLoaded(resolve(import.meta.dir, "../dist"));
  for (const [format, size] of Object.entries(sizes)) console.log(`${format}: incremental loaded=${size} gzip-bytes`);
}
