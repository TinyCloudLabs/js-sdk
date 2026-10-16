import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type Format = "replica.mjs" | "replica.cjs";
export type LoadedSizes = Record<Format, number>;
type Output = { entryPoint?: string | null; imports: { path: string; kind: string }[] };
type Metadata = { inputs: Record<string, unknown>; outputs: Record<string, Output> };

/** First load is the emitted optional entry plus transitive static chunks, each once.
 * Bun bundles its external replica parser and its @noble imports, but leaves the
 * already-loaded web root external. Dynamic storage/worker/profile chunks are not
 * charged until activated; those are separate activation costs, not core bytes.
 */
export async function measureReplicaOptionalLoaded(dist: string): Promise<LoadedSizes> {
  const sizes: LoadedSizes = { "replica.mjs": 0, "replica.cjs": 0 };
  const temp = await mkdtemp(join(tmpdir(), "tc-replica-optional-"));
  try {
    for (const format of Object.keys(sizes) as Format[]) {
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
      sizes[format] = [...visited].reduce((total, name) => total + execFileSync("gzip", [
        "-9", "-c", join(outputDir, name.slice(2)),
      ]).byteLength, 0);
    }
    return sizes;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const sizes = await measureReplicaOptionalLoaded(resolve(import.meta.dir, "../dist"));
  for (const [format, size] of Object.entries(sizes)) console.log(`${format}: initial loaded incremental=${size} gzip-bytes`);
}
