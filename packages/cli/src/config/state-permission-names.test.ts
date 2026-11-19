import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { unwritableStateFolder, type StateFolderContext } from "./state-permission.js";

// TC-3278: the owner name comes from the passwd file, so a control character in it must not split the one-line
// error into two lines.
const skip = process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0);
const errno = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "");

describe("names in the folder-not-writable error", () => {
  test.skipIf(skip)("a control character in the owner name is replaced, so the error stays one line", () => {
    // /usr/share belongs to root, not to the test user; the home is /usr so that it counts as inside.
    const mode = (statSync("/usr/share").mode & 0o777).toString(8);
    const context: StateFolderContext = { home: "/usr", platform: "linux", uid: process.getuid?.(), ownerOf: () => "root\nforged line" };
    const message = messageOf(unwritableStateFolder(errno("EACCES"), "/usr/share/nothing-here", context));
    expect(message).toBe(`The TinyCloud CLI can't write to its folder /usr/share (EACCES): it belongs to another user (owner root?forged line, mode ${mode}). Nothing was changed.`);
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});
