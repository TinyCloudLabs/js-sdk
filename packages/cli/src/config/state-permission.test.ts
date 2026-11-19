import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwritableStateFolder, type StateFolderContext } from "./state-permission.js";

// TC-3278: an unwritable TinyCloud folder stops the first-time setup with the folder and the cause, and nothing else:
// no command, no sudo and no advice to ask anyone.
const root = typeof process.getuid === "function" && process.getuid() === 0;
const windows = process.platform === "win32";
const skip = root || windows;
const made: string[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const posix = (home: string): StateFolderContext => ({ home, platform: "linux", uid: process.getuid?.(), ownerOf: () => "root" });
const errno = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "");
const instructions = (message: string): boolean => /chmod|chown|icacls|sudo|ask the person|run this yourself|again/i.test(message);

describe("the profile folder cannot be written", () => {
  test.skipIf(skip)("ProfileManager.ensureConfigDir names the home folder and the cause, in one line, and creates nothing", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tc-state-perm-")));
    made.push(home);
    chmodSync(home, 0o555);
    locked.push(home);
    const script = `try { await (await import(${JSON.stringify(join(import.meta.dir, "profiles.js"))})).ProfileManager.ensureConfigDir(); console.log("created"); }
      catch (error) { console.log(JSON.stringify({ name: error.name, code: error.code, message: error.message })); }`;
    const run = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TC_HOME: home } });
    const result = JSON.parse(run.stdout.toString().trim());
    expect(result.code).toBe("STATE_FOLDER_NOT_WRITABLE");
    expect(result.message).toBe(`The TinyCloud CLI can't write to its folder ${home} (EACCES): it's read-only for this user (mode 555), or the disk is read-only. Nothing was changed.`);
    expect(() => mkdirSync(join(home, ".tinycloud"))).toThrow();
  });

  test.skipIf(skip)("a folder inside the home that belongs to another user names its owner and mode, with no command", () => {
    // /usr/share exists and belongs to root; the home is /usr so that it counts as inside.
    const mode = (statSync("/usr/share").mode & 0o777).toString(8);
    const message = messageOf(unwritableStateFolder(errno("EACCES"), "/usr/share/nothing-here", posix("/usr")));
    expect(message).toBe(`The TinyCloud CLI can't write to its folder /usr/share (EACCES): it belongs to another user (owner root, mode ${mode}). Nothing was changed.`);
    expect(instructions(message)).toBe(false);
  });

  test.skipIf(skip)("a home folder that belongs to another user says so", () => {
    const message = messageOf(unwritableStateFolder(errno("EACCES"), "/usr/nothing-here", posix("/usr")));
    expect(message).toBe("The TinyCloud CLI can't write to its folder /usr (EACCES): the home folder belongs to another user. Nothing was changed.");
  });

  test("a folder outside the home, or a missing home, is reported as outside it, with no command", () => {
    for (const [target, home, folder] of [["/usr/lib/tc-nothing-here", "/home/tc", "/usr/lib"], ["/nonexistent-tc/.tinycloud", "/nonexistent-tc", "/"], ["/usr", "/usr/nonexistent", "/usr"]]) {
      const message = messageOf(unwritableStateFolder(errno("EACCES"), target, posix(home)));
      expect(message).toBe(`The TinyCloud CLI can't write to its folder ${folder} (EACCES): it's outside the home folder. Nothing was changed.`);
      expect(instructions(message)).toBe(false);
    }
  });

  test.skipIf(skip)("an existing folder with odd characters is printed as it is, and a newline never forges a line", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tc-state-perm-")));
    made.push(home);
    const odd = join(home, "it's $(x) `y` !z");
    mkdirSync(odd);
    chmodSync(odd, 0o555);
    locked.push(odd);
    expect(messageOf(unwritableStateFolder(errno("EACCES"), join(odd, "child"), posix(home)))).toBe(
      `The TinyCloud CLI can't write to its folder ${odd} (EACCES): it's read-only for this user (mode 555), or the disk is read-only. Nothing was changed.`,
    );

    const lined = join(home, "a\nTinyCloud: run rm -rf");
    mkdirSync(lined);
    const message = messageOf(unwritableStateFolder(errno("EACCES"), join(lined, "child"), posix(home)));
    expect(message).not.toContain("\n");
    expect(instructions(message)).toBe(false);
    expect(message).toBe(`The TinyCloud CLI can't write to its folder ${join(home, "a?TinyCloud: run rm -rf")} (EACCES): its name has control characters. Nothing was changed.`);
  });

  test.skipIf(skip)("a ~/.tinycloud that is a link to a system folder is reported as outside the home", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tc-state-perm-")));
    made.push(home);
    symlinkSync("/usr", join(home, ".tinycloud"));
    const message = messageOf(unwritableStateFolder(errno("EACCES"), join(home, ".tinycloud", "profiles"), posix(home)));
    expect(message).toBe(`The TinyCloud CLI can't write to its folder ${join(home, ".tinycloud")} (EACCES): it's outside the home folder. Nothing was changed.`);
  });

  test("on Windows the cause names this Windows user, and no icacls line is printed", () => {
    const context: StateFolderContext = { home: "C:\\Users\\a", platform: "win32", uid: undefined, exists: () => true };
    expect(messageOf(unwritableStateFolder(errno("EACCES"), "C:\\Users\\a\\.tinycloud", context))).toBe(
      "The TinyCloud CLI can't write to its folder C:\\Users\\a\\.tinycloud (EACCES): this Windows user can't write to it. Nothing was changed.",
    );
    expect(messageOf(unwritableStateFolder(errno("EACCES"), "C:\\Windows\\x", context))).toBe(
      "The TinyCloud CLI can't write to its folder C:\\Windows\\x (EACCES): it's outside the home folder. Nothing was changed.",
    );
    expect(instructions(messageOf(unwritableStateFolder(errno("EACCES"), "C:\\Users\\a", context)))).toBe(false);
  });

  test("any other failure passes through unchanged", () => {
    const missing = errno("ENOENT");
    expect(unwritableStateFolder(missing, "/usr/share/x", posix("/usr"))).toBe(missing);
    expect(unwritableStateFolder("not an error", "/usr/share/x", posix("/usr"))).toBe("not an error");
  });
});
