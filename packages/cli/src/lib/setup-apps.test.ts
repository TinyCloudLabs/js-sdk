import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSetupAgent, setupApps, type SetupDependencies } from "./setup-apps.js";
import { cliPackageRoot, readBundledSkill } from "./skill-install.js";

const PACKAGE = cliPackageRoot();
const BUNDLE = join(PACKAGE, "skills", "tc-apps");
const VERSION = "1.5.0";
const SKILL_FILES = [
  "LEGACY-SQL.md", "LEGACY.md", "QUICKSTART.md", "SKILL.md", "SQL.md", "TINY-APPS.md",
  "announce.sh", "layout.sh", "migrate.sh", "owner-grant.sh", "owner-undo.sh", "tc-wrapper.sh",
];
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "tc-setup-apps-"));
  homes.push(home);
  return home;
}

/** A stand-in for npm: records its arguments and lays out the installed package as npm would. */
function fakeNpm(version = VERSION) {
  const calls: string[][] = [];
  const runNpm = async (args: readonly string[]) => {
    calls.push([...args]);
    const prefix = args[args.indexOf("--prefix") + 1]!;
    const spec = args.at(-1)!;
    await mkdir(join(prefix, "node_modules", "@tinycloud", "cli", "bin"), { recursive: true });
    await writeFile(join(prefix, "node_modules", "@tinycloud", "cli", "package.json"),
      JSON.stringify({ name: "@tinycloud/cli", version: spec.split("@").at(-1) === version ? version : "0.0.0" }));
    await mkdir(join(prefix, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(prefix, "node_modules", ".bin", "tinycloud"), "#!/bin/sh\n");
  };
  return { calls, runNpm };
}

function deps(home: string, overrides: Partial<SetupDependencies> & { env?: NodeJS.ProcessEnv } = {}): SetupDependencies {
  return {
    env: { HOME: home, ...overrides.env },
    ownVersion: VERSION,
    bundleDir: BUNDLE,
    packageRoot: PACKAGE,
    runNpm: fakeNpm().runNpm,
    ...overrides,
  };
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

describe("the bundled tc-apps skill", () => {
  test("ships every file the /apps guide copies, matching its SHA256SUMS", async () => {
    const skill = await readBundledSkill(BUNDLE, "tc-apps");
    expect([...skill.files.keys()].sort()).toEqual([...SKILL_FILES].sort());
    expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/);
    const pkg = JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("skills");
  });
});

describe("setup apps", () => {
  test("claude-code: the exact CLI version in the private prefix, the skill in Claude's folder and a private copy", async () => {
    const home = await scratch();
    const claude = join(home, "claude-config");
    const npm = fakeNpm();
    const result = await setupApps("claude-code", deps(home, { env: { HOME: home, CLAUDE_CONFIG_DIR: claude }, runNpm: npm.runNpm }));

    const share = join(home, ".local", "share", "tc-apps");
    expect(npm.calls).toEqual([["install", "--prefix", join(share, "cli"), "--no-audit", "--no-fund", "--save-exact", `@tinycloud/cli@${VERSION}`]]);
    expect(npm.calls.flat().some((arg) => /latest|-g$|--global/.test(arg))).toBe(false);
    expect(result.cli).toEqual({ path: join(share, "cli", "node_modules", ".bin", "tinycloud"), version: VERSION, installed: true, source: "private" });

    const folder = join(claude, "skills", "tc-apps");
    expect(result.skill).toMatchObject({ name: "tc-apps", files: 12, folder, privateCopy: join(share, "skill") });
    expect(result.skill).not.toHaveProperty("later");
    expect((await readdir(folder)).sort()).toEqual([...SKILL_FILES].sort());
    expect((await readdir(join(share, "skill"))).sort()).toEqual([...SKILL_FILES, "SHA256SUMS"].sort());
    for (const file of SKILL_FILES) {
      const bundled = await readFile(join(BUNDLE, file));
      expect((await readFile(join(folder, file))).equals(bundled)).toBe(true);
      expect((await readFile(join(share, "skill", file))).equals(bundled)).toBe(true);
    }

    expect(await readFile(join(share, "cli-path"), "utf8")).toBe(`${result.cli.path}\n`);
    expect((await readFile(join(share, "tinycloud"))).equals(await readFile(join(BUNDLE, "tc-wrapper.sh")))).toBe(true);
    expect(await mode(join(share, "tinycloud"))).toBe(0o755);
    expect(await mode(join(home, ".tinycloud"))).toBe(0o700);
    expect(await mode(join(home, ".local", "state", "tc-apps"))).toBe(0o700);
    expect(await mode(join(share, "skill"))).toBe(0o700);
    expect(result.state).toBe(join(home, ".local", "state", "tc-apps"));
  });

  test("a rerun installs nothing again and replaces the skill folder whole", async () => {
    const home = await scratch();
    const npm = fakeNpm();
    await setupApps("codex", deps(home, { runNpm: npm.runNpm }));
    const folder = join(home, ".agents", "skills", "tc-apps");
    await writeFile(join(folder, "STALE.md"), "from an earlier version");
    const again = await setupApps("codex", deps(home, { runNpm: npm.runNpm }));
    expect(npm.calls).toHaveLength(1);
    expect(again.cli.installed).toBe(false);
    expect(again.skill.folder).toBe(folder);
    expect((await readdir(folder)).sort()).toEqual([...SKILL_FILES].sort());
    expect((await readdir(join(home, ".agents", "skills"))).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("opencode shares Codex's folder; TC_HOME and TC_APPS_STATE move their folders", async () => {
    const home = await scratch();
    const result = await setupApps("opencode", deps(home, { env: { HOME: home, TC_HOME: join(home, "tc"), TC_APPS_STATE: join(home, "state") } }));
    expect(result.skill.folder).toBe(join(home, ".agents", "skills", "tc-apps"));
    expect(await mode(join(home, "tc", ".tinycloud"))).toBe(0o700);
    expect(result.state).toBe(join(home, "state"));
  });

  test("TC_BIN: the owner's CLI is used and nothing is installed", async () => {
    const home = await scratch();
    const npm = fakeNpm();
    const result = await setupApps("claude-code", deps(home, { env: { HOME: home, TC_BIN: "/opt/tinycloud/bin/tinycloud" }, runNpm: npm.runNpm }));
    expect(npm.calls).toEqual([]);
    expect(result.cli).toEqual({ path: "/opt/tinycloud/bin/tinycloud", version: null, installed: false, source: "TC_BIN" });
    expect(await readFile(join(home, ".local", "share", "tc-apps", "cli-path"), "utf8")).toBe("/opt/tinycloud/bin/tinycloud\n");
  });

  test("--agent none (the client declined the copy): only the private copy, and the command for later", async () => {
    const home = await scratch();
    const result = await setupApps("none", deps(home));
    expect(result.skill.folder).toBeNull();
    expect(result.skill.later).toBe(`"${result.cli.path}" setup apps --agent <claude-code|codex|opencode>`);
    expect(await exists(join(home, ".claude"))).toBe(false);
    expect(await exists(join(home, ".agents"))).toBe(false);
    expect(await exists(join(home, ".local", "share", "tc-apps", "skill", "SKILL.md"))).toBe(true);
  });

  test("a skills folder it can't write: setup still succeeds and says so", async () => {
    const home = await scratch();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "skills"), "not a folder");
    const result = await setupApps("claude-code", deps(home));
    expect(result.skill.folder).toBeNull();
    expect(result.skill.folderError).toBeString();
    expect(result.skill.later).toContain("setup apps --agent claude-code");
    expect(await exists(join(home, ".local", "share", "tc-apps", "skill", "SKILL.md"))).toBe(true);
  });

  test("a changed or unlisted bundled file stops setup before anything is written", async () => {
    for (const tamper of [
      async (dir: string) => writeFile(join(dir, "layout.sh"), "#!/bin/sh\necho pwned\n"),
      async (dir: string) => writeFile(join(dir, "EXTRA.md"), "not listed"),
      async (dir: string) => rm(join(dir, "SHA256SUMS")),
    ]) {
      const home = await scratch();
      const bundle = join(home, "bundle");
      await cp(BUNDLE, bundle, { recursive: true });
      await tamper(bundle);
      const npm = fakeNpm();
      await expect(setupApps("claude-code", deps(home, { bundleDir: bundle, runNpm: npm.runNpm }))).rejects.toMatchObject({ code: "SKILL_INTEGRITY_FAILED" });
      expect(npm.calls).toEqual([]);
      expect(await exists(join(home, ".local"))).toBe(false);
      expect(await exists(join(home, ".claude"))).toBe(false);
    }
  });

  test("an install that leaves another version, or a version that isn't exact, is refused", async () => {
    const home = await scratch();
    await expect(setupApps("codex", deps(home, { runNpm: fakeNpm("9.9.9").runNpm }))).rejects.toMatchObject({ code: "CLI_INSTALL_FAILED" });
    expect(await exists(join(home, ".agents"))).toBe(false);
    await expect(setupApps("codex", deps(home, { ownVersion: "latest" }))).rejects.toMatchObject({ code: "CLI_INSTALL_FAILED" });
    await expect(setupApps("codex", deps(home, { ownVersion: "^1.5.0" }))).rejects.toMatchObject({ code: "CLI_INSTALL_FAILED" });
  });

  test("--agent auto reads the client's own variables and never guesses", () => {
    expect(resolveSetupAgent("auto", { CLAUDECODE: "1" })).toBe("claude-code");
    expect(resolveSetupAgent("auto", { OPENCODE: "1" })).toBe("opencode");
    expect(resolveSetupAgent("auto", { CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(() => resolveSetupAgent("auto", {})).toThrow("Pass --agent");
    expect(() => resolveSetupAgent("cursor", {})).toThrow("Unknown --agent");
    expect(resolveSetupAgent("none", {})).toBe("none");
  });
});
