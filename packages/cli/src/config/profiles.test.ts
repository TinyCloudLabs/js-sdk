import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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

  test("a session write that waited while the profile was deleted is refused and recreates nothing", async () => {
    await ProfileManager.setProfile("doomed", { name: "doomed", host: "https://node.tinycloud.test", did: "did:key:zDoomed", chainId: 1, spaceName: "default", createdAt: "2026-10-01T00:00:00.000Z" });
    await ProfileManager.setSession("doomed", { delegationCid: "bafy-old" });
    const contended = join(home, "contended");
    process.env.NODE_ENV = "test";
    process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH = contended;
    try {
      const entered = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      // The lock is held, and the deletion then runs in that critical section,
      // so the write below is waiting before the deletion starts.
      const deleting = ProfileManager.withLock("doomed", async () => {
        entered.resolve();
        await proceed.promise;
        await ProfileManager.deleteProfile("doomed");
      });
      await entered.promise;
      const writing = ProfileManager.setSession("doomed", { delegationCid: "bafy-new" });
      while (!await stat(contended).then(() => true, () => false)) { /* each stat yields to the writer */ }
      proceed.resolve();
      await deleting;

      await expect(writing).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND" });
      await expect(readdir(join(PROFILES_DIR, "doomed"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
    }
  });
});
