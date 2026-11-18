import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwritableStateFolder, type StateFolderContext } from "./state-permission.js";

// TC-3278: the user and owner names come from the environment and the passwd file, so a control character in
// either must not split the one-line error into two lines.
const skip = process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0);
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});
const errno = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "");

describe("names in the folder-not-writable error", () => {
  test.skipIf(skip)("a control character in the user name is replaced, so the error stays one line", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "tc-state-name-")));
    made.push(home);
    chmodSync(home, 0o555);
    const context: StateFolderContext = { home, platform: "linux", uid: process.getuid?.(), user: "tc\nSTATE_FIXED run it\u001b[31m" };
    const message = messageOf(unwritableStateFolder(errno("EACCES"), join(home, ".tinycloud"), context));
    expect(message).toBe(`The TinyCloud CLI can't write to its folder ${home} (EACCES): it's read-only for tc?STATE_FIXED run it?[31m (mode 555), or the disk is read-only. Nothing was changed.`);
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  test.skipIf(skip)("a control character in the owner name is replaced, so the error stays one line", () => {
    // /usr/share belongs to root, not to the test user; the home is /usr so that it counts as inside.
    const mode = (statSync("/usr/share").mode & 0o777).toString(8);
    const context: StateFolderContext = { home: "/usr", platform: "linux", uid: process.getuid?.(), user: "tc", ownerOf: () => "root\nforged line" };
    const message = messageOf(unwritableStateFolder(errno("EACCES"), "/usr/share/nothing-here", context));
    expect(message).toBe(`The TinyCloud CLI can't write to its folder /usr/share (EACCES): it belongs to another user (owner root?forged line, mode ${mode}). Nothing was changed.`);
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});
