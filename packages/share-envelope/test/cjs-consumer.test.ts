import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A CommonJS consumer loads the built package by its export names, in Node's own resolver. The dependencies the CJS
// files require must have a `require` export condition (multiformats' subpaths are import-only, so the CJS builds
// bundle it). Needs `bun run build` first, as the CI lane does.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const PACKAGE = "@tinycloud/share-envelope";
const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
  exports: Record<string, { require?: string }>;
};

function requireInNode(specifier: string, check: string): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.platform === "win32" ? "node.exe" : "node", [
    "-e",
    `const m = require(${JSON.stringify(specifier)}); process.stdout.write(String(${check}));`,
  ], { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("CommonJS consumer of @tinycloud/share-envelope", () => {
  const entries = Object.entries(manifest.exports).filter(([, condition]) => condition.require !== undefined);

  it("declares the entries it smoke-tests", () => {
    expect(entries.map(([subpath]) => subpath)).toEqual([".", "./links"]);
  });

  for (const [subpath] of entries) {
    const specifier = subpath === "." ? PACKAGE : `${PACKAGE}/${subpath.slice(2)}`;
    it(`require("${specifier}") loads`, () => {
      const run = requireInNode(specifier, "typeof m");
      expect({ status: run.status, stderr: run.stderr.split("\n")[0] }).toEqual({ status: 0, stderr: "" });
      expect(run.stdout).toBe("object");
    }, 40_000);
  }

  it('require("@tinycloud/share-envelope/links") exposes the link API', () => {
    const run = requireInNode(`${PACKAGE}/links`, "[typeof m.buildFullLink, typeof m.parseLink, typeof m.createLink].join()");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("function,function,function");
  }, 40_000);
});
