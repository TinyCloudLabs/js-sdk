import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_DIR = resolve(import.meta.dir, "..");
const { bin } = JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf-8")) as { bin: Record<string, string> };

describe("program name", () => {
  // npm's sh, .cmd and PowerShell shims all run the bin's target file, not a link named after
  // the bin, so each bin needs a target whose basename is the bin name.
  test("registers only the tinycloud executable", () => {
    expect(Object.keys(bin)).toEqual(["tinycloud"]);
    for (const [name, target] of Object.entries(bin)) {
      expect(target.split("/").at(-1)).toBe(name);
      expect(resolve(PACKAGE_DIR, target)).toBe(resolve(PACKAGE_DIR, "bin/tinycloud"));
    }
  });

  test("documents the pinned tinycloud install without a TC_BIN override", () => {
    const readme = readFileSync(resolve(PACKAGE_DIR, "README.md"), "utf-8");
    expect(readme).toContain("npm install -g @tinycloud/cli@1.5.0-beta.20");
    expect(readme).toContain("tinycloud --version");
    expect(readme).not.toContain("TC_BIN");
  });

  test("an error hint names the bin the user ran", () => {
    const home = mkdtempSync(join(tmpdir(), "tc-program-name-"));
    const { TC_PROFILE: _profile, TC_HOST: _host, TC_HOME: _home, TC_PRIVATE_KEY: _key, ...ambient } = process.env;
    try {
      for (const [name, target] of Object.entries(bin)) {
        const result = spawnSync("node", [resolve(PACKAGE_DIR, target), "--json", "kv", "list"], {
          encoding: "utf-8",
          env: { ...ambient, HOME: home },
        });
        expect(JSON.parse(result.stderr)).toEqual({
          error: { code: "AUTH_REQUIRED", message: `Not authenticated. Run \`${name} auth login\` or \`${name} init\` first.` },
        });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
