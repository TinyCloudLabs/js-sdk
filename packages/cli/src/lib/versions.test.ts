import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeVersion, liveLeases, markVerified, versionPackageDir, versionsRoot, writeFileAtomic, writeLease, writePointer } from "./versions.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tc4276-versions-"));
  dirs.push(dir);
  return dir;
}

function installVersion(root: string, version: string) {
  const packageDir = versionPackageDir(root, version);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@tinycloud/cli", version }));
  markVerified(join(root, version), version, "sha512-fake");
  return packageDir;
}

describe("versions root", () => {
  test("TC_VERSIONS_DIR overrides ~/.tinycloud/versions", () => {
    expect(versionsRoot({}, "/home/u")).toBe("/home/u/.tinycloud/versions");
    expect(versionsRoot({ TC_VERSIONS_DIR: "/srv/qa/versions" }, "/home/u")).toBe("/srv/qa/versions");
  });
});

describe("active version", () => {
  test("a pointer whose version isn't a plain version number is ignored", () => {
    const dir = scratch();
    const root = join(dir, "versions");
    installVersion(root, "1.9.5");
    writeFileAtomic(join(root, "current.json"), JSON.stringify({ version: "../1.9.5", base: "1.9.4", auto: true, pinned: false }));
    expect(activeVersion(root, join(dir, "base"), "1.9.4").version).toBe("1.9.4");
  });

  test("a staged copy inside the versions root always runs itself", () => {
    const dir = scratch();
    const root = join(dir, "versions");
    const staged = installVersion(root, "1.9.5");
    installVersion(root, "1.9.6");
    writePointer(root, { version: "1.9.6", base: "1.9.5", auto: true, pinned: false });
    expect(activeVersion(root, staged, "1.9.5")).toEqual({ version: "1.9.5", packageDir: staged });
  });
});

describe("leases", () => {
  test("a lease lasts while its process runs; an exited process's lease is dropped", () => {
    const root = join(scratch(), "versions");
    const release = writeLease(root, { version: "1.9.5", courier: true });
    writeFileAtomic(join(root, ".leases", "999999.json"), JSON.stringify({ pid: 999999, version: "1.9.4", courier: true }));
    expect(liveLeases(root, (pid) => pid === process.pid)).toEqual([{ pid: process.pid, version: "1.9.5", courier: true }]);
    expect(liveLeases(root, () => true)).toEqual([{ pid: process.pid, version: "1.9.5", courier: true }]);
    release();
    expect(liveLeases(root)).toEqual([]);
  });
});
