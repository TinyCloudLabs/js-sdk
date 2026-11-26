import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { binaryName, courierBinary } from "../../courier/src/guard/binaries.js";
import { activeVersion, isVerified, markVerified, versionPackageDir, writePointer } from "../src/lib/versions.js";

// TC-4276: the real bin/tinycloud and built dist/launcher.js, with fake builds that report what ran.
const PACKAGE_DIR = resolve(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REPORT = `const ctx = globalThis[Symbol.for("tinycloud.cli.launchContext")];
console.log(JSON.stringify({ ran: VERSION, argv1: process.argv[1], base: ctx ? ctx.baseVersion : null }));\n`;

function fakeBuild(packageDir: string, version: string) {
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@tinycloud/cli", version, type: "module" }));
  writeFileSync(join(packageDir, "dist", "index.js"), REPORT.replace("VERSION", JSON.stringify(version)));
}

function install(baseVersion: string) {
  const dir = mkdtempSync(join(tmpdir(), "tc4276-launcher-"));
  dirs.push(dir);
  const base = join(dir, "global", "lib", "node_modules", "@tinycloud", "cli");
  fakeBuild(base, baseVersion);
  mkdirSync(join(base, "bin"));
  copyFileSync(join(PACKAGE_DIR, "bin", "tinycloud"), join(base, "bin", "tinycloud"));
  copyFileSync(join(PACKAGE_DIR, "dist", "launcher.js"), join(base, "dist", "launcher.js"));
  const root = join(dir, "versions");
  const bin = join(base, "bin", "tinycloud");
  const spawn = (...args: string[]) => spawnSync("node", [bin, ...args], { encoding: "utf8", env: { ...process.env, TC_VERSIONS_DIR: root } });
  return {
    root,
    bin,
    base,
    version(version: string, verified = true) {
      fakeBuild(versionPackageDir(root, version), version);
      if (verified) markVerified(join(root, version), version, "sha512-fake");
    },
    spawn,
    run(...args: string[]): { ran: string; argv1: string; base: string | null } {
      const result = spawn(...args);
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout);
    },
  };
}

describe("launcher", () => {
  test("runs the pointed-to verified version, with the base launcher as the program path", () => {
    const cli = install("1.9.4");
    expect(cli.run()).toEqual({ ran: "1.9.4", argv1: cli.bin, base: "1.9.4" });
    cli.version("1.9.5");
    writePointer(cli.root, { version: "1.9.5", base: "1.9.4", auto: true, pinned: false });
    expect(cli.run()).toEqual({ ran: "1.9.5", argv1: cli.bin, base: "1.9.4" });
  });

  test("runs its own build when the pointer is for another base install, or names an unverified version", () => {
    const cli = install("1.9.4");
    cli.version("1.9.6", false);
    writePointer(cli.root, { version: "1.9.6", base: "1.9.4", auto: true, pinned: false });
    expect(cli.run().ran).toBe("1.9.4");
    cli.version("1.9.5");
    // A manual `npm install -g` of 1.9.3 replaced the base: the pointer written for 1.9.4 no longer applies.
    writePointer(cli.root, { version: "1.9.5", base: "1.9.3", auto: true, pinned: false });
    expect(cli.run().ran).toBe("1.9.4");
  });

  test("the Courier guard census taken before a version switch still names the launcher after it", () => {
    const cli = install("1.9.4");
    const before = cli.run("courier", "watch");
    const census = courierBinary(before.argv1, ["node", before.argv1, "courier", "watch"]);
    expect(census).toHaveLength(1);

    cli.version("1.9.5");
    writePointer(cli.root, { version: "1.9.5", base: "1.9.4", auto: true, pinned: false });
    const after = cli.run("courier", "watch");
    expect(after.ran).toBe("1.9.5");
    expect(after.argv1).toBe(before.argv1);
    expect(binaryName(after.argv1, PACKAGE_DIR, "", census)).toBe("tc");
  });

  // A version directory can lose files or hold a build that no longer loads; the global build must still run.
  const broken: Record<string, (entry: string) => void> = {
    "is missing": (entry) => rmSync(entry),
    "throws as it is imported": (entry) => writeFileSync(entry, `throw new Error("broken build");\n`),
    "imports a file that is missing": (entry) => writeFileSync(entry, `import "./chunk-gone.js";\n`),
  };
  // chmod does not stop root from reading.
  if (process.getuid?.() !== 0) broken["is unreadable"] = (entry) => chmodSync(entry, 0o000);
  for (const [how, breakIt] of Object.entries(broken)) {
    test(`runs its own build when the chosen version's dist/index.js ${how}, and never chooses that version again`, () => {
      const cli = install("1.9.4");
      cli.version("1.9.5");
      writePointer(cli.root, { version: "1.9.5", base: "1.9.4", auto: true, pinned: false });
      const entry = join(versionPackageDir(cli.root, "1.9.5"), "dist", "index.js");
      breakIt(entry);
      expect(cli.run("--version")).toEqual({ ran: "1.9.4", argv1: cli.bin, base: "1.9.4" });
      expect(isVerified(cli.root, "1.9.5")).toBe(false);
      expect(activeVersion(cli.root, cli.base, "1.9.4").version).toBe("1.9.4");
      // Even with a loadable build back in place, the version stays skipped until `tinycloud upgrade` verifies it again.
      rmSync(entry, { force: true });
      cli.version("1.9.5", false);
      expect(cli.run().ran).toBe("1.9.4");
    });
  }

  test("an error the chosen version throws once it has started is not retried on the global build", () => {
    const cli = install("1.9.4");
    cli.version("1.9.5");
    writePointer(cli.root, { version: "1.9.5", base: "1.9.4", auto: true, pinned: false });
    writeFileSync(
      join(versionPackageDir(cli.root, "1.9.5"), "dist", "index.js"),
      `globalThis[Symbol.for("tinycloud.cli.launchContext")];\nconsole.log("1.9.5 started");\nawait Promise.resolve();\nthrow new Error("command failed");\n`,
    );
    const result = cli.spawn();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("1.9.5 started\n");
    expect(result.stderr).toContain("command failed");
    expect(isVerified(cli.root, "1.9.5")).toBe(true);
  });
});
