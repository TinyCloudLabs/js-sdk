import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { recordInstallKind } from "../src/lib/install-kind.js";

// TC-4276 (Naomi's ruling): a patch or minor the background updater installs itself gets no "update available"
// notice; a major, or an install with automatic updates off, keeps it. Runs the built CLI as an npm global install.
const PACKAGE_DIR = resolve(import.meta.dir, "..");
const { version: installed } = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function npmGlobalInstall() {
  const dir = mkdtempSync(join(tmpdir(), "tc4276-notice-"));
  dirs.push(dir);
  const packageDir = join(dir, "global", "lib", "node_modules", "@tinycloud", "cli");
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  mkdirSync(join(packageDir, "dist"));
  copyFileSync(join(PACKAGE_DIR, "package.json"), join(packageDir, "package.json"));
  copyFileSync(join(PACKAGE_DIR, "bin", "tinycloud"), join(packageDir, "bin", "tinycloud"));
  for (const file of readdirSync(join(PACKAGE_DIR, "dist"))) {
    if (file.endsWith(".js")) copyFileSync(join(PACKAGE_DIR, "dist", file), join(packageDir, "dist", file));
  }
  const dependencies = existsSync(join(PACKAGE_DIR, "node_modules")) ? join(PACKAGE_DIR, "node_modules") : resolve(PACKAGE_DIR, "../../node_modules");
  symlinkSync(dependencies, join(packageDir, "node_modules"), "dir");
  symlinkSync(resolve(PACKAGE_DIR, "../../node_modules"), join(dir, "global", "node_modules"), "dir");
  // npm only has to be on PATH; nothing runs it, because the next background check isn't due.
  const fakeBin = join(dir, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "npm"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(fakeBin, "npm"), 0o755);
  const state = join(dir, "state");
  mkdirSync(join(state, ".tinycloud"), { recursive: true, mode: 0o700 });
  const versions = join(dir, "versions");
  mkdirSync(versions);
  const nextCheck = `${JSON.stringify({ at: Date.now() + 24 * 60 * 60 * 1000 })}\n`;
  writeFileSync(join(versions, "next-check.json"), nextCheck);
  const { TC_PROFILE: _profile, TC_HOST: _host, TC_HOME: _home, TC_PRIVATE_KEY: _key, ...ambient } = process.env;
  return {
    /** What the background job records once `npm root -g` confirms this is the npm global install. */
    verified() {
      recordInstallKind(versions, packageDir, installed, "npm-global");
    },
    config(value: object) {
      writeFileSync(join(state, ".tinycloud", "config.json"), JSON.stringify({ defaultProfile: "default", version: 1, ...value }));
    },
    /** `tinycloud --version` on a pty (the notice is for terminals only): stdout and stderr arrive together. */
    noticeFor(available: string): string {
      writeFileSync(join(state, ".tinycloud", "update-check.json.latest"), JSON.stringify({ checkedAt: Date.now(), version: available }));
      const command = ["node", join(packageDir, "bin", "tinycloud"), "--version"].map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(" ");
      const result = spawnSync("script", ["-qec", command, "/dev/null"], {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...ambient,
          CI: "",
          TC_NO_AUTO_UPDATE: "",
          NO_COLOR: "1",
          HOME: dir,
          TC_HOME: state,
          TC_VERSIONS_DIR: versions,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(installed);
      // No background update started.
      expect(readFileSync(join(versions, "next-check.json"), "utf8")).toBe(nextCheck);
      return result.stdout;
    },
  };
}

const [major, minor] = installed.split(".").map(Number);
const newerMinor = `${major}.${minor + 1}.0`;
const newerMajor = `${major + 1}.0.0`;

// Terminal-only notice, so the runs go through util-linux `script` for a pty, as in #1054's update-notice test.
describe.skipIf(process.platform !== "linux")("update notice with automatic updates", () => {
  test("a patch or minor that the background updater installs gets no notice", () => {
    const cli = npmGlobalInstall();
    cli.verified();
    expect(cli.noticeFor(newerMinor)).not.toContain(newerMinor);
  });

  test("an install not verified as npm's or bun's global one gets the notice, whatever its path looks like", () => {
    expect(npmGlobalInstall().noticeFor(newerMinor)).toContain(`TinyCloud CLI ${newerMinor} is available.`);
  });

  test("a major still gets the notice", () => {
    const cli = npmGlobalInstall();
    cli.verified();
    expect(cli.noticeFor(newerMajor)).toContain(`TinyCloud CLI ${newerMajor} is available.`);
  });

  test("with autoUpdate: false a patch or minor gets the notice", () => {
    const cli = npmGlobalInstall();
    cli.verified();
    cli.config({ autoUpdate: false });
    expect(cli.noticeFor(newerMinor)).toContain(`TinyCloud CLI ${newerMinor} is available.`);
  });
});
