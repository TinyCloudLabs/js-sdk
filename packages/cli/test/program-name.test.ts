import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_DIR = resolve(import.meta.dir, "..");
const { bin } = JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf-8")) as { bin: Record<string, string> };

describe("program name", () => {
  test("registers tinycloud and its tc compatibility alias at the same entry", () => {
    expect(Object.keys(bin).sort()).toEqual(["tc", "tinycloud"]);
    expect(bin.tc).toBe("./bin/tinycloud");
    expect(bin.tinycloud).toBe(bin.tc);
  });

  test("both names retain canonical tinycloud authentication hints", () => {
    const home = mkdtempSync(join(tmpdir(), "tc-program-name-"));
    const { TC_PROFILE: _profile, TC_HOST: _host, TC_HOME: _home, TC_PRIVATE_KEY: _key, ...ambient } = process.env;
    try {
      for (const target of Object.values(bin)) {
        const result = spawnSync("node", [resolve(PACKAGE_DIR, target), "--json", "kv", "list"], {
          encoding: "utf-8",
          env: { ...ambient, HOME: home },
        });
        expect(JSON.parse(result.stderr)).toEqual({
          error: { code: "AUTH_REQUIRED", message: "Not authenticated. Run `tinycloud auth login` or `tinycloud init` first." },
        });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("help and version commands finish a cached update notice", () => {
    const home = mkdtempSync(join(tmpdir(), "tc-update-finalizer-"));
    const state = join(home, "state");
    const config = join(state, ".tinycloud");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(join(config, "update-check.json.beta"), JSON.stringify({
      checkedAt: Date.now(),
      version: "1.7.0-beta.31",
    }), { mode: 0o600 });
    const { TC_PROFILE: _profile, TC_HOST: _host, TC_HOME: _home, TC_PRIVATE_KEY: _key, ...ambient } = process.env;
    try {
      for (const args of [["--version"], ["--help"]]) {
        const result = spawnSync("node", [resolve(PACKAGE_DIR, bin.tinycloud), ...args], {
          encoding: "utf-8",
          env: { ...ambient, CI: "", TC_NO_AUTO_UPDATE: "", HOME: home, TC_HOME: state },
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("1.7.0-beta.30");
        expect(result.stderr).toContain("1.7.0-beta.31");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("packed tc preserves tinycloud version, help, JSON stdout and exit codes", () => {
    const directory = mkdtempSync(join(tmpdir(), "tinycloud-packed-alias-"));
    const { TC_PROFILE: _profile, TC_HOST: _host, TC_HOME: _home, TC_PRIVATE_KEY: _key, ...ambient } = process.env;
    try {
      const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], {
        cwd: PACKAGE_DIR, encoding: "utf-8",
      });
      expect(packed.status).toBe(0);
      const [{ filename }] = JSON.parse(packed.stdout);
      const extracted = spawnSync("tar", ["-xzf", join(directory, filename), "-C", directory]);
      expect(extracted.status).toBe(0);
      const packaged = join(directory, "package");
      const dependencies = existsSync(join(PACKAGE_DIR, "node_modules"))
        ? join(PACKAGE_DIR, "node_modules")
        : resolve(PACKAGE_DIR, "../../node_modules");
      symlinkSync(dependencies, join(packaged, "node_modules"), "dir");
      const manifest = JSON.parse(readFileSync(join(packaged, "package.json"), "utf-8"));
      expect(manifest.bin.tc).toBe(manifest.bin.tinycloud);
      expect(typeof manifest.bin.tc).toBe("string");
      // Link the packed executable exactly as npm does on POSIX.
      const binDirectory = join(directory, "node_modules", ".bin");
      mkdirSync(binDirectory, { recursive: true });
      symlinkSync(resolve(packaged, manifest.bin.tinycloud), join(binDirectory, "tinycloud"));
      symlinkSync(resolve(packaged, manifest.bin.tc), join(binDirectory, "tc"));
      for (const args of [["--version"], ["--help"], ["--json", "profile", "list"]]) {
        const canonical = spawnSync("node", [join(binDirectory, "tinycloud"), ...args], {
          encoding: "utf-8", env: { ...ambient, HOME: directory },
        });
        const alias = spawnSync("node", [join(binDirectory, "tc"), ...args], {
          encoding: "utf-8", env: { ...ambient, HOME: directory },
        });
        expect(canonical.status).toBe(0);
        expect(alias.status).toBe(canonical.status);
        expect(alias.stdout).toBe(canonical.stdout);
        const aliasLines = alias.stderr.trimEnd().split("\n");
        expect(aliasLines[0].length).toBeGreaterThan(0);
        expect(`${aliasLines.slice(1).join("\n")}${canonical.stderr.endsWith("\n") ? "\n" : ""}`).toBe(canonical.stderr);
        if (args[0] === "--json") expect(JSON.parse(alias.stdout)).toBeDefined();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
