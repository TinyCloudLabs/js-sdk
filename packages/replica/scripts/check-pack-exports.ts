import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// TC-858: @tinycloud/replica 0.2.3 shipped without dist/browser.d.ts, so
// `@tinycloud/replica/browser` had no types. Every file an `exports` entry
// points at must be in the tarball `npm publish` would produce.

type ExportsMap = Record<string, unknown>;

function collectTargets(value: unknown, out: Set<string>): void {
  if (typeof value === "string") out.add(normalize(value));
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectTargets(v, out);
}

/** Every file target of `exports` (types/import/require/...), minus `./package.json`. */
export function exportTargets(exportsMap: ExportsMap): string[] {
  const targets = new Set<string>();
  for (const [subpath, value] of Object.entries(exportsMap)) {
    if (subpath === "./package.json") continue;
    collectTargets(value, targets);
  }
  return [...targets].sort();
}

/** Returns the `exports` targets absent from `packedPaths` (paths relative to the package root). */
export function missingExportTargets(exportsMap: ExportsMap, packedPaths: string[]): string[] {
  const packed = new Set(packedPaths.map((p) => normalize(p)));
  return exportTargets(exportsMap).filter((target) => !packed.has(target));
}

export function packedFiles(packageDir: string): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [pack] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return pack.files.map((f) => f.path);
}

export function checkPackExports(packageDir: string): { checked: number } {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { name: string; exports: ExportsMap };
  const missing = missingExportTargets(pkg.exports, packedFiles(packageDir));
  if (missing.length > 0) {
    throw new Error(
      `${pkg.name}: package.json "exports" targets missing from the npm pack file list: ${missing.join(", ")}. ` +
        `Build the package (bun run build) and check the tsup config emits them.`,
    );
  }
  return { checked: exportTargets(pkg.exports).length };
}

if (import.meta.main) {
  try {
    const { checked } = checkPackExports(join(dirname(fileURLToPath(import.meta.url)), ".."));
    console.log(`pack exports ok: ${checked} targets packed`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
