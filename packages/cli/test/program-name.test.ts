import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGE_DIR = resolve(import.meta.dir, "..");
const { bin } = JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf-8")) as { bin: Record<string, string> };

describe("program name", () => {
  // npm's sh, .cmd and PowerShell shims all run the bin's target file, not a link named after
  // the bin, so each bin needs a target whose basename is the bin name.
  test("each bin's target shows that bin's name in usage", () => {
    expect(Object.keys(bin).sort()).toEqual(["tc", "tinycloud"]);
    for (const [name, target] of Object.entries(bin)) {
      const result = spawnSync("node", [resolve(PACKAGE_DIR, target), "--help"], { encoding: "utf-8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`\nUsage: ${name} [options] [command]\n`);
    }
  });
});
