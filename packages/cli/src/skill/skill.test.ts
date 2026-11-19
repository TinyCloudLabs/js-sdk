import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLIENT_NAMES, skillRoots } from "./clients.js";
import { checkSkill, saveBundledSkill } from "./run.js";

// TC-3278: `skill save` copies the guide the CLI ships into the skills folder of the agent's client, and never
// overwrites files TinyCloud did not write.
const root = typeof process.getuid === "function" && process.getuid() === 0;
const windows = process.platform === "win32";
const made: string[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tc-skill-"));
  made.push(dir);
  return dir;
}

/** A stand-in for the package: `<package>/package.json` and `<package>/skills/tinycloud-cli/…`. */
function bundle(version = "9.1.0", body = "guide one"): string {
  const pack = scratch();
  writeFileSync(join(pack, "package.json"), JSON.stringify({ name: "@tinycloud/cli", version }));
  const skill = join(pack, "skills", "tinycloud-cli");
  mkdirSync(join(skill, "more"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), body);
  writeFileSync(join(skill, "more", "REFERENCE.md"), "reference");
  return skill;
}

const home = (): { home: string; env: Record<string, string | undefined> } => ({ home: scratch(), env: {} });

describe("which folders", () => {
  test("Claude Code gets its own folder, and the CLAUDE_CONFIG_DIR override is used", () => {
    const context = home();
    expect(skillRoots("claude-code", context)).toEqual([join(context.home, ".claude", "skills")]);
    expect(skillRoots("claude-code", { ...context, env: { CLAUDE_CONFIG_DIR: "/elsewhere/claude" } })).toEqual(["/elsewhere/claude/skills"]);
  });

  test("every other client gets the shared folder, and Hermes and Amp one more", () => {
    const context = home();
    const shared = join(context.home, ".agents", "skills");
    for (const name of ["codex", "copilot", "cursor", "gemini", "omp", "opencode", "agents"]) expect(skillRoots(name, context)).toEqual([shared]);
    expect(skillRoots("hermes", context)).toEqual([shared, join(context.home, ".hermes", "skills")]);
    expect(skillRoots("amp", context)).toEqual([shared, join(context.home, ".config", "agents", "skills")]);
    expect(skillRoots("openclaw", context)).toEqual([shared, join(context.home, ".openclaw", "skills")]);
  });

  test("several named clients share one copy of a folder", () => {
    const context = home();
    expect(skillRoots("codex,opencode,claude-code", context)).toEqual([join(context.home, ".agents", "skills"), join(context.home, ".claude", "skills")]);
  });

  test("auto picks the clients found on this computer, and nothing found is not guessed", () => {
    const context = home();
    expect(skillRoots(undefined, context)).toBeUndefined();
    expect(skillRoots("auto", context)).toBeUndefined();
    mkdirSync(join(context.home, ".codex"));
    expect(skillRoots(undefined, context)).toEqual([join(context.home, ".agents", "skills")]);
  });

  test("an unknown client name is refused with the list of ten", () => {
    expect(skillRoots("windsurf", home())).toBeUndefined();
    expect(CLIENT_NAMES).toEqual(["amp", "claude-code", "codex", "copilot", "cursor", "gemini", "hermes", "omp", "openclaw", "opencode"]);
  });
});

describe("skill save", () => {
  test("saves the shipped files and a marker, and reports the folder and the CLI version", () => {
    const context = home();
    const result = saveBundledSkill({ agent: "claude-code", context, bundledDir: bundle("9.1.0") });
    const folder = join(context.home, ".claude", "skills", "tinycloud-cli");
    expect(result).toEqual({ saved: "tinycloud-cli", version: "9.1.0", folder, folders: [folder], unchanged: [] });
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe("guide one");
    expect(readFileSync(join(folder, "more", "REFERENCE.md"), "utf8")).toBe("reference");
    expect(existsSync(join(folder, ".tinycloud-skill.json"))).toBe(true);
  });

  test("saving again with nothing new reports the folder as unchanged", () => {
    const context = home();
    const source = bundle();
    saveBundledSkill({ agent: "claude-code", context, bundledDir: source });
    const again = saveBundledSkill({ agent: "claude-code", context, bundledDir: source });
    expect(again.unchanged).toEqual([again.folder]);
  });

  test("a newer guide replaces a copy TinyCloud saved, and leaves no staging or backup folder", () => {
    const context = home();
    saveBundledSkill({ agent: "claude-code", context, bundledDir: bundle("9.1.0", "guide one") });
    const folder = join(context.home, ".claude", "skills", "tinycloud-cli");
    expect(checkSkill({ agent: "claude-code", context, bundledDir: bundle("9.2.0", "guide two") }).state).toBe("outdated");
    saveBundledSkill({ agent: "claude-code", context, bundledDir: bundle("9.2.0", "guide two") });
    expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe("guide two");
    expect(readdirSync(dirname(folder))).toEqual(["tinycloud-cli"]);
  });

  test("a folder with a file TinyCloud did not write is refused, and nothing is replaced in any folder", () => {
    const context = home();
    const source = bundle();
    const mine = join(context.home, ".claude", "skills", "tinycloud-cli");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "SKILL.md"), "my own notes");
    let message = "";
    try {
      saveBundledSkill({ agent: "claude-code,codex", context, bundledDir: source });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`${mine} has files TinyCloud didn't write, so nothing was replaced.`);
    expect(readFileSync(join(mine, "SKILL.md"), "utf8")).toBe("my own notes");
    expect(existsSync(join(context.home, ".agents"))).toBe(false);
  });

  test("an edited copy that TinyCloud saved counts as changed, not outdated", () => {
    const context = home();
    saveBundledSkill({ agent: "claude-code", context, bundledDir: bundle("9.1.0", "guide one") });
    const folder = join(context.home, ".claude", "skills", "tinycloud-cli");
    writeFileSync(join(folder, "SKILL.md"), "edited");
    expect(checkSkill({ agent: "claude-code", context, bundledDir: bundle("9.2.0", "guide two") }).state).toBe("changed");
  });

  test("a link in the skill folder is never followed", () => {
    const context = home();
    const target = scratch();
    const parent = join(context.home, ".claude", "skills");
    mkdirSync(parent, { recursive: true });
    symlinkSync(target, join(parent, "tinycloud-cli"));
    expect(checkSkill({ agent: "claude-code", context, bundledDir: bundle() }).state).toBe("changed");
    expect(() => saveBundledSkill({ agent: "claude-code", context, bundledDir: bundle() })).toThrow("so nothing was replaced");
    expect(readdirSync(target)).toEqual([]);
  });

  test("an unknown agent, or none found, says it cannot tell and lists the ten", () => {
    for (const agent of ["windsurf", undefined]) {
      let message = "";
      let code = "";
      try {
        saveBundledSkill({ agent, context: home(), bundledDir: bundle() });
      } catch (error) {
        message = (error as Error).message;
        code = (error as { code: string }).code;
      }
      expect(code).toBe("INVALID_ARGUMENT");
      expect(message).toBe("Can't tell which agent this is. --agent takes amp, claude-code, codex, copilot, cursor, gemini, hermes, omp, openclaw or opencode.");
    }
  });

  test.skipIf(root || windows)("a read-only skills folder is named with its mode, and no command is given", () => {
    const context = home();
    const claude = join(context.home, ".claude");
    mkdirSync(claude);
    chmodSync(claude, 0o555);
    locked.push(claude);
    let message = "";
    try {
      saveBundledSkill({ agent: "claude-code", context, bundledDir: bundle() });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`Can't write ${claude}: it's read-only for this user (mode 555).`);
    expect(message).not.toMatch(/chmod|chown|sudo|again/i);
  });
});

describe("skill save --check", () => {
  test("reports missing, current and the most important state across folders, and writes nothing", () => {
    const context = home();
    const source = bundle();
    expect(checkSkill({ agent: "claude-code", context, bundledDir: source }).state).toBe("missing");
    expect(existsSync(join(context.home, ".claude"))).toBe(false);
    saveBundledSkill({ agent: "claude-code", context, bundledDir: source });
    expect(checkSkill({ agent: "claude-code", context, bundledDir: source }).state).toBe("current");
    const both = checkSkill({ agent: "claude-code,codex", context, bundledDir: source });
    expect(both.state).toBe("missing");
    expect(both.folders.map((entry) => entry.state)).toEqual(["current", "missing"]);
  });
});

describe("skill save while another save runs, or after one was stopped", () => {
  const claudeSkills = (context: { home: string }): string => join(context.home, ".claude", "skills");

  test("staging and backup folders a stopped run left are swept, and other files in the folder are kept", () => {
    const context = home();
    const skills = claudeSkills(context);
    mkdirSync(join(skills, ".tinycloud-cli.staging-1-aa"), { recursive: true });
    mkdirSync(join(skills, ".tinycloud-cli.old-1-bb"), { recursive: true });
    mkdirSync(join(skills, "other-skill"));
    saveBundledSkill({ agent: "claude-code", context, bundledDir: bundle() });
    expect(readdirSync(skills).sort()).toEqual(["other-skill", "tinycloud-cli"]);
  });

  test("a lock held by a running save is refused, and nothing is written", () => {
    const context = home();
    const skills = claudeSkills(context);
    mkdirSync(join(skills, ".tinycloud-cli.lock"), { recursive: true });
    writeFileSync(join(skills, ".tinycloud-cli.lock", "pid"), String(process.pid));
    let code = "";
    try {
      saveBundledSkill({ agent: "claude-code", context, bundledDir: bundle() });
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    expect(code).toBe("SKILL_FOLDER_BUSY");
    expect(existsSync(join(skills, "tinycloud-cli"))).toBe(false);
  });

  test("a lock whose save is gone is taken over and removed", () => {
    const context = home();
    const skills = claudeSkills(context);
    const lock = join(skills, ".tinycloud-cli.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "2147483646");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    saveBundledSkill({ agent: "claude-code", context, bundledDir: bundle() });
    expect(readdirSync(skills)).toEqual(["tinycloud-cli"]);
  });

  test.skipIf(root || windows)("a folder that fails after another was saved names the saved one", () => {
    const context = home();
    const second = join(context.home, ".agents", "skills");
    mkdirSync(second, { recursive: true });
    chmodSync(second, 0o500);
    locked.push(second);
    let metadata: unknown;
    try {
      saveBundledSkill({ agent: "claude-code,codex", context, bundledDir: bundle() });
    } catch (error) {
      metadata = (error as { metadata?: unknown }).metadata;
    }
    expect(metadata).toMatchObject({ saved: [join(claudeSkills(context), "tinycloud-cli")] });
  });
});
