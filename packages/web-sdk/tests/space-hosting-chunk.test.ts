import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * node-sdk loads its hosting module lazily, and web-sdk ships that module as its own built file.
 * Runs against the BUILT dist (build web-sdk first): every name node-sdk takes from the module must be exported
 * by the built chunk in both formats, and both root bundles must load it from that chunk. Otherwise the
 * browser build fails at run time while every source-level suite stays green.
 */
const nodeSource = resolve(import.meta.dir, "../../node-sdk/src");
const dist = resolve(import.meta.dir, "../dist");

const SPECIFIER = /space-hosting\.js["']/g;
const DESTRUCTURED = /const\s*\{\s*([^}]+?)\s*\}\s*=\s*await\s+import\(\s*["']\.{1,2}\/space-hosting\.js["']\s*\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Every name a node-sdk source file destructures from its lazy `space-hosting` import. */
function lazilyImportedNames(): string[] {
  const names = new Set<string>();
  let imports = 0;
  let destructured = 0;
  for (const file of sourceFiles(nodeSource)) {
    const source = readFileSync(file, "utf8");
    imports += source.match(SPECIFIER)?.length ?? 0;
    for (const match of source.matchAll(DESTRUCTURED)) {
      destructured++;
      for (const name of match[1]!.split(",")) names.add(name.trim().split(/\s*:\s*/)[0]!);
    }
  }
  // An import written any other way would hide its names from this check.
  expect(destructured).toBeGreaterThan(0);
  expect(destructured).toBe(imports);
  return [...names];
}

function built(file: string): string {
  const path = join(dist, file);
  if (!existsSync(path)) throw new Error(`${path} is missing: build web-sdk before running this test.`);
  return path;
}

describe("the built space-hosting chunk", () => {
  const names = lazilyImportedNames();

  it("is imported by name from node-sdk in more than one place", () => {
    expect(names).toContain("askSpaceHosting");
    expect(names).toContain("createPrimarySpace");
  });

  it("exports every name node-sdk takes from it, as ESM", async () => {
    const chunk = (await import(pathToFileURL(built("space-hosting.mjs")).href)) as Record<string, unknown>;
    for (const name of names) expect(typeof chunk[name]).toBe("function");
  });

  it("exports every name node-sdk takes from it, as CommonJS", () => {
    const chunk = createRequire(import.meta.url)(built("space-hosting.cjs")) as Record<string, unknown>;
    for (const name of names) expect(typeof chunk[name]).toBe("function");
  });

  it("is where both root bundles load those names from", () => {
    for (const [root, chunk] of [["index.mjs", "./space-hosting.mjs"], ["index.cjs", "./space-hosting.cjs"]] as const) {
      const bundle = readFileSync(built(root), "utf8");
      expect(bundle).toContain(chunk);
      for (const name of names) expect(bundle).toContain(name);
    }
  });
});
