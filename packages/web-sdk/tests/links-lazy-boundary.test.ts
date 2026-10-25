import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build, type Plugin } from "esbuild";

/*
 * The links reader (`@tinycloud/share-envelope/links`) is its own file, loaded by an `import()` when a share link is
 * first resolved or published. It must never be a static import of anything the web-sdk root bundle contains, so
 * the root does not carry its code. The check bundles the real entries with esbuild and reads the import records of
 * the output: every import of the links module must be a dynamic one, and at least one must exist.
 */
const LINKS = "@tinycloud/share-envelope/links";
const KEEP: Readonly<Record<string, true>> = {
  "@tinycloud/sdk-core": true,
  "@tinycloud/share-sdk": true,
  "@tinycloud/share-envelope": true,
};
const packages = resolve(import.meta.dir, "../..");

/** Leaves every `@tinycloud/*` package except sdk-core and the two share packages, and the links module, as external imports. */
const externals: Plugin = {
  name: "share-boundary-externals",
  setup(b) {
    b.onResolve({ filter: /^@tinycloud\// }, (args) => {
      if (args.path === LINKS) return { path: args.path, external: true };
      const name = args.path.split("/").slice(0, 2).join("/");
      return KEEP[name] === true ? undefined : { path: args.path, external: true };
    });
  },
};

async function importsOfLinks(entry: { readonly file?: string; readonly contents?: string }) {
  const result = await build({
    ...(entry.file === undefined
      ? { stdin: { contents: entry.contents ?? "", resolveDir: resolve(packages, "web-sdk"), loader: "ts" as const } }
      : { entryPoints: [entry.file] }),
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    conditions: ["browser", "import"],
    logLevel: "error",
    plugins: [externals],
    external: ["viem*", "ethers*", "siwe*"],
  });
  return Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((record) => record.path === LINKS);
}

describe("the links reader is loaded on demand", () => {
  it("is reached from the web-sdk root only by dynamic import", async () => {
    const records = await importsOfLinks({ file: resolve(packages, "web-sdk/src/index.ts") });
    expect(records.length).toBeGreaterThan(0);
    expect(records.filter((record) => record.kind !== "dynamic-import")).toEqual([]);
  });

  it("is reached from every share-sdk entry the root can reach only by dynamic import", async () => {
    for (const contents of [
      `export * from "@tinycloud/share-sdk/web-recipient";`,
      `export * from "@tinycloud/share-sdk";`,
    ]) {
      const records = await importsOfLinks({ contents });
      expect(records.length).toBeGreaterThan(0);
      expect(records.filter((record) => record.kind !== "dynamic-import")).toEqual([]);
    }
  });

  const built = resolve(packages, "web-sdk/dist/index.mjs");
  it.skipIf(!existsSync(built))("is a dynamic import of the package in the built root bundles", () => {
    for (const file of ["index.mjs", "index.cjs"]) {
      const text = readFileSync(resolve(packages, "web-sdk/dist", file), "utf8");
      expect(text).toContain(`import("${LINKS}")`);
      expect(text).not.toMatch(/from\s*["']@tinycloud\/share-envelope\/links["']/);
      expect(text).not.toMatch(/require\(["']@tinycloud\/share-envelope\/links["']\)/);
    }
  });
});
