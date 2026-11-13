import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The profile store reads TC_HOME when it loads, so import it afterwards.
const home = await mkdtemp(join(tmpdir(), "tc-profiles-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("./profiles.js");
const { PROFILES_DIR } = await import("./constants.js");
const { savePermissionRequestArtifacts } = await import("../lib/permissions.js");

beforeEach(async () => {
  await rm(join(home, ".tinycloud"), { recursive: true, force: true });
  await mkdir(PROFILES_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("ProfileManager.getProfile", () => {
  test("a missing profile is PROFILE_NOT_FOUND and names the init command for that profile", async () => {
    await expect(ProfileManager.getProfile("owner")).rejects.toMatchObject({
      code: "PROFILE_NOT_FOUND",
    });
  });
});

test("loading a legacy profile tightens its directory and files without following symlinks", async () => {
  const profileDir = join(PROFILES_DIR, "legacy");
  const lockDir = join(profileDir, ".lock");
  const outsideDir = join(home, "outside");
  await mkdir(lockDir, { recursive: true, mode: 0o755 });
  await mkdir(outsideDir, { mode: 0o755 });
  await writeFile(join(profileDir, "profile.json"), JSON.stringify({
    name: "legacy",
    host: "https://node.tinycloud.test",
    chainId: 1,
    spaceName: "default",
    did: "did:key:legacy",
    createdAt: "2026-10-01T00:00:00.000Z",
  }), { mode: 0o644 });
  for (const file of ["key.json", "config.json", ".atomic.tmp"]) {
    await writeFile(join(profileDir, file), "{}", { mode: 0o644 });
  }
  const outsideFile = join(outsideDir, "external.json");
  await writeFile(outsideFile, "{}", { mode: 0o644 });
  await symlink(outsideFile, join(profileDir, "external.json"));
  await chmod(profileDir, 0o755);

  expect((await ProfileManager.getProfile("legacy")).name).toBe("legacy");

  const paths = [
    profileDir,
    join(profileDir, "profile.json"),
    join(profileDir, "key.json"),
    join(profileDir, "config.json"),
    join(profileDir, ".atomic.tmp"),
  ];
  const modes = async () => Promise.all(paths.map(async (path) => (await stat(path)).mode & 0o777));
  expect(await modes()).toEqual([0o700, 0o600, 0o600, 0o600, 0o600]);
  expect((await stat(outsideFile)).mode & 0o777).toBe(0o644);
  await ProfileManager.getProfile("legacy");
  expect(await modes()).toEqual([0o700, 0o600, 0o600, 0o600, 0o600]);
});

test("profile reads and writes stay on the locked inode after a real-directory swap", async () => {
  const config = (name: string) => ({
    name, host: "https://node.tinycloud.test", did: `did:key:${name}`, chainId: 1,
    spaceName: "default", createdAt: "2026-10-01T00:00:00.000Z",
  });
  await ProfileManager.setProfile("selected", config("selected"));
  await ProfileManager.setProfile("victim", config("victim"));
  await ProfileManager.setKey("selected", { owner: "selected" });
  await ProfileManager.setKey("victim", { owner: "victim" });
  const selected = join(PROFILES_DIR, "selected");
  const moved = join(home, "selected-moved");
  await ProfileManager.withLock("selected", async () => {
    await rename(selected, moved);
    await rename(join(PROFILES_DIR, "victim"), selected);
    expect((await ProfileManager.getProfile("selected")).name).toBe("selected");
    expect(await ProfileManager.getKey("selected")).toEqual({ owner: "selected" });
    await ProfileManager.setKey("selected", { owner: "updated" });
  });
  expect(JSON.parse(await readFile(join(selected, "key.json"), "utf8"))).toEqual({ owner: "victim" });
  expect(JSON.parse(await readFile(join(moved, "key.json"), "utf8"))).toEqual({ owner: "updated" });
});

test("cache creation stays on the selected profile when its directory name is replaced", async () => {
  const config = (name: string) => ({
    name, host: "https://node.tinycloud.test", did: `did:key:${name}`, chainId: 1,
    spaceName: "default", createdAt: "2026-10-01T00:00:00.000Z",
  });
  await ProfileManager.setProfile("selected", config("selected"));
  await ProfileManager.setProfile("victim", config("victim"));
  const selected = join(PROFILES_DIR, "selected");
  const moved = join(home, "selected-cache-moved");
  const original = ProfileManager.ensureProfileDir;
  ProfileManager.ensureProfileDir = async function (name) {
    const directory = await original.call(this, name);
    if (name === "selected") {
      await rename(selected, moved);
      await rename(join(PROFILES_DIR, "victim"), selected);
    }
    return directory;
  };
  try {
    await ProfileManager.getCacheDir("selected");
  } finally {
    ProfileManager.ensureProfileDir = original;
  }
  expect((await stat(join(moved, "cache"))).isDirectory()).toBe(true);
  await expect(lstat(join(selected, "cache"))).rejects.toMatchObject({ code: "ENOENT" });
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

  // Every writer of profile state other than the settings themselves.
  for (const [store, write] of [
    ["session", () => ProfileManager.setSession("doomed", { delegationCid: "bafy-new" })],
    ["key", () => ProfileManager.setKey("doomed", { kty: "OKP", crv: "Ed25519", x: "new-public" })],
    ["permission request", () => savePermissionRequestArtifacts("doomed", [])],
  ] as const) {
    test(`a ${store} write that waited while the profile was deleted is refused and recreates nothing`, async () => {
      await ProfileManager.setProfile("doomed", { name: "doomed", host: "https://node.tinycloud.test", did: "did:key:zDoomed", chainId: 1, spaceName: "default", createdAt: "2026-10-01T00:00:00.000Z" });
      await ProfileManager.setSession("doomed", { delegationCid: "bafy-old" });
      const contended = join(home, `contended-${store.replace(" ", "-")}`);
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
        const writing = write();
        while (!await stat(contended).then(() => true, () => false)) { /* each stat yields to the writer */ }
        proceed.resolve();
        await deleting;

        await expect(writing).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND" });
        await expect(readdir(join(PROFILES_DIR, "doomed"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        delete process.env.TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH;
      }
    });
  }

  test("deleting a profile that does not exist creates no profile or lock state", async () => {
    await ProfileManager.deleteProfile("ghost");
    expect((await readdir(join(home, ".tinycloud"))).sort()).toEqual(["profiles"]);
    expect(await readdir(PROFILES_DIR)).toEqual([]);
  });
});
describe("ProfileManager.resolveContext replication flags", () => {
  test("resolves invocation flags over the environment and keeps defaults off", async () => {
    const previous = process.env.TC_REPLICATION;
    const previousDebug = process.env.TC_REPLICATION_DEBUG;
    try {
      delete process.env.TC_REPLICATION;
      delete process.env.TC_REPLICATION_DEBUG;
      expect((await ProfileManager.resolveContext({ host: "https://node.tinycloud.test" })).replication).toBe(false);
      process.env.TC_REPLICATION = "1";
      expect((await ProfileManager.resolveContext({ host: "https://node.tinycloud.test" })).replication).toBe(true);
      expect((await ProfileManager.resolveContext({ noReplication: true, host: "https://node.tinycloud.test" })).replication).toBe(false);
      expect((await ProfileManager.resolveContext({ replication: false, host: "https://node.tinycloud.test" })).replication).toBe(false);
      process.env.TC_REPLICATION = "false";
      expect((await ProfileManager.resolveContext({ replication: true, host: "https://node.tinycloud.test" })).replication).toBe(true);
      process.env.TC_REPLICATION_DEBUG = "1";
      expect((await ProfileManager.resolveContext({ host: "https://node.tinycloud.test" })).replicationDebug).toBe(true);
      process.env.TC_REPLICATION = "invalid";
      await expect(ProfileManager.resolveContext({ host: "https://node.tinycloud.test" }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT", exitCode: 2 });
    } finally {
      if (previous === undefined) delete process.env.TC_REPLICATION;
      else process.env.TC_REPLICATION = previous;
      if (previousDebug === undefined) delete process.env.TC_REPLICATION_DEBUG;
      else process.env.TC_REPLICATION_DEBUG = previousDebug;
    }
  });
});
describe("ProfileManager.resolveContext registry URL", () => {
  test("environment registry URL overrides the stored registry without replacing the profile host hint", async () => {
    const profileHost = "https://profile-host.test";
    const profileRegistry = "https://profile-registry.test";
    const envRegistry = "https://env-registry.test";
    const previousRegistry = process.env.TC_REGISTRY_URL;
    await ProfileManager.setProfile("registry-profile", {
      name: "registry-profile",
      host: profileHost,
      chainId: 1,
      spaceName: "default",
      did: "did:key:zregistry",
      createdAt: "2026-10-01T00:00:00.000Z",
      tinycloudRegistryUrl: profileRegistry,
    });

    try {
      delete process.env.TC_REGISTRY_URL;
      const fromProfile = await ProfileManager.resolveContext({
        profile: "registry-profile",
        host: profileHost,
      });
      expect(fromProfile).toMatchObject({
        host: profileHost,
        tinycloudRegistryUrl: profileRegistry,
      });

      process.env.TC_REGISTRY_URL = envRegistry;
      const fromEnvironment = await ProfileManager.resolveContext({
        profile: "registry-profile",
        host: profileHost,
      });
      expect(fromEnvironment).toMatchObject({
        host: profileHost,
        tinycloudRegistryUrl: envRegistry,
      });
    } finally {
      if (previousRegistry === undefined) delete process.env.TC_REGISTRY_URL;
      else process.env.TC_REGISTRY_URL = previousRegistry;
    }
  });
});
