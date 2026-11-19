import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_DIR = resolve(import.meta.dir, "..");
const { version: installed, bin } = JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf-8")) as {
  version: string;
  bin: Record<string, string>;
};

test("--quiet hides the update notice that the same command prints without it", () => {
  const home = mkdtempSync(join(tmpdir(), "tc-update-quiet-"));
  const state = join(home, "state");
  const config = join(state, ".tinycloud");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const newer = installed.replace(/\d+$/, (build) => String(Number(build) + 1));
  const channel = /^[^-+]+-([0-9A-Za-z-]+)/.exec(installed)?.[1] ?? "latest";
  writeFileSync(join(config, `update-check.json.${channel}`), JSON.stringify({ checkedAt: Date.now(), version: newer }), { mode: 0o600 });
  const { TC_PROFILE: _profile, TC_HOST: _host, TC_HOME: _home, TC_PRIVATE_KEY: _key, ...ambient } = process.env;
  const run = (args: string[]) => spawnSync("node", [resolve(PACKAGE_DIR, bin.tinycloud), ...args], {
    encoding: "utf-8",
    env: { ...ambient, CI: "", TC_NO_AUTO_UPDATE: "", HOME: home, TC_HOME: state },
  });
  try {
    const loud = run(["--version"]);
    expect(loud.status).toBe(0);
    expect(loud.stderr).toContain(newer);

    const quiet = run(["--quiet", "--version"]);
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toContain(installed);
    expect(quiet.stderr).not.toContain(newer);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failing command's stderr stays one JSON error with no update notice appended", () => {
  const home = mkdtempSync(join(tmpdir(), "tc-update-failing-"));
  const state = join(home, "state");
  const config = join(state, ".tinycloud");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  const newer = installed.replace(/\d+$/, (build) => String(Number(build) + 1));
  const channel = /^[^-+]+-([0-9A-Za-z-]+)/.exec(installed)?.[1] ?? "latest";
  writeFileSync(join(config, `update-check.json.${channel}`), JSON.stringify({ checkedAt: Date.now(), version: newer }), { mode: 0o600 });
  const { TC_PROFILE: _profile, TC_HOST: _host, TC_HOME: _home, TC_PRIVATE_KEY: _key, ...ambient } = process.env;
  try {
    const result = spawnSync("node", [resolve(PACKAGE_DIR, bin.tinycloud), "--json", "kv", "list"], {
      encoding: "utf-8",
      env: { ...ambient, CI: "", TC_NO_AUTO_UPDATE: "", HOME: home, TC_HOME: state },
    });
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr).error.code).toBe("AUTH_REQUIRED");
    expect(result.stderr).not.toContain(newer);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
