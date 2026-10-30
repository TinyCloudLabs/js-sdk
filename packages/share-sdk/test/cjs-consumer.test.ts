import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A CommonJS consumer loads every built entry by its package export name, in Node's own resolver. `share-index` requires
// `@tinycloud/share-envelope/links`, which must itself be loadable from CommonJS. Needs the share-envelope and share-sdk
// builds first, as the CI lane does.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const PACKAGE = "@tinycloud/share-sdk";
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

describe("CommonJS consumer of @tinycloud/share-sdk", () => {
  const entries = Object.entries(manifest.exports).filter(([, condition]) => condition.require !== undefined);

  it("declares the entries it smoke-tests", () => {
    expect(entries.map(([subpath]) => subpath)).toEqual([".", "./artifact", "./html-bundle", "./share-root", "./share-index", "./web-recipient"]);
  });

  for (const [subpath] of entries) {
    const specifier = subpath === "." ? PACKAGE : `${PACKAGE}/${subpath.slice(2)}`;
    it(`require("${specifier}") loads`, () => {
      const run = requireInNode(specifier, "typeof m");
      expect({ status: run.status, stderr: run.stderr.split("\n")[0] }).toEqual({ status: 0, stderr: "" });
      expect(run.stdout).toBe("object");
    }, 40_000);
  }

  it('require("@tinycloud/share-sdk/share-index") exposes the share index API', () => {
    const run = requireInNode(`${PACKAGE}/share-index`, "typeof m.AgentShareRecordStore");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("function");
  }, 40_000);
});
