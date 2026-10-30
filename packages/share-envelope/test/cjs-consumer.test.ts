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

function runInNode(script: string): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.platform === "win32" ? "node.exe" : "node", ["-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function requireInNode(specifier: string, check: string): { status: number | null; stdout: string; stderr: string } {
  return runInNode(`const m = require(${JSON.stringify(specifier)}); process.stdout.write(String(${check}));`);
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

  // `index.cjs` and `links.cjs` each bundle their own multiformats. A CID made by one is read and checked by the other
  // as a string, never as an object.
  it("a CID made by index.cjs is carried through a short link built and parsed by links.cjs and verified by index.cjs", () => {
    const run = runInNode(`
      (async () => {
        const E = require(${JSON.stringify(PACKAGE)});
        const L = require(${JSON.stringify(`${PACKAGE}/links`)});
        const origin = "https://share.tinycloud.xyz";
        const bytes = new TextEncoder().encode("cross-bundle CID");
        const cid = await E.computeCid(bytes);
        const url = L.buildShortLink({ origin, type: "share", id: "a".repeat(26), key: new Uint8Array(32).fill(7), bodyCid: cid });
        const parsed = L.parseLink(url, { trustedOrigins: [origin] });
        process.stdout.write([parsed.c === cid, await E.verifyCid(bytes, parsed.c)].join());
      })().catch((error) => { console.error(String(error && error.message || error).split("\\n")[0]); process.exit(1); });
    `);
    expect({ status: run.status, stderr: run.stderr.split("\n")[0] }).toEqual({ status: 0, stderr: "" });
    expect(run.stdout).toBe("true,true");
  }, 40_000);
});
