import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Sign-out's node calls (TC-3443) ship as their own built file, loaded when a session starts. Runs against the BUILT
 * dist (build web-sdk first): the chunk exports what node-sdk takes from it in both formats, both roots load it from
 * that chunk, and the retire request itself is not in the roots.
 */
const dist = resolve(import.meta.dir, "../dist");

function built(file: string): string {
  const path = join(dist, file);
  if (!existsSync(path)) throw new Error(`${path} is missing: build web-sdk before running this test.`);
  return path;
}

describe("the built session-retire chunk", () => {
  it("exports retireLeavingSession, as ESM", async () => {
    const chunk = (await import(pathToFileURL(built("session-retire.mjs")).href)) as Record<string, unknown>;
    expect(typeof chunk.retireLeavingSession).toBe("function");
  });

  it("exports retireLeavingSession, as CommonJS", () => {
    const chunk = createRequire(import.meta.url)(built("session-retire.cjs")) as Record<string, unknown>;
    expect(typeof chunk.retireLeavingSession).toBe("function");
  });

  it("is where both root bundles load it from, and the retire request is not in them", () => {
    for (const [root, ext] of [["index.mjs", "mjs"], ["index.cjs", "cjs"]] as const) {
      const bundle = readFileSync(built(root), "utf8");
      expect(bundle).toContain(`./session-retire.${ext}`);
      expect(bundle).toContain("retireLeavingSession");
      expect(bundle).not.toContain("tinycloud.session/retire");
      expect(bundle).not.toContain("session_retire_invalid");
    }
  });
});
