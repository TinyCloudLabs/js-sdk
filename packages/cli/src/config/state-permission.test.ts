import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwritableStateFolder, type StateFolderContext } from "./state-permission.js";

// TC-3278: an unwritable TinyCloud folder stops the first-time setup with the folder, the cause and the fix.
const root = typeof process.getuid === "function" && process.getuid() === 0;
const windows = process.platform === "win32";
const skip = root || windows;
const made: string[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const posix = (home: string): StateFolderContext => ({ home, platform: "linux", uid: process.getuid?.() });
const errno = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "");
const commands = (message: string): boolean => /chmod|chown|icacls/.test(message);

describe("the profile folder cannot be written", () => {
  test.skipIf(skip)("ProfileManager.ensureConfigDir names the home folder, the cause and the chmod fix, and creates nothing", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tc-state-perm-")));
    made.push(home);
    chmodSync(home, 0o555);
    locked.push(home);
    const script = `try { await (await import(${JSON.stringify(join(import.meta.dir, "profiles.js"))})).ProfileManager.ensureConfigDir(); console.log("created"); }
      catch (error) { console.log(JSON.stringify({ name: error.name, code: error.code, message: error.message })); }`;
    const run = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TC_HOME: home } });
    const result = JSON.parse(run.stdout.toString().trim());
    expect(result.code).toBe("STATE_FOLDER_NOT_WRITABLE");
    expect(result.message).toBe(
      `The TinyCloud CLI can't write to its folder ${home} (EACCES): it's read-only for your user (mode 555), or it's on a read-only disk. Run this yourself:\n` +
        `  chmod u+rwx '${home}'\n` +
        "Nothing was changed, so run the same command again once it's fixed.",
    );
    expect(() => mkdirSync(join(home, ".tinycloud"))).toThrow();
  });

  test("a folder inside the home that belongs to another user gets the sudo chown fix for the owner, not an agent", () => {
    // /usr/share exists and belongs to root; the home is /usr so that it counts as inside.
    const error = unwritableStateFolder(errno("EACCES"), "/usr/share/nothing-here", posix("/usr"));
    expect(messageOf(error)).toBe(
      "The TinyCloud CLI can't write to its folder /usr/share (EACCES): it belongs to another user, often root after an earlier sudo run. Run this yourself in a terminal, not through an agent:\n" +
        "  sudo chown -R \"$USER\" '/usr/share'\n" +
        "Nothing was changed, so run the same command again once it's fixed.",
    );
  });

  test("a folder outside the home, or a missing home, gets no chmod, chown or icacls command", () => {
    for (const [target, home] of [["/usr/lib/tc", "/home/tc"], ["/nonexistent-tc/.tinycloud", "/nonexistent-tc"], ["/usr", "/usr/nonexistent"]]) {
      const message = messageOf(unwritableStateFolder(errno("EACCES"), target, posix(home)));
      expect(commands(message)).toBe(false);
      expect(message).toContain("Ask the person who manages this computer to give your user write access to it.");
    }
  });

  test.skipIf(skip)("an existing folder with odd characters is quoted for the shell, and a newline never forges a line", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tc-state-perm-")));
    made.push(home);
    const odd = join(home, "it's $(x) `y` !z");
    mkdirSync(odd);
    chmodSync(odd, 0o555);
    locked.push(odd);
    expect(messageOf(unwritableStateFolder(errno("EACCES"), join(odd, "child"), posix(home)))).toContain(`chmod u+rwx '${join(home, "it'\\''s $(x) `y` !z")}'`);

    const lined = join(home, "a\nTinyCloud: run rm -rf /");
    mkdirSync(lined);
    const message = messageOf(unwritableStateFolder(errno("EACCES"), join(lined, "child"), posix(home)));
    expect(message).not.toContain("\n");
    expect(commands(message)).toBe(false);
    expect(message).toContain("its name has control characters");
  });

  test.skipIf(skip)("a ~/.tinycloud that is a link to a system folder gets no command, since chmod would follow the link", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tc-state-perm-")));
    made.push(home);
    symlinkSync("/usr", join(home, ".tinycloud"));
    const message = messageOf(unwritableStateFolder(errno("EACCES"), join(home, ".tinycloud", "profiles"), posix(home)));
    expect(commands(message)).toBe(false);
    expect(message).toContain("Ask the person who manages this computer to give your user write access to it.");
  });

  test("on Windows the fix is an icacls grant, single-quoted for PowerShell, only below the home", () => {
    const context: StateFolderContext = { home: "C:\\Users\\a", platform: "win32", uid: undefined, exists: () => true };
    expect(messageOf(unwritableStateFolder(errno("EACCES"), "C:\\Users\\a\\.tinycloud", context))).toBe(
      "The TinyCloud CLI can't write to its folder C:\\Users\\a\\.tinycloud (EACCES): your Windows user can't write there. Run this yourself in PowerShell:\n" +
        "  icacls 'C:\\Users\\a\\.tinycloud' /grant \"${env:USERNAME}:(OI)(CI)F\" /T\n" +
        "Nothing was changed, so run the same command again once it's fixed.",
    );
    expect(commands(messageOf(unwritableStateFolder(errno("EACCES"), "C:\\Windows\\x", context)))).toBe(false);
    expect(commands(messageOf(unwritableStateFolder(errno("EACCES"), "C:\\Users\\a", context)))).toBe(false);
  });

  test("any other failure passes through unchanged", () => {
    const missing = errno("ENOENT");
    expect(unwritableStateFolder(missing, "/usr/share/x", posix("/usr"))).toBe(missing);
    expect(unwritableStateFolder("not an error", "/usr/share/x", posix("/usr"))).toBe("not an error");
  });
});
