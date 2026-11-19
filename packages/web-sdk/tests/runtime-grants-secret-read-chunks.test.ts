import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * node-sdk loads the signing half of runtime grants and the secret reads lazily, and web-sdk ships each as its own
 * built file. Runs against the BUILT dist (build web-sdk first): each chunk exports what node-sdk takes from it in both
 * formats, both roots load it from that chunk, and the grant's signing code is not in the roots.
 */
const dist = resolve(import.meta.dir, "../dist");

function built(file: string): string {
  const path = join(dist, file);
  if (!existsSync(path)) throw new Error(`${path} is missing: build web-sdk before running this test.`);
  return path;
}

const chunks = [
  { file: "runtime-grants", names: ["issueRuntimeGrants"] },
  { file: "secret-read", names: ["delegatedSecrets", "secretReadResult"] },
] as const;

describe.each(chunks)("the built $file chunk", ({ file, names }) => {
  it("exports what node-sdk takes from it, as ESM", async () => {
    const chunk = (await import(pathToFileURL(built(`${file}.mjs`)).href)) as Record<string, unknown>;
    for (const name of names) expect(typeof chunk[name]).toBe("function");
  });

  it("exports what node-sdk takes from it, as CommonJS", () => {
    const chunk = createRequire(import.meta.url)(built(`${file}.cjs`)) as Record<string, unknown>;
    for (const name of names) expect(typeof chunk[name]).toBe("function");
  });

  it("is where both root bundles load it from", () => {
    for (const [root, ext] of [["index.mjs", "mjs"], ["index.cjs", "cjs"]] as const) {
      const bundle = readFileSync(built(root), "utf8");
      expect(bundle).toContain(`./${file}.${ext}`);
      for (const name of names) expect(bundle).toContain(name);
    }
  });
});

it("keeps the grant's ownership and SIWE checks out of both root bundles", () => {
  for (const root of ["index.mjs", "index.cjs"]) {
    const bundle = readFileSync(built(root), "utf8");
    expect(bundle).not.toContain("can only be granted in this account's own spaces");
    expect(bundle).not.toContain("The prepared sign-in message is not in canonical form.");
  }
});
