import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunGlobalModules, recordedInstallKind, recordInstallKind, verifyInstallKind } from "./install-kind.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function machine() {
  const dir = mkdtempSync(join(tmpdir(), "tc4276-kind-"));
  dirs.push(dir);
  const npmRoot = join(dir, "usr", "local", "lib", "node_modules");
  const bunRoot = join(dir, "home", ".bun", "install", "global", "node_modules");
  const cli = (modules: string) => {
    const packageDir = join(modules, "@tinycloud", "cli");
    mkdirSync(packageDir, { recursive: true });
    return packageDir;
  };
  return { dir, npmRoot, bunRoot, cli, roots: { npm: async () => npmRoot, bun: () => bunRoot } };
}

describe("verified install kind", () => {
  test("the CLI in npm's global root is npm-global, in bun's global directory bun-global", async () => {
    const m = machine();
    expect(await verifyInstallKind(m.cli(m.npmRoot), m.roots)).toBe("npm-global");
    expect(await verifyInstallKind(m.cli(m.bunRoot), m.roots)).toBe("bun-global");
  });

  test("a path that only looks global, or a Volta image, is not verified", async () => {
    const m = machine();
    m.cli(m.npmRoot);
    expect(await verifyInstallKind(m.cli(join(m.dir, "srv", "app", "lib", "node_modules")), m.roots)).toBeNull();
    expect(await verifyInstallKind(m.cli(join(m.dir, "home", ".volta", "tools", "image", "packages", "@tinycloud", "cli", "lib", "node_modules")), m.roots)).toBeNull();
  });

  test("a symlinked global root still matches; npm not answering verifies nothing as npm-global", async () => {
    const m = machine();
    const packageDir = m.cli(m.npmRoot);
    const linked = join(m.dir, "linked-root");
    symlinkSync(m.npmRoot, linked);
    expect(await verifyInstallKind(packageDir, { npm: async () => linked, bun: m.roots.bun })).toBe("npm-global");
    expect(await verifyInstallKind(packageDir, { npm: async () => null, bun: m.roots.bun })).toBeNull();
  });

  test("bun's global directory follows BUN_INSTALL_GLOBAL_DIR, then BUN_INSTALL", () => {
    expect(bunGlobalModules({}, "/home/u")).toBe("/home/u/.bun/install/global/node_modules");
    expect(bunGlobalModules({ BUN_INSTALL: "/opt/bun" }, "/home/u")).toBe("/opt/bun/install/global/node_modules");
    expect(bunGlobalModules({ BUN_INSTALL_GLOBAL_DIR: "/g", BUN_INSTALL: "/opt/bun" }, "/home/u")).toBe("/g/node_modules");
  });

  test("a recorded kind applies only to the same install and version", () => {
    const m = machine();
    const packageDir = m.cli(m.npmRoot);
    const versions = join(m.dir, "versions");
    recordInstallKind(versions, packageDir, "1.9.4", "npm-global");
    expect(recordedInstallKind(versions, packageDir, "1.9.4")).toBe("npm-global");
    expect(recordedInstallKind(versions, packageDir, "1.9.5")).toBeNull();
    expect(recordedInstallKind(versions, m.cli(m.bunRoot), "1.9.4")).toBeNull();
  });
});
