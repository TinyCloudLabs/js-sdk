import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The profile store reads TC_HOME when it loads, so import it afterwards.
const home = await mkdtemp(join(tmpdir(), "tc-profiles-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("./profiles.js");
const { PROFILES_DIR } = await import("./constants.js");

beforeEach(async () => {
  await rm(join(home, ".tinycloud"), { recursive: true, force: true });
  await mkdir(PROFILES_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("ProfileManager.deleteProfile", () => {
  test("refuses a name that is not one path segment and removes nothing", async () => {
    await writeFile(join(home, ".tinycloud", "config.json"), JSON.stringify({ defaultProfile: "default", version: 1 }));
    for (const name of ["..", "../x", "a/b", "."]) {
      await expect(ProfileManager.deleteProfile(name)).rejects.toMatchObject({ code: "INVALID_PROFILE_NAME", exitCode: 2 });
    }
    expect((await readdir(join(home, ".tinycloud"))).sort()).toEqual(["config.json", "profiles"]);
  });

  test("unlinks a symlinked profile directory and leaves its target alone", async () => {
    const target = join(home, "elsewhere");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "profile.json"), JSON.stringify({ name: "linked" }));
    await symlink(target, join(PROFILES_DIR, "linked"));

    await ProfileManager.deleteProfile("linked");

    await expect(lstat(join(PROFILES_DIR, "linked"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(target)).toEqual(["profile.json"]);
  });
});
