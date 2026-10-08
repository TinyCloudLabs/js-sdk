import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { link, lstat, mkdtemp, open, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validatePrivateOutput, writePrivateOutput } from "./private-output.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tc-private-output-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("private output files", () => {
  test("writes owner-only files and replaces existing hard links atomically", async () => {
    const path = join(dir, "secret");
    const oldLink = join(dir, "old-link");
    const original = await open(path, "wx", 0o644);
    await original.writeFile("old");
    await original.close();
    await link(path, oldLink);

    await writePrivateOutput(path, "sensitive");

    expect(await Bun.file(path).text()).toBe("sensitive");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(oldLink).text()).toBe("old");
    expect((await lstat(path)).ino).not.toBe((await lstat(oldLink)).ino);
  });

  test("refuses symlinks and invalid parents without changing their targets", async () => {
    const target = join(dir, "target");
    const shortcut = join(dir, "shortcut");
    const original = await open(target, "wx");
    await original.writeFile("unchanged");
    await original.close();
    await symlink(target, shortcut);

    await expect(validatePrivateOutput(shortcut)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(writePrivateOutput(join(dir, "missing", "secret"), "never-written")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await Bun.file(target).text()).toBe("unchanged");
  });
});
